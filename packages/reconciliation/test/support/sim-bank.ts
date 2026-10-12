import {
  encodeOwnerSignature,
  encodeSessionSignature,
  erc20Abi,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  signOperationHash,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferCall,
  type Call,
  type PreparedOperation,
} from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";
import { isAgentBankError, ManualClock, newId, type FreezeInternal } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { InMemoryLedger, PostgresLedger, pocketRef, type Ledger } from "@agentbank/ledger";
import { createSqlClient } from "@agentbank/db";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Indexer,
  IndexerStore,
  migrateIndexer,
  type ReconcilerTransport,
} from "../../../../apps/indexer/src/index";
import { createReconciler, type Reconciler } from "../../src";

/**
 * A minimal Agent Bank around the real reconciler and the real indexer loop, driving a
 * `SimulatedChain` the way the API would: org/agent/account rows, payments with an `allow`
 * decision and a ledger hold, operations signed by the session key + co-signer (or the owner),
 * x402 EIP-3009 authorizations signed by spend keys, deposits from outside, and the API worker's
 * failure handling (reverted or dropped operations void their holds).
 */

export const ASSET = "USDC";
export const SIM_REVENUE: Address = getAddress("0x00000000000000000000000000000000000fee00");

export interface SimAccount {
  id: string;
  orgId: string;
  agentId: string | null;
  role: "agent" | "treasury";
  address: Address;
  owner: LocalAccount;
  salt: bigint;
  spendKey: LocalAccount | null;
  session: { key: LocalAccount; permissionId: Hex } | null;
  deployed: boolean;
}

export interface SimPayment {
  id: string;
  account: SimAccount;
  kind: "transfer" | "x402" | "refill" | "escrow" | "stream" | "vault";
  amount: bigint;
  fee: bigint;
  holdId: string;
  to: Address;
  userOpHash: Hex | null;
  /** Relayed EIP-3009 settlement (x402). */
  txHash: Hex | null;
}

export interface SimBankOptions {
  ledger?: "memory" | "postgres";
  windowBlocks?: number;
  finalityDepth?: number;
  automine?: boolean;
  /** Co-signer `freeze` (default: records the call). */
  freeze?: (input: FreezeInternal) => Promise<void>;
  /** Wrap the in-process transport (e.g. to count calls). */
  transport?: (reconciler: Reconciler) => ReconcilerTransport;
  maxBlocksPerTick?: number;
  batchEvents?: number;
  /** Use an existing indexer database (restart tests). */
  indexerDb?: SqlClient;
  /**
   * `separate` (as in production, the gate) or `shared`: the indexer's tables live in the bank's
   * test database, which saves a second PGlite instance per test (default).
   */
  indexerDatabase?: "separate" | "shared";
}

/** Outbound payment fee: 0.20%, rounded half up, capped at $5.00 (as the API). */
export function outboundFee(amount: bigint): bigint {
  const fee = (amount * 20n + 5_000n) / 10_000n;
  return fee > 5_000_000n ? 5_000_000n : fee;
}

export const usd = (dollars: number | bigint): bigint => BigInt(dollars) * 1_000_000n;

export class SimBank {
  readonly payments = new Map<string, SimPayment>();
  private saltCounter = 1n;
  private orgOwners = new Map<string, LocalAccount>();

  private constructor(
    readonly chain: SimulatedChain,
    readonly clock: ManualClock,
    readonly db: SqlClient,
    readonly ledger: Ledger,
    readonly reconciler: Reconciler,
    readonly indexerDb: SqlClient,
    readonly indexer: Indexer,
    readonly cosignerKey: LocalAccount,
    readonly mode: "memory" | "postgres",
    /** Every co-signer `freeze` call the reconciler made. */
    readonly freezes: FreezeInternal[],
  ) {}

