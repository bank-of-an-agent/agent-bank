import {
  assertTestnet,
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  ownerPayloads,
  parseAmount,
  SessionScopeSchema,
} from "@agentbank/core";
import { routes, type RequestOf, type RouteDef } from "@agentbank/core/api";
import type { z } from "zod";
import { AgentBankClient, type ClientOptions, type RequestOptions } from "./client";
import { AgentBankError, InvalidRequestError, PermissionDeniedError } from "./errors";
import { readOptions, writeOptions } from "./internal/options";
import { pollUntil, type WaitOptions } from "./internal/poll";
import { formatIssues, summarizeIssues } from "./internal/zod";
import { ownerAuthorize, type OwnerAuthorizeInput } from "./owner";
import { PrincipalProofs } from "./proofs/principal";
import { signOperationHash, type OwnerSigner, type SpendSigner } from "./signers";
import { signSpendKeyPermit, type SpendKeyPermitOptions } from "./spend-key";
import { earlyWithdrawalTypedData } from "./vaults";
import type {
  Account,
  Agent,
  AgentPolicy,
  AutoTopUpRule,
  CreateAccountInput,
  CreateMandateInput,
  Mandate,
  Meta,
  Money,
  Org,
  OwnerAuthorization,
  OwnerOperation,
  PolicyDocumentInput,
  Session,
  SessionScope,
  SpendKeyPermit,
  SweepRule,
  Vault,
} from "./types";

/** Options of {@link PrincipalClient}. */
export interface PrincipalClientOptions extends Omit<ClientOptions, "session"> {
  /** Org API key (`abk_test_…`). */
  apiKey: string;
  /**
   * The principal's owner key, used for owner authorizations and owner
   * operations. Optional: without it, the helpers that need it throw.
   */
  owner?: OwnerSigner;
  /**
   * EIP-712 domain chain id for owner authorizations. Leave unset: the client
   * then fetches `owner_authorization_chain_id` from `GET /v1/meta` once and
   * caches it (84532 on Base Sepolia; sandboxes may run on the simulated
   * chain 1337 or Anvil 31337). Set it only to sign without reaching the API.
   */
  chainId?: number;
}

/** Session scope as written by callers; `expires_at` defaults from `ttlSeconds`. */
export interface SessionScopeRequest {
  /** Decimal USDC per transaction, enforced on-chain. */
  max_per_tx: string;
  /** Decimal USDC per day, enforced on-chain. */
  max_per_day: string;
  allowed_recipients?: string[];
  allowed_contracts?: string[];
  asset?: "USDC";
  /** ISO 8601 expiry; default now + `ttlSeconds`. */
  expires_at?: string;
}

/** Input of {@link PrincipalClient.grantSession}. */
export interface GrantSessionInput {
  /** The agent's account (`acct_…`). */
  accountId: string;
  /** Session key address generated on the agent's side (`generateSessionKey().address`). */
  publicKey: string;
  scope: SessionScopeRequest;
  /** Session lifetime when `scope.expires_at` is absent (default 24 h, max 7 days). */
  ttlSeconds?: number;
  /** Prepare and sign the on-chain install (default `true`). */
  install?: boolean;
  /** Wait until the install operation has succeeded (default `false`). */
  waitForInstall?: boolean | WaitOptions;
  /** Override the client's owner signer. */
  owner?: OwnerSigner;
}

/** Input of {@link PrincipalClient.setupAgentAccount}. */
export interface SetupAgentAccountInput {
  /** The agent (`agt_…`) to create the smart account for. */
  agentId: string;
  /** Chain of the account (default: the API's default, Base Sepolia). */
  chain?: CreateAccountInput["chain"];
  /**
   * The agent's x402 spend key (e.g. `generateSpendKey().account`). When
   * given, its float-recovery permit is signed and attached before the
   * first session is installed, so the setup operation executes it.
   */
  spendKey?: SpendSigner;
  /** Permit overrides (`nonce` for a key that is not fresh). */
  spendKeyPermit?: SpendKeyPermitOptions;
  /** Override the client's owner signer (signs `spend_key.set` and the session grant). */
  owner?: OwnerSigner;
  /** The first session to grant (and install) once the account is ready. */
  session?: Omit<GrantSessionInput, "accountId">;
}

