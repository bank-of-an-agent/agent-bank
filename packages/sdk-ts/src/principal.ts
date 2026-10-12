import {
  assertTestnet,
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  ownerPayloads,
  SessionScopeSchema,
} from "@agentbank/core";
import { routes, type RequestOf, type RouteDef } from "@agentbank/core/api";
import type { z } from "zod";
import { AgentBankClient, type ClientOptions, type RequestOptions } from "./client";
import { InvalidRequestError } from "./errors";
import { pollUntil, type WaitOptions } from "./internal/poll";
import { formatIssues, summarizeIssues } from "./internal/zod";
import { ownerAuthorize, type OwnerAuthorizeInput } from "./owner";
import { signOperationHash, type OwnerSigner } from "./signers";
import type {
  Agent,
  AgentPolicy,
  AutoTopUpRule,
  CreateMandateInput,
  Mandate,
  Money,
  Org,
  OwnerAuthorization,
  OwnerOperation,
  PolicyDocumentInput,
  Session,
  SessionScope,
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
  readonly #owner: OwnerSigner | undefined;
  readonly #chainIdOverride: number | undefined;
  #chainId: Promise<number> | undefined;

  constructor(options: PrincipalClientOptions) {
    super(options);
    if (!options.apiKey) throw new InvalidRequestError("invalid_request", "apiKey is required");
    this.#owner = options.owner;
    this.#chainIdOverride = options.chainId;
    if (options.chainId !== undefined) assertTestnet(options.chainId);
  }

  /**
   * The EIP-712 domain chain id for owner authorizations: the `chainId`
   * option if set, otherwise `owner_authorization_chain_id` from
   * `GET /v1/meta`, fetched once and cached (a failed fetch is retried on
   * the next call). Mainnet chain ids are refused.
   */
  async ownerAuthorizationChainId(options: RequestOptions = {}): Promise<number> {
    if (this.#chainIdOverride !== undefined) return this.#chainIdOverride;
    this.#chainId ??= this.meta(readOptions(options)).then((meta) => {
      assertTestnet(meta.owner_authorization_chain_id);
      return meta.owner_authorization_chain_id;
    });
    try {
      return await this.#chainId;
    } catch (error) {
      this.#chainId = undefined;
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

  /** Refill an agent from the treasury on rules (owner authorization `topup.set`). */
  async setAutoTopUp(
    agentId: string,
    rule: { refill_to: Money; when_below: Money; max_per_day: Money },
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<AutoTopUpRule> {
    const body = canonicalBody("putAutoTopUp", rule);
    const owner_authorization = await this.authorize(ownerPayloads.topUpSet(agentId, body), options.owner);
    return this.treasury.putAutoTopUp(agentId, { ...body, owner_authorization }, writeOptions(options));
  }

  /** Configure the treasury sweep for an account (owner authorization `sweep.set`; counsel-gated feature). */
  async setSweepRule(
    accountId: string,
    rule: { fund_id: string; threshold: Money; max_share_bps: number; floor?: Money },
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<SweepRule> {
    const body = canonicalBody("putSweepRule", rule);
    const owner_authorization = await this.authorize(ownerPayloads.sweepSet(accountId, body), options.owner);
    return this.treasury.putSweepRule(accountId, { ...body, owner_authorization }, writeOptions(options));
  }

  /**
   * Withdraw from a vault to its account. Before the unlock date this needs
   * the owner (`vault.withdraw`); pass `authorize: false` for unlocked goal vaults.
   */
  async withdrawVault(
    vaultId: string,
    amount: Money,
    options: RequestOptions & { authorize?: boolean; owner?: OwnerSigner } = {},
  ): Promise<Vault> {
    const body = canonicalBody("withdrawVault", { amount });
    const authorize = options.authorize ?? (options.owner ?? this.#owner) !== undefined;
    const owner_authorization = authorize
      ? await this.authorize(ownerPayloads.vaultWithdraw(vaultId, body.amount), options.owner)
      : undefined;
    return this.vaults.withdraw(
      vaultId,
      { ...body, ...(owner_authorization ? { owner_authorization } : {}) },
      writeOptions(options),
    );
  }
}

/** Transport options for a read inside a helper (no idempotency key). */
function readOptions(options: RequestOptions): RequestOptions {
  const { signal, timeoutMs, maxRetries, headers } = options;
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/**
 * Transport options for a write inside a helper. A caller-supplied
 * idempotency key is suffixed per step so that the several writes of one
 * helper never share a key (which the API would reject as a conflict).
 */
function writeOptions(options: RequestOptions, step?: string): RequestOptions {
  const key = options.idempotencyKey;
  return {
    ...readOptions(options),
    ...(key !== undefined ? { idempotencyKey: step ? `${key}.${step}` : key } : {}),
  };
}

/** Operations whose body carries an `owner_authorization`. */
type OwnerAuthorizedOperation =
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