  static async create(options: SimBankOptions = {}): Promise<SimBank> {
    const clock = new ManualClock("2026-10-11T12:00:00Z");
    const chain = new SimulatedChain({
      clock,
      finalityDepth: options.finalityDepth ?? 12,
      automine: options.automine ?? true,
    });
    const db = await createTestDatabase();
    const mode = options.ledger ?? "memory";
    const ledger: Ledger =
      mode === "memory" ? new InMemoryLedger({ clock }) : new PostgresLedger(db, { clock });
    const freezes: FreezeInternal[] = [];
    const reconciler = createReconciler({
      db,
      ledger: mode === "memory" ? ledger : (tx) => new PostgresLedger(tx, { clock }),
      cosigner: {
        freeze: async (input) => {
          freezes.push(input);
          if (options.freeze) await options.freeze(input);
        },
      },
      clock,
      config: {
        chainId: chain.chainId,
        usdc: chain.contracts.usdc,
        revenueAddress: SIM_REVENUE,
        contracts: {
          escrow: chain.contracts.escrow,
          streams: chain.contracts.streams,
          vaults: chain.contracts.vaults,
          topUpExecutor: chain.contracts.topUpExecutor,
        },
        ...(options.windowBlocks !== undefined ? { windowBlocks: options.windowBlocks } : {}),
      },
      logger: { warn: () => undefined, error: () => undefined },
    });
    const indexerDb =
      options.indexerDb ??
      (options.indexerDatabase === "separate" ? await createSqlClient("pglite://memory") : db);
    await migrateIndexer(indexerDb);
    const indexer = new Indexer({
      chain: chain.gateway,
      transport: options.transport ? options.transport(reconciler) : reconciler,
      store: new IndexerStore(indexerDb, chain.chainId, () => clock.now()),
      windowBlocks: options.windowBlocks ?? 20,
      startBlock: 0n,
      clock,
      maxBlocksPerTick: options.maxBlocksPerTick ?? 500,
      batchEvents: options.batchEvents ?? 2_000,
      watchlistRefreshMs: 3_600_000,
    });
    const bank = new SimBank(
      chain,
      clock,
      db,
      ledger,
      reconciler,
      indexerDb,
      indexer,
      privateKeyToAccount(generatePrivateKey()),
      mode,
      freezes,
    );
    return bank;
  }

  async close(): Promise<void> {
    await this.flushRows().catch(() => undefined);
    await this.db.close();
    if (this.indexerDb !== this.db) await this.indexerDb.close();
  }

  now(): Date {
    return this.clock.now();
  }

  /** Advance time (blocks follow the shared clock). */
  tick(seconds = 2): void {
    this.clock.advance(seconds * 1000);
  }

  // ---------------------------------------------------------------- identity

  async createOrg(): Promise<string> {
    const id = newId("org", this.now().getTime());
    const owner = privateKeyToAccount(generatePrivateKey());
    await this.db.query(
      `INSERT INTO org (id, legal_name, kind, country, contact_email, kyc_status, owner_address, created_at)
       VALUES ($1, $2, 'company', 'US', $3, 'approved', $4, $5)`,
      [id, `Org ${id.slice(-6)}`, `ops+${id.slice(-6).toLowerCase()}@example.com`, owner.address, this.now()],
    );
    this.orgOwners.set(id, owner);
    return id;
  }