/** Result of {@link PrincipalClient.setupAgentAccount}. */
export interface SetupAgentAccountResult {
  /** The account, as returned by the last step (spend key attached if requested). */
  account: Account;
  /** The granted session, if one was requested. */
  session: Session | undefined;
  /** The signed install (setup) owner operation, if a session was installed. */
  installOperation: OwnerOperation | undefined;
}

/** Result of {@link PrincipalClient.grantSession}. */
export interface GrantSessionResult {
  session: Session;
  /** The signed install operation (absent with `install: false`). */
  installOperation: OwnerOperation | undefined;
}

const OWNER_OP_DONE: ReadonlySet<OwnerOperation["status"]> = new Set(["succeeded", "failed", "expired"]);

/**
 * High-level client for a **principal** (the human or company that owns
 * agents): API-key authentication plus the owner-key flows.
 *
 * The owner key never leaves the principal: it signs EIP-712 owner
 * authorizations and owner operations locally; Agent Bank only ever sees
 * signatures. Nothing here can be called by an agent.
 *
 * @example
 * ```ts
 * const principal = new PrincipalClient({ baseUrl, apiKey, owner: privateKeyToAccount(ownerKey) });
 * const sessionKey = generateSessionKey();
 * const { session } = await principal.grantSession({
 *   accountId,
 *   publicKey: sessionKey.address,
 *   scope: { max_per_tx: "25.00", max_per_day: "200.00" },
 * });
 * ```
 */
export class PrincipalClient extends AgentBankClient {
  /**
   * Private proofs: the Proofs operations plus `settings(agentId)`, `configure(agentId, …)`
   * (owner-signed when it widens disclosure), `reservations(accountId)` and
   * `releaseReservation(id)` (owner-signed).
   */
  declare readonly proofs: PrincipalProofs;
  readonly #owner: OwnerSigner | undefined;
  readonly #chainIdOverride: number | undefined;
  #meta: Promise<Meta> | undefined;

  constructor(options: PrincipalClientOptions) {
    super(options);
    if (!options.apiKey) throw new InvalidRequestError("invalid_request", "apiKey is required");
    this.#owner = options.owner;
    this.#chainIdOverride = options.chainId;
    if (options.chainId !== undefined) assertTestnet(options.chainId);
    this.proofs = new PrincipalProofs(this, (input, owner) => this.authorize(input, owner));
  }

  /**
   * The EIP-712 domain chain id for owner authorizations: the `chainId`
   * option if set, otherwise `owner_authorization_chain_id` from
   * `GET /v1/meta`, fetched once and cached (a failed fetch is retried on
   * the next call). Mainnet chain ids are refused.
   */
  async ownerAuthorizationChainId(options: RequestOptions = {}): Promise<number> {
    if (this.#chainIdOverride !== undefined) return this.#chainIdOverride;
    const chainId = (await this.#deployment(options)).owner_authorization_chain_id;
    assertTestnet(chainId);
    return chainId;
  }

  /** `GET /v1/meta`, fetched once and cached; a failed fetch is retried on the next call. */
  async #deployment(options: RequestOptions = {}): Promise<Meta> {
    this.#meta ??= this.meta(readOptions(options));
    try {
      return await this.#meta;
    } catch (error) {
      this.#meta = undefined;
      throw error;
    }
  }

  /** The owner key address, if an owner signer is configured. */
  get ownerAddress(): string | undefined {
    return this.#owner?.address;
  }

  #requireOwner(override?: OwnerSigner): OwnerSigner {
    const owner = override ?? this.#owner;
    if (!owner) {
      throw new InvalidRequestError(
        "invalid_request",
        "This operation needs the owner key: pass `owner` to PrincipalClient",
      );
    }
    return owner;
  }

  /**
   * Sign an owner authorization with the configured owner key (see
   * {@link ownerAuthorize}); the chain id defaults to
   * {@link ownerAuthorizationChainId}.
   */
  async authorize(
    input: Omit<OwnerAuthorizeInput, "chainId"> & { chainId?: number },
    owner?: OwnerSigner,
  ): Promise<OwnerAuthorization> {
    const signer = this.#requireOwner(owner);
    const chainId = input.chainId ?? (await this.ownerAuthorizationChainId());
    return ownerAuthorize(signer, { ...input, chainId });
  }

  /**
   * Sign and submit an owner operation (`user_op_hash`, EIP-191 over the raw
   * 32 bytes). Operations that no longer need a signature are returned as-is.
   */
  async signOwnerOperation(
    operation: OwnerOperation | string,
    options: RequestOptions & { owner?: OwnerSigner; wait?: boolean | WaitOptions } = {},
  ): Promise<OwnerOperation> {
    const owner = this.#requireOwner(options.owner);
    let op =
      typeof operation === "string"
        ? await this.ownerOperations.retrieve(operation, readOptions(options))
        : operation;
    if (op.status === "requires_signature") {
      assertTestnet(op.chain_id);
      const signature = await signOperationHash(owner, op.user_op_hash);
      op = await this.ownerOperations.submitSignature(
        op.id,
        { signature },
        {
          ...readOptions(options),
          idempotencyKey: options.idempotencyKey ?? `oop_sig_${op.id}_${op.user_op_hash.slice(2, 18)}`,
        },
      );
    }
    if (options.wait && !OWNER_OP_DONE.has(op.status)) {
      const waitOptions = typeof options.wait === "object" ? options.wait : {};
      const id = op.id;
      op = await pollUntil(
        () => this.ownerOperations.retrieve(id, readOptions(options)),
        (o) => OWNER_OP_DONE.has(o.status),
        waitOptions,
      );
    }
    return op;
  }

  /**
   * Grant an agent a session key: sign the `session.grant` owner
   * authorization over `{account_id, public_key, scope}`, register the
   * session, prepare its on-chain install (Smart Sessions) and sign the
   * install operation with the owner key.
   *
   * The scope (per-transaction and daily caps, allowed recipients and
   * contracts, expiry) is enforced on-chain, so it holds even if Agent
   * Bank's off-chain systems were compromised.
   */
  async grantSession(input: GrantSessionInput, options: RequestOptions = {}): Promise<GrantSessionResult> {
    const owner = this.#requireOwner(input.owner);
    const ttl = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_SESSION_TTL_SECONDS) {
      throw new InvalidRequestError(
        "invalid_request",
        `ttlSeconds must be between 1 and ${MAX_SESSION_TTL_SECONDS}`,
      );
    }
    const body = canonicalBody("createSession", {
      account_id: input.accountId,
      public_key: input.publicKey,
      scope: normalizeScope(input.scope, ttl),
    });
    const owner_authorization = await this.authorize(ownerPayloads.sessionGrant(body), owner);
    let session = await this.sessions.create(
      { ...body, owner_authorization },
      writeOptions(options, "create"),
    );
    if (input.install === false) return { session, installOperation: undefined };