  /** An agent (or treasury) account: rows, ledger pockets, counterfactual address. */
  async createAccount(
    orgId: string,
    options: { role?: "agent" | "treasury"; spendKey?: boolean; x402Payee?: boolean } = {},
  ): Promise<SimAccount> {
    const role = options.role ?? "agent";
    const owner = this.orgOwners.get(orgId) as LocalAccount;
    const now = this.now();
    let agentId: string | null = null;
    if (role === "agent") {
      agentId = newId("agent", now.getTime());
      await this.db.query("INSERT INTO agent (id, org_id, name, created_at) VALUES ($1, $2, $3, $4)", [
        agentId,
        orgId,
        `agent ${agentId.slice(-6)}`,
        now,
      ]);
    }
    const salt = this.saltCounter++;
    const address = await this.chain.gateway.predictAccountAddress({
      owner: owner.address,
      cosigner: this.cosignerKey.address,
      salt,
    });
    const spendKey = options.spendKey ? privateKeyToAccount(generatePrivateKey()) : null;
    const id = newId("account", now.getTime());
    await this.db.query(
      `INSERT INTO account (id, org_id, agent_id, role, chain_id, address, owner_address, spend_key_address, salt, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        orgId,
        agentId,
        role,
        this.chain.chainId,
        address,
        owner.address,
        spendKey?.address ?? null,
        salt.toString(),
        now,
      ],
    );
    if (role === "treasury")
      await this.db.query("UPDATE org SET treasury_account_id = $2 WHERE id = $1", [orgId, id]);
    if (options.x402Payee) {
      await this.db.query("INSERT INTO x402_payee (account_id, domains, created_at) VALUES ($1, $2, $3)", [
        id,
        ["api.seller.example"],
        now,
      ]);
    }
    await this.ledger.openPockets(id, ASSET, this.chain.chainId);
    this.indexer.invalidateWatchlist();
    return { id, orgId, agentId, role, address, owner, salt, spendKey, session: null, deployed: false };
  }

  /** Deploy the account and install a broad session (owner operation). */
  async installSession(account: SimAccount): Promise<void> {
    const key = privateKeyToAccount(generatePrivateKey());
    const now = this.chain.nowSeconds();
    const grant = {
      sessionKey: key.address,
      cosigner: this.cosignerKey.address,
      salt: sessionSalt(newId("session", this.now().getTime())),
      scope: {
        token: this.chain.contracts.usdc,
        maxPerTx: 10n ** 15n,
        maxPerDay: 10n ** 15n,
        allowedRecipients: [],
        allowedContracts: [
          this.chain.contracts.escrow,
          this.chain.contracts.streams,
          this.chain.contracts.vaults,
        ].filter((a): a is Address => a !== undefined),
        issuedAt: now,
        expiresAt: now + 30 * 24 * 3600,
      },
    };
    const gateway = this.chain.gateway;
    const op = await gateway.prepareOwnerOperation({
      account: account.address,
      ...(account.deployed
        ? {}
        : {
            deployment: {
              owner: account.owner.address,
              cosigner: this.cosignerKey.address,
              salt: account.salt,
            },
          }),
      calls: sessionInstallCalls({ contracts: gateway.contracts, grant }),
    });
    await gateway.submitOperation({
      op,
      signature: encodeOwnerSignature(await signOperationHash(account.owner, op.userOpHash)),
    });
    if (!this.chain.automine) this.chain.mine();
    account.deployed = true;
    account.session = { key, permissionId: sessionPermissionId(grant, gateway.contracts) };
  }

  // ---------------------------------------------------------------- money in

  /** Mint USDC to an address (a deposit from outside Agent Bank). */
  faucet(to: Address, amount: bigint): Hex {
    return this.chain.faucet(to, amount);
  }

  /** An external EOA (funded from the faucet) that can transfer or sign EIP-3009. */
  externalWallet(fund: bigint = usd(1_000_000)): LocalAccount {
    const wallet = privateKeyToAccount(generatePrivateKey());
    this.chain.faucet(wallet.address, fund);
    return wallet;
  }

  /** Plain ERC-20 transfer from an external EOA. */
  externalTransfer(from: LocalAccount, to: Address, amount: bigint): Hex {
    return this.chain.sendTransaction({
      from: from.address,
      to: this.chain.contracts.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    });
  }

  /**
   * EIP-3009 `transferWithAuthorization` signed by `from`, relayed by a facilitator. With
   * `facilitator`, Agent Bank's facilitator settles it and logs it in `x402_authorization` (as
   * `apps/facilitator` does, before submitting), naming the seller account when it is one.
   */
  async authorizedTransfer(
    from: LocalAccount,
    to: Address,
    amount: bigint,
    nonce: Hex,
    facilitator?: { payeeAccountId: string | null },
  ): Promise<Hex> {
    const message = {
      from: from.address,
      to,
      value: amount,
      validAfter: 0n,
      validBefore: BigInt(this.chain.nowSeconds() + 3600),
      nonce,
    };
    if (facilitator) {
      const now = this.now();
      await this.db.query(
        `INSERT INTO x402_authorization (id, chain_id, asset, authorizer, nonce, pay_to, amount, valid_after, valid_before,
                                         payee_account_id, request_hash, status, created_at, submitted_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, 'settling', $11, $11, $11)`,
        [
          newId("x402", now.getTime()),
          this.chain.chainId,
          getAddress(this.chain.contracts.usdc),
          getAddress(from.address),
          nonce.toLowerCase(),
          getAddress(to),
          amount,
          message.validBefore,
          facilitator.payeeAccountId,
          nonce.toLowerCase(),
          now,
        ],
      );
    }
    const signature = await from.signTypedData({
      domain: {
        name: "USDC",
        version: "2",
        chainId: this.chain.chainId,
        verifyingContract: this.chain.contracts.usdc,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    const { txHash } = await this.chain.gateway.settleAuthorization({
      token: this.chain.contracts.usdc,
      ...message,
      signature,
    });
    return txHash;
  }

  // ---------------------------------------------------------------- payments (as the API)

  /** Available operating (or spend) balance in the ledger. */
  async available(account: SimAccount, pocket: "operating" | "spend" = "operating"): Promise<bigint> {
    return this.ledger.balance(pocketRef(account.id, pocket, ASSET));
  }

  /** Payment rows waiting to be inserted (batched; flushed before anything reads them). */
  private pendingRows: { decision: unknown[] | null; payment: unknown[] }[] = [];

  private async record(
    payment: SimPayment,
    status: "requires_signature" | "submitted",
    counterparty: { type: "address" | "agent" | "x402"; agentId: string | null; domain: string | null },
    extra: { userOpHash?: Hex | null; x402Nonce?: Hex | null; decision?: "allow" | "none" } = {},
  ): Promise<void> {
    const now = this.now();
    const decisionId = newId("decision", now.getTime());
    const allow = (extra.decision ?? "allow") === "allow";
    this.pendingRows.push({
      decision: allow ? [decisionId, payment.id, payment.account.agentId ?? "treasury", now] : null,
      payment: [
        payment.id,
        payment.account.id,
        payment.account.orgId,
        payment.account.agentId,
        payment.kind,
        counterparty.type,
        payment.to,
        counterparty.agentId,
        counterparty.domain,
        payment.amount,
        payment.fee,
        status,
        allow ? decisionId : null,
        payment.holdId,
        extra.userOpHash ?? null,
        extra.x402Nonce ?? null,
        now,
      ],
    });
    if (this.pendingRows.length >= 500) await this.flushRows();
  }

  /** Insert buffered payment rows (and their `allow` decisions). */
  async flushRows(): Promise<void> {
    if (this.pendingRows.length === 0) return;
    const rows = this.pendingRows;
    this.pendingRows = [];
    const decisions = rows.map((r) => r.decision).filter((d): d is unknown[] => d !== null);
    if (decisions.length > 0) {
      await this.db.query(
        `INSERT INTO policy_decision (id, payment_id, agent_id, outcome, rule_hits_json, source, evaluated_at)
         VALUES ${decisions.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, 'allow', '[]', 'api', $${i * 4 + 4})`).join(", ")}`,
        decisions.flat() as never[],
      );
    }
    await this.db.query(
      `INSERT INTO payment (id, account_id, org_id, agent_id, kind, counterparty_type, counterparty_address,
                            counterparty_agent_id, counterparty_x402_domain, amount, fee, asset, status, decision_id,
                            hold_id, user_op_hash, x402_nonce, idempotency_key, request_hash, created_at, updated_at)
       VALUES ${rows
         .map((_, i) => {
           const b = i * 17;
           const p = (n: number) => `$${b + n}`;
           return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, 'USDC', ${p(12)}, ${p(13)}, ${p(14)}, ${p(15)}, ${p(16)}, ${p(1)}, ${p(1)}, ${p(17)}, ${p(17)})`;
         })
         .join(", ")}`,
      rows.flatMap((r) => r.payment) as never[],
    );
  }

  private async hold(
    paymentId: string,
    account: SimAccount,
    amount: bigint,
    from: "operating" | "spend",
  ): Promise<string> {
    const hold = await this.ledger.hold({
      idempotencyKey: `payment:${paymentId}:hold`,
      accountId: account.id,
      asset: ASSET,
      amount,
      from,
      expiresAt: new Date(this.now().getTime() + 7 * 24 * 3600 * 1000),
      refType: "payment",
      refId: paymentId,
      paymentId,
      agentId: account.agentId,
    });
    return hold.id;
  }

  /** Sign and submit an operation (session + co-signer, or the owner). */
  private async submit(account: SimAccount, calls: Call[], path: "session" | "owner"): Promise<Hex> {
    const gateway = this.chain.gateway;
    let op: PreparedOperation;
    let signature: Hex;
    if (path === "session" && account.session) {
      op = await gateway.prepareOperation({
        account: account.address,
        session: { permissionId: account.session.permissionId },
        calls,
      });
      signature = encodeSessionSignature({
        permissionId: account.session.permissionId,
        sessionSignature: await signOperationHash(account.session.key, op.userOpHash),
        cosignerSignature: await signOperationHash(this.cosignerKey, op.userOpHash),
      });
    } else {
      op = await gateway.prepareOwnerOperation({
        account: account.address,
        ...(account.deployed
          ? {}
          : {
              deployment: {
                owner: account.owner.address,
                cosigner: this.cosignerKey.address,
                salt: account.salt,
              },
            }),
        calls,
      });
      signature = encodeOwnerSignature(await signOperationHash(account.owner, op.userOpHash));
    }
    const { userOpHash } = await gateway.submitOperation({ op, signature });
    account.deployed = true;
    return userOpHash;
  }

  /**
   * A transfer from an account (to another account, an external address or its own spend key):
   * hold amount + fee, operation = transfer + fee to the revenue address, payment `submitted`.
   */
  async pay(
    account: SimAccount,
    to: Address,
    amount: bigint,
    options: {
      path?: "session" | "owner";
      kind?: "transfer" | "refill";
      fee?: bigint;
      toAccount?: SimAccount | null;
      decision?: "allow" | "none";
      /** Change the operation after the payment was recorded (tamper tests). */
      tamper?: (calls: Call[]) => Call[];
    } = {},
  ): Promise<SimPayment> {
    const fee = options.fee ?? (options.kind === "refill" ? 0n : outboundFee(amount));
    const id = newId("payment", this.now().getTime());
    const holdId = await this.hold(id, account, amount + fee, "operating");
    const token = this.chain.contracts.usdc;
    let calls: Call[] = [transferCall({ token, to, amount })];
    if (fee > 0n) calls.push(transferCall({ token, to: SIM_REVENUE, amount: fee }));
    if (options.tamper) calls = options.tamper(calls);
    const payment: SimPayment = {
      id,
      account,
      kind: options.kind ?? "transfer",
      amount,
      fee,
      holdId,
      to,
      userOpHash: null,
      txHash: null,
    };
    try {
      payment.userOpHash = await this.submit(account, calls, options.path ?? "owner");
    } catch (error) {
      await this.ledger.voidHold({ idempotencyKey: `payment:${id}:void`, holdId, reason: "failed" });
      throw error;
    }
    await this.record(
      payment,
      "submitted",
      {
        type: options.toAccount?.agentId ? "agent" : "address",
        agentId: options.toAccount?.agentId ?? null,
        domain: null,
      },
      { userOpHash: payment.userOpHash, decision: options.decision ?? "allow" },
    );
    this.payments.set(id, payment);
    return payment;
  }

  /**
   * A payment row and hold exactly as the API leaves them, without touching the chain (rule
   * tests push hand-made evidence for it).
   */
  async seedPayment(
    account: SimAccount,
    input: {
      to: Address;
      amount: bigint;
      fee?: bigint;
      kind?: SimPayment["kind"];
      status?: "requires_signature" | "submitted";
      userOpHash?: Hex | null;
      txHash?: Hex | null;
      x402Nonce?: Hex | null;
      decision?: "allow" | "none";
    },
  ): Promise<SimPayment> {
    const id = newId("payment", this.now().getTime());
    const fee = input.fee ?? 0n;
    const holdId = await this.hold(
      id,
      account,
      input.amount + fee,
      input.kind === "x402" ? "spend" : "operating",
    );
    const payment: SimPayment = {
      id,
      account,
      kind: input.kind ?? "transfer",
      amount: input.amount,
      fee,
      holdId,
      to: input.to,
      userOpHash: input.userOpHash ?? null,
      txHash: input.txHash ?? null,
    };
    await this.record(
      payment,
      input.status ?? "submitted",
      {
        type: input.kind === "x402" ? "x402" : "address",
        agentId: null,
        domain: input.kind === "x402" ? "api.seller.example" : null,
      },
      {
        userOpHash: input.userOpHash ?? null,
        x402Nonce: input.x402Nonce ?? null,
        decision: input.decision ?? "allow",
      },
    );
    await this.flushRows();
    if (input.txHash)
      await this.db.query("UPDATE payment SET tx_hash = $2 WHERE id = $1", [id, input.txHash]);
    this.payments.set(id, payment);
    return payment;
  }

  /** Refill the account's spend key (kind `refill`). */
  refill(account: SimAccount, amount: bigint, path: "session" | "owner" = "owner"): Promise<SimPayment> {
    return this.pay(account, (account.spendKey as LocalAccount).address, amount, { kind: "refill", path });
  }

  /** x402 pay: hold on the spend key's float, EIP-3009 signed by the spend key, relayed. */
  async x402(account: SimAccount, payTo: Address, amount: bigint): Promise<SimPayment> {
    const id = newId("payment", this.now().getTime());
    const holdId = await this.hold(id, account, amount, "spend");
    const nonce = keccak256(stringToHex(id));
    const payment: SimPayment = {
      id,
      account,
      kind: "x402",
      amount,
      fee: 0n,
      holdId,
      to: payTo,
      userOpHash: null,
      txHash: null,
    };
    await this.record(
      payment,
      "requires_signature",
      { type: "x402", agentId: null, domain: "api.seller.example" },
      { x402Nonce: nonce },
    );
    try {
      payment.txHash = await this.authorizedTransfer(account.spendKey as LocalAccount, payTo, amount, nonce);
    } catch (error) {
      await this.failPayment(payment, "relay failed");
      throw error;
    }
    this.payments.set(id, payment);
    return payment;
  }

  /** Any account operation that is not a payment (escrow actions, raw calls). */
  async operate(account: SimAccount, calls: Call[], path: "session" | "owner" = "owner"): Promise<Hex> {
    return this.submit(account, calls, path);
  }

  /** A payment whose operation is given (escrow lock, stream create, vault deposit…). */
  async payWith(
    account: SimAccount,
    input: {
      kind: SimPayment["kind"];
      to: Address;
      amount: bigint;
      fee: bigint;
      calls: Call[];
      path?: "session" | "owner";
    },
  ): Promise<SimPayment> {
    const id = newId("payment", this.now().getTime());
    const holdId = await this.hold(id, account, input.amount + input.fee, "operating");
    const calls = [...input.calls];
    if (input.fee > 0n)
      calls.push(transferCall({ token: this.chain.contracts.usdc, to: SIM_REVENUE, amount: input.fee }));
    const payment: SimPayment = {
      id,
      account,
      kind: input.kind,
      amount: input.amount,
      fee: input.fee,
      holdId,
      to: input.to,
      userOpHash: null,
      txHash: null,
    };
    payment.userOpHash = await this.submit(account, calls, input.path ?? "owner");
    await this.record(
      payment,
      "submitted",
      { type: "address", agentId: null, domain: null },
      { userOpHash: payment.userOpHash },
    );
    this.payments.set(id, payment);
    return payment;
  }

  // ---------------------------------------------------------------- the API worker

  async failPayment(payment: SimPayment, reason: string): Promise<boolean> {
    await this.flushRows();
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE payment SET status = 'failed', failure_reason = $2, updated_at = $3
        WHERE id = $1 AND status IN ('requires_signature', 'submitted') RETURNING id`,
      [payment.id, reason, this.now()],
    );
    if (rows.length === 0) return false;
    try {
      await this.ledger.voidHold({
        idempotencyKey: `payment:${payment.id}:void`,
        holdId: payment.holdId,
        reason: "failed",
      });
    } catch (error) {
      if (!(isAgentBankError(error) && error.code === "invalid_state")) throw error;
    }
    return true;
  }

  /**
   * What the API worker does with receipts: operations that reverted or were dropped (and x402
   * authorizations whose relayed transaction vanished) fail and release their holds. Run with an
   * empty mempool (after mining), so `not_found` means gone.
   */
  async apiWorker(): Promise<number> {
    await this.flushRows();
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT id FROM payment WHERE status IN ('requires_signature', 'submitted')",
    );
    let failed = 0;
    for (const { id } of rows) {
      const payment = this.payments.get(id);
      if (!payment) continue;
      if (payment.kind === "x402") {
        const used = await this.chain.gateway.authorizationState(
          this.chain.contracts.usdc,
          (payment.account.spendKey as LocalAccount).address,
          keccak256(stringToHex(payment.id)),
        );
        if (
          !used &&
          payment.txHash &&
          !this.chain.transaction(payment.txHash) &&
          this.chain.pendingCount === 0
        ) {
          if (await this.failPayment(payment, "authorization never settled")) failed++;
        }
        continue;
      }
      const receipt = await this.chain.gateway.getOperationReceipt(payment.userOpHash as Hex);
      if (
        receipt.status === "reverted" ||
        (receipt.status === "not_found" && this.chain.pendingCount === 0)
      ) {
        if (await this.failPayment(payment, `operation ${receipt.status}`)) failed++;
      }
    }
    return failed;
  }

  // ---------------------------------------------------------------- reconciliation

  /** Let the indexer catch up with the chain (payment rows are written first, as the API would have). */
  async sync(): Promise<unknown> {
    await this.flushRows();
    return this.indexer.catchUp();
  }

  /** Mine until every block with activity is final, indexing as the chain advances. */
  async settleAll(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      if (this.chain.pendingCount > 0) this.chain.mine();
      this.tick(2);
      this.chain.mine(this.chain.finalityDepth + 1);
      await this.sync();
      const failed = await this.apiWorker();
      await this.sync();
      const deferred = await this.indexerStoreDeferred();
      const pending = await this.reconciler.retryPendingReversals();
      const { rows } = await this.db.query<{ n: bigint }>(
        "SELECT count(*) AS n FROM chain_tx WHERE reversal = 'pending' OR status = 'deferred'",
      );
      if (failed === 0 && deferred === 0 && pending === 0 && rows[0]?.n === 0n) return;
    }
    throw new Error("the simulation did not settle");
  }

  private async indexerStoreDeferred(): Promise<number> {
    const { rows } = await this.indexerDb.query<{ n: bigint }>("SELECT count(*) AS n FROM indexer_deferred");
    return Number(rows[0]?.n ?? 0n);
  }

  /** Every watched address: on-chain balance at the head vs the ledger's expected balance. */
  async compareBalances(): Promise<{ address: string; kind: string; onchain: bigint; expected: bigint }[]> {
    const list = await this.reconciler.watchlist();
    const addresses = list.addresses.map((a) => a.address);
    const out: { address: string; kind: string; onchain: bigint; expected: bigint }[] = [];
    for (let i = 0; i < addresses.length; i += 1_000) {
      const chunk = addresses.slice(i, i + 1_000);
      const { balances } = await this.reconciler.expectedBalances({
        chain_id: this.chain.chainId,
        addresses: chunk,
      });
      for (const b of balances) {
        const kind =
          list.addresses.find((a) => a.address.toLowerCase() === b.address.toLowerCase())?.kind ?? "?";
        out.push({
          address: b.address,
          kind,
          onchain: this.chain.balanceOf(b.address as Address),
          expected: BigInt(b.expected),
        });
      }
    }
    return out;
  }

  async suspense(): Promise<bigint> {
    return this.ledger.balance({ ownerRef: "system", code: "sys:suspense", asset: ASSET });
  }

  async paymentStatus(id: string): Promise<string> {
    await this.flushRows();
    const { rows } = await this.db.query<{ status: string }>("SELECT status FROM payment WHERE id = $1", [
      id,
    ]);
    return rows[0]?.status ?? "missing";
  }
}