    session = await this.sessions.install(session.id, writeOptions(options, "install"));
    if (!session.install_operation_id) {
      return { session, installOperation: undefined };
    }
    const wait = input.waitForInstall;
    const installOperation = await this.signOwnerOperation(session.install_operation_id, {
      ...writeOptions(options, "sign"),
      owner,
      ...(wait ? { wait } : {}),
    });
    if (wait) session = await this.sessions.retrieve(session.id, readOptions(options));
    return { session, installOperation };
  }

  /**
   * Sign the spend key's float-recovery permit (EIP-2612 on USDC, ADR 0001)
   * for an existing account: spender = `account.address`, USDC address and
   * EIP-712 domain from `GET /v1/meta`. Does not send anything.
   */
  async spendKeyPermit(
    account: Account | string,
    spendKey: SpendSigner,
    options: SpendKeyPermitOptions & RequestOptions = {},
  ): Promise<SpendKeyPermit> {
    const target =
      typeof account === "string" ? await this.accounts.retrieve(account, readOptions(options)) : account;
    const meta = await this.#deployment(options);
    if (target.chain_id !== meta.chain_id) {
      throw new InvalidRequestError(
        "invalid_request",
        `Account ${target.id} is on chain ${target.chain_id}, but this deployment's USDC is on chain ${meta.chain_id}`,
      );
    }
    return signSpendKeyPermit({
      spendKey,
      account: target.address,
      chainId: target.chain_id,
      usdc: meta.usdc.address,
      name: meta.usdc.eip712_name,
      version: meta.usdc.eip712_version,
      ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    });
  }

  /**
   * Attach the agent's x402 spend key to its account (ADR 0001): the spend
   * key signs the float-recovery permit for the account's address, the owner
   * key signs the `spend_key.set` authorization (which pins the spend key in
   * the co-signer; x402 payments and float refills are refused until then),
   * and both go to `PUT /v1/accounts/{id}/spend-key`. The permit is executed
   * on-chain by the account's next owner operation (normally the install of
   * the first session), after which `account.spend_key_permit` is `executed`.
   *
   * The permit nonce defaults to 0 (a fresh key); pass `nonce` (USDC
   * `nonces(spendKey)`) for a key that has signed permits before.
   */
  async provisionSpendKey(
    accountId: string,
    spendKey: SpendSigner,
    options: SpendKeyPermitOptions & RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<Account> {
    this.#requireOwner(options.owner);
    const account = await this.accounts.retrieve(accountId, readOptions(options));
    return this.#attachSpendKey(account, spendKey, options, writeOptions(options));
  }

  /** Sign the permit and the `spend_key.set` owner authorization, then attach both. */
  async #attachSpendKey(
    account: Account,
    spendKey: SpendSigner,
    options: SpendKeyPermitOptions & RequestOptions & { owner?: OwnerSigner },
    write: RequestOptions,
  ): Promise<Account> {
    if (account.role !== "agent") {
      throw new InvalidRequestError("invalid_request", "Spend keys are for agent accounts, not the treasury");
    }
    const permit = await this.spendKeyPermit(account, spendKey, {
      ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      ...readOptions(options),
    });
    const body = canonicalBody("attachSpendKey", { spend_key_address: spendKey.address, permit });
    const owner_authorization = await this.authorize(
      ownerPayloads.spendKeySet(account.id, body.spend_key_address),
      options.owner,
    );
    return this.accounts.attachSpendKey(account.id, { ...body, owner_authorization }, write);
  }

  /**
   * Provision an agent's account in the order the contracts require:
   * create the smart account → (with `spendKey`) sign the float-recovery
   * permit for its counterfactual address, have the owner authorize the
   * spend key (`spend_key.set`) and attach both → (with
   * `session`) grant and install the first session, whose setup owner
   * operation also executes the permit on-chain.
   *
   * A caller-supplied idempotency key is suffixed per step (`.account`,
   * `.spend-key`, `.session.*`), so the whole setup can be retried safely.
   */
  async setupAgentAccount(
    input: SetupAgentAccountInput,
    options: RequestOptions = {},
  ): Promise<SetupAgentAccountResult> {
    if (input.spendKey) this.#requireOwner(input.owner);
    if (input.session) this.#requireOwner(input.session.owner ?? input.owner);
    let account = await this.accounts.create(
      input.agentId,
      input.chain ? { chain: input.chain } : {},
      writeOptions(options, "account"),
    );
    if (input.spendKey) {
      account = await this.#attachSpendKey(
        account,
        input.spendKey,
        { ...input.spendKeyPermit, ...readOptions(options), ...(input.owner ? { owner: input.owner } : {}) },
        writeOptions(options, "spend-key"),
      );
    }
    if (!input.session) return { account, session: undefined, installOperation: undefined };
    const sessionOwner = input.session.owner ?? input.owner;
    const granted = await this.grantSession(
      { ...input.session, accountId: account.id, ...(sessionOwner ? { owner: sessionOwner } : {}) },
      writeOptions(options, "session"),
    );
    if (input.spendKey && input.session.waitForInstall) {
      account = await this.accounts.retrieve(account.id, readOptions(options));
    }
    return { account, session: granted.session, installOperation: granted.installOperation };
  }

  /**
   * Prepare the owner operation that swaps the owner of one account to
   * `newOwnerAddress` (the Safe owner and the OwnableValidator owner, in one
   * operation) and sign it with the **current** owner key. When it succeeds
   * the API updates the account's owner. Do this for every account, then
   * call {@link rotateOwner}.
   */
  async prepareOwnerSwap(
    accountId: string,
    newOwnerAddress: string,
    options: RequestOptions & { owner?: OwnerSigner; wait?: boolean | WaitOptions } = {},
  ): Promise<OwnerOperation> {
    const operation = await this.ownerOperations.prepareOwnerSwap(
      accountId,
      { new_owner_address: newOwnerAddress },
      writeOptions(options, "prepare"),
    );
    return this.signOwnerOperation(operation, { ...writeOptions(options, "sign"), ...ownerOptions(options) });
  }

  /**
   * Rotate the org's owner key in Agent Bank and the co-signer (owner
   * authorization `owner.rotate`, signed by the **current** owner key).
   * Order matters: first swap the owner of every account with
   * {@link prepareOwnerSwap} (signed with the old key), then call this. Lost
   * keys are recovered on-chain with guardians instead.
   */
  async rotateOwner(
    newOwnerAddress: string,
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<Org> {
    const body = canonicalBody("rotateOwner", { new_owner_address: newOwnerAddress });
    const org = await this.orgs.retrieve(readOptions(options));
    const owner_authorization = await this.authorize(
      ownerPayloads.ownerRotate(org.id, body.new_owner_address),
      options.owner,
    );
    return this.orgs.rotateOwner({ ...body, owner_authorization }, writeOptions(options));
  }

  /**
   * Replace an agent's policy. The document is normalized with the policy
   * schema (defaults made explicit) and, when an owner key is configured,
   * signed as `policy.loosen`: tightening applies immediately, loosening
   * after the 1-hour delay. Pass `authorize: false` to send it unsigned
   * (tightening only).
   */
  async setPolicy(
    agentId: string,
    policy: PolicyDocumentInput,
    options: RequestOptions & { authorize?: boolean; owner?: OwnerSigner } = {},
  ): Promise<AgentPolicy> {
    const body = canonicalBody("putPolicy", { policy });
    const authorize = options.authorize ?? (options.owner ?? this.#owner) !== undefined;
    const owner_authorization = authorize
      ? await this.authorize(ownerPayloads.policyLoosen(agentId, body.policy), options.owner)
      : undefined;
    return this.policies.put(
      agentId,
      { ...body, ...(owner_authorization ? { owner_authorization } : {}) },
      writeOptions(options),
    );
  }

  /** Grant authority with an AP2 open payment mandate, signed by the owner (`mandate.issue`). */
  async issueMandate(
    agentId: string,
    mandate: CreateMandateInput["mandate"],
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<Mandate> {
    const body = canonicalBody("createMandate", { agent_id: agentId, mandate });
    const owner_authorization = await this.authorize(
      ownerPayloads.mandateIssue(agentId, body.mandate),
      options.owner,
    );
    return this.mandates.create({ ...body, owner_authorization }, writeOptions(options));
  }

  /** Unfreeze an agent (owner authorization `agent.unfreeze`; effective after the 1-hour delay). */
  async unfreezeAgent(
    agentId: string,
    reason: string,
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<Agent> {
    const body = canonicalBody("unfreezeAgent", { reason });
    const owner_authorization = await this.authorize(
      ownerPayloads.agentUnfreeze(agentId, body.reason),
      options.owner,
    );
    return this.agents.unfreeze(agentId, { ...body, owner_authorization }, writeOptions(options));
  }

  /** Unfreeze the whole org (owner authorization `org.unfreeze`; effective after the 1-hour delay). */
  async unfreezeOrg(reason: string, options: RequestOptions & { owner?: OwnerSigner } = {}): Promise<Org> {
    const body = canonicalBody("unfreezeOrg", { reason });
    const org = await this.orgs.retrieve(readOptions(options));
    const owner_authorization = await this.authorize(
      ownerPayloads.orgUnfreeze(org.id, body.reason),
      options.owner,
    );
    return this.orgs.unfreeze({ ...body, owner_authorization }, writeOptions(options));
  }

  /** Set the org treasury account (owner authorization `treasury.set`). */
  async setTreasury(accountId: string, options: RequestOptions & { owner?: OwnerSigner } = {}): Promise<Org> {
    const body = canonicalBody("setTreasury", { account_id: accountId });
    const org = await this.orgs.retrieve(readOptions(options));
    const owner_authorization = await this.authorize(
      ownerPayloads.treasurySet(org.id, body.account_id),
      options.owner,
    );
    return this.orgs.setTreasury({ ...body, owner_authorization }, writeOptions(options));
  }

  /**
   * Refill an agent from the treasury on rules (owner authorization
   * `topup.set`), and sign the owner operation that installs the top-up
   * executor when the API returns one (`pending_install`).
   */
  async setAutoTopUp(
    agentId: string,
    rule: { refill_to: Money; when_below: Money; max_per_day: Money },
    options: OwnerFlowOptions = {},
  ): Promise<AutoTopUpRule> {
    const body = canonicalBody("putAutoTopUp", rule);
    const owner_authorization = await this.authorize(ownerPayloads.topUpSet(agentId, body), options.owner);
    const result = await this.treasury.putAutoTopUp(
      agentId,
      { ...body, owner_authorization },
      writeOptions(options, "rule"),
    );
    if (result.status !== "pending_install" || !result.install_operation_id) return result;
    await this.#signFollowUp(result.install_operation_id, options, { purpose: "topup.configure" });
    return options.waitForInstall
      ? ((await this.treasury.getAutoTopUp(agentId, readOptions(options))) ?? result)
      : result;
  }

  /**
   * Configure the treasury sweep for an account (owner authorization
   * `sweep.set`; counsel-gated feature), signing the executor install
   * operation when the API returns one.
   */
  async setSweepRule(
    accountId: string,
    rule: { fund_id: string; threshold: Money; max_share_bps: number; floor?: Money },
    options: OwnerFlowOptions = {},
  ): Promise<SweepRule> {
    const body = canonicalBody("putSweepRule", rule);
    const owner_authorization = await this.authorize(ownerPayloads.sweepSet(accountId, body), options.owner);
    const result = await this.treasury.putSweepRule(
      accountId,
      { ...body, owner_authorization },
      writeOptions(options, "rule"),
    );
    if (result.status !== "pending_install" || !result.install_operation_id) return result;
    await this.#signFollowUp(result.install_operation_id, options, { purpose: "sweep.configure" });
    return options.waitForInstall
      ? ((await this.treasury.getSweepRule(accountId, readOptions(options))) ?? result)
      : result;
  }

  /**
   * Withdraw from a vault back to its account.
   *
   * - **Goal vaults** and **locked vaults past their unlock date**: one
   *   request, no signature.
   * - **Early withdrawal from a locked vault**: the API answers
   *   `owner_signature_required` with the TimeLockVaults EIP-712
   *   `EarlyWithdrawal` to sign. The SDK checks it (contract = the
   *   deployment's `vaults` and the vault's `contract_address`, chain from
   *   `GET /v1/meta`, vault id and amount as requested, deadline within an
   *   hour), signs its own copy with the owner key, retries with
   *   `owner_authorization` (`expires_at` = the deadline), and signs the
   *   resulting `vault.withdraw` owner operation. The generic `vault.withdraw`
   *   OwnerAuthorization (`ownerPayloads.vaultWithdraw`) is not used here.
   *
   * @throws {@link PermissionDeniedError} (`forbidden`) if the challenge
   *   does not match the request; nothing is signed then.
   */
  async withdrawVault(vaultId: string, amount: Money, options: OwnerFlowOptions = {}): Promise<Vault> {
    const body = canonicalBody("withdrawVault", { amount });
    try {
      return await this.vaults.withdraw(vaultId, body, writeOptions(options, "withdraw"));
    } catch (error) {
      const challenge = error instanceof AgentBankError ? error.extensions.typed_data : undefined;
      if (!(error instanceof AgentBankError) || error.code !== "owner_signature_required" || !challenge) {
        throw error;
      }
      const owner = this.#requireOwner(options.owner);
      const [vault, meta] = await Promise.all([
        this.vaults.retrieve(vaultId, readOptions(options)),
        this.#deployment(options),
      ]);
      const typedData = earlyWithdrawalTypedData(challenge, {
        meta,
        vault,
        amountMinor: parseAmount(body.amount.amount, 6),
      });
      const signature = await owner.signTypedData(typedData);
      // The body changes, so the signed retry gets its own idempotency key.
      const pending = await this.vaults.withdraw(
        vaultId,
        {
          ...body,
          owner_authorization: {
            signer: owner.address,
            signature,
            issued_at: Math.floor(Date.now() / 1000),
            expires_at: Number(typedData.message.deadline),
          },
        },
        writeOptions(options, "withdraw-signed"),
      );
      if (!pending.pending_operation_id) return pending;
      await this.#signFollowUp(pending.pending_operation_id, options, {
        purpose: "vault.withdraw",
        subjectId: vaultId,
      });
      return options.waitForInstall ? this.vaults.retrieve(vaultId, readOptions(options)) : pending;
    }
  }

  /**
   * Revoke a session: off-chain at once (the co-signer refuses it), and, when
   * the API prepares one, sign the on-chain revoke owner operation (the hard
   * backstop). Pass `onchain: false` to skip the on-chain step.
   */
  async revokeSession(
    sessionId: string,
    options: OwnerFlowOptions & { onchain?: boolean } = {},
  ): Promise<Session> {
    const session = await this.sessions.revoke(sessionId, readOptions(options));
    if (options.onchain === false || !session.revoke_operation_id) return session;
    await this.#signFollowUp(session.revoke_operation_id, options, {
      purpose: "session.revoke",
      subjectId: sessionId,
    });
    return options.waitForInstall ? this.sessions.retrieve(sessionId, readOptions(options)) : session;
  }

  /**
   * Sign the owner operation a helper's request produced (install, withdrawal,
   * revocation), after checking it is the kind of operation that request
   * prepares, so an unrelated pending operation is never signed by accident.
   */
  async #signFollowUp(
    operationId: string,
    options: OwnerFlowOptions,
    expected: { purpose: OwnerOperation["purpose"]; subjectId?: string },
  ): Promise<OwnerOperation> {
    const operation = await this.ownerOperations.retrieve(operationId, readOptions(options));
    if (
      operation.purpose !== expected.purpose ||
      (expected.subjectId !== undefined && operation.subject_id !== expected.subjectId)
    ) {
      throw new PermissionDeniedError(
        "forbidden",
        `Refusing to sign owner operation ${operation.id}: expected ${expected.purpose}, got ${operation.purpose}`,
      );
    }
    const wait = options.waitForInstall;
    return this.signOwnerOperation(operation, {
      ...writeOptions(options, "sign"),
      ...(options.owner ? { owner: options.owner } : {}),
      ...(wait ? { wait } : {}),
    });
  }
}

/**
 * Options of the owner-signed helpers that may produce an owner operation
 * (installing an executor, withdrawing early, revoking on-chain): the
 * operation is signed with the owner key right away.
 */
export interface OwnerFlowOptions extends RequestOptions {
  /** Override the client's owner signer. */
  owner?: OwnerSigner;
  /** Also wait until the resulting owner operation has succeeded (default `false`). */
  waitForInstall?: boolean | WaitOptions;
}

/** The owner-related options of a helper's options bag. */
function ownerOptions(options: { owner?: OwnerSigner; wait?: boolean | WaitOptions }): {
  owner?: OwnerSigner;
  wait?: boolean | WaitOptions;
} {
  return {
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  };
}

/** Operations whose body carries an `owner_authorization`. */
type OwnerAuthorizedOperation =
  | "attachSpendKey"
  | "rotateOwner"
  | "createSession"
  | "putPolicy"
  | "createMandate"
  | "unfreezeAgent"
  | "unfreezeOrg"
  | "setTreasury"
  | "putAutoTopUp"
  | "putSweepRule"
  | "withdrawVault";

/** A request body without `owner_authorization`, as the API parses it (defaults applied). */
type CanonicalBody<K extends OwnerAuthorizedOperation> = Omit<
  NonNullable<RequestOf<K>["body"]>,
  "owner_authorization"
>;

/**
 * Parse a body (without `owner_authorization`) with the route's own schema,
 * so defaults are applied and unknown fields dropped exactly as the API
 * does: the owner signs, and the SDK sends, the canonical body
 * (`@agentbank/core` owner-action conventions).
 */
function canonicalBody<K extends OwnerAuthorizedOperation>(operationId: K, body: unknown): CanonicalBody<K> {
  const schema = (routes as Record<string, RouteDef>)[operationId]?.body as
    (z.ZodType & { omit(mask: Record<string, true>): z.ZodType }) | undefined;
  if (!schema || typeof schema.omit !== "function") {
    throw new InvalidRequestError("invalid_request", `${operationId} has no object body`);
  }
  const parsed = schema.omit({ owner_authorization: true }).safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError(
      "invalid_request",
      `Invalid ${operationId} request: ${formatIssues(summarizeIssues(parsed.error))}`,
    );
  }
  return parsed.data as CanonicalBody<K>;
}

/** Make every scope default explicit so the signed payload equals what the API parses. */
function normalizeScope(scope: SessionScopeRequest, ttlSeconds: number): SessionScope {
  const candidate = {
    asset: scope.asset ?? "USDC",
    max_per_tx: scope.max_per_tx,
    max_per_day: scope.max_per_day,
    ...(scope.allowed_recipients ? { allowed_recipients: scope.allowed_recipients } : {}),
    ...(scope.allowed_contracts ? { allowed_contracts: scope.allowed_contracts } : {}),
    expires_at: scope.expires_at ?? new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
  const parsed = SessionScopeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidRequestError(
      "invalid_request",
      `Invalid session scope: ${formatIssues(summarizeIssues(parsed.error))}`,
    );
  }
  const expiresAt = Date.parse(parsed.data.expires_at);
  if (expiresAt <= Date.now() || expiresAt > Date.now() + MAX_SESSION_TTL_SECONDS * 1000 + 60_000) {
    throw new InvalidRequestError(
      "invalid_request",
      "Session expiry must be in the future and at most 7 days away",
    );
  }
  return parsed.data;
}
