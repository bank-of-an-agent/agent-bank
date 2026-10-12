import {
  encodeExecute,
  encodeOwnerSignature,
  encodeSessionSignature,
  hashUserOperation,
  onchainScopeFromWire,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  signOperationHash,
  transferCall,
  validatorNonceKey,
  type Call,
  type PreparedOperation,
} from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";
import {
  ManualClock,
  newId,
  OpenPaymentMandateSchema,
  ownerAuthorizationTypedData,
  ownerPayloads,
  PolicyDocumentSchema,
  unixSeconds,
  signInternalRequest,
  type CosignInternal,
  type OpenPaymentMandate,
  type OwnerAction,
  type OwnerActionPayload,
  type OwnerAuthorization,
  type PolicyDocumentInput,
  type SessionScope,
} from "@agentbank/core";
import {
  PgClient,
  PgliteClient,
  type QueryResult,
  type SqlClient,
  type SqlParam,
  type TransactionOptions,
} from "@agentbank/db";
import { getAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { createCosigner, type Cosigner } from "../src/create";
import { migrateCosigner } from "../src/database";
import { LocalSigner } from "../src/signer";
import { ANVIL_KEYS, keys } from "./keys";

export { ANVIL_KEYS, keys } from "./keys";

export const SECRET = "test-only-internal-shared-secret-0123456789";
export const REVENUE: Address = getAddress("0x000000000000000000000000000000000000beef");
export const PAYEE: Address = keys.payee.address;
export const ATTACKER: Address = keys.attacker.address;
export const START = "2026-10-11T12:00:00.000Z";

/** USDC minor units from a decimal number of dollars (whole cents only). */
export function usd(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100)) * 10_000n;
}

/**
 * A fresh, migrated co-signer database. PGlite by default; with
 * `DATABASE_URL` (CI) an isolated schema on that PostgreSQL server.
 */
export async function createTestDb(): Promise<{ db: SqlClient; close: () => Promise<void> }> {
  const url = process.env.COSIGNER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url && !url.startsWith("pglite:")) {
    const schema = `cosigner_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new PgClient({ connectionString: url, max: 1 });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    const db = new PgClient({ connectionString: url, schema, max: 8 });
    await migrateCosigner(db);
    return {
      db,
      close: async () => {
        await db.close();
        await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      },
    };
  }
  const db = await PgliteClient.create();
  await migrateCosigner(db);
  return { db, close: () => db.close() };
}

/**
 * Wraps a database so a test can simulate failures: `down` fails every call
 * (an outage); `failOn` fails the statements matching it (e.g. the audit
 * append, after the signature was produced), inside transactions too.
 */
export class ToggleDb implements SqlClient {
  down = false;
  failOn: RegExp | null = null;
  constructor(private readonly inner: SqlClient) {}

  get driver(): SqlClient["driver"] {
    return this.inner.driver;
  }

  #check(sql?: string): void {
    if (this.down || (sql !== undefined && this.failOn?.test(sql))) {
      throw Object.assign(new Error("connect ECONNREFUSED (simulated database failure)"), {
        code: "ECONNREFUSED",
      });
    }
  }

  #wrap(tx: SqlClient): SqlClient {
    return {
      driver: tx.driver,
      query: async <T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]) => {
        this.#check(sql);
        return tx.query<T>(sql, params);
      },
      transaction: <T>(fn: (inner: SqlClient) => Promise<T>) => fn(this.#wrap(tx)),
      exec: async (sql: string) => {
        this.#check(sql);
        return tx.exec(sql);
      },
      close: () => tx.close(),
    };
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlParam[],
  ): Promise<QueryResult<T>> {
    this.#check(sql);
    return this.inner.query<T>(sql, params);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>, options?: TransactionOptions): Promise<T> {
    this.#check();
    return this.inner.transaction((tx) => fn(this.#wrap(tx)), options);
  }

  async exec(sql: string): Promise<void> {
    this.#check(sql);
    return this.inner.exec(sql);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

/** An owner authorization (EIP-712) signed with `account`. */
export async function ownerAuthorization(
  account: PrivateKeyAccount,
  args: {
    chainId: number;
    action: OwnerAction;
    subject: string;
    payload: unknown;
    issuedAt: number;
    ttl?: number;
  },
): Promise<OwnerAuthorization> {
  const expiresAt = args.issuedAt + (args.ttl ?? 600);
  const typed = ownerAuthorizationTypedData({ ...args, expiresAt });
  return {
    signer: account.address,
    signature: await account.signTypedData(typed),
    issued_at: args.issuedAt,
    expires_at: expiresAt,
  };
}

/** Sign core's canonical owner payload (`ownerPayloads.*`), as the console or SDK does. */
export async function signOwnerAction(
  account: PrivateKeyAccount,
  chainId: number,
  action: OwnerActionPayload,
  issuedAt: number,
  ttl = 600,
): Promise<OwnerAuthorization> {
  return ownerAuthorization(account, {
    chainId,
    action: action.action,
    subject: action.subject,
    payload: action.payload,
    issuedAt,
    ttl,
  });
}

export const DEFAULT_POLICY: PolicyDocumentInput = {
  limits: { per_tx: "100.00", per_day: "300.00", per_week: "1000.00", per_month: "3000.00" },
};

export interface WorldOptions {
  failClosed?: boolean;
  policy?: PolicyDocumentInput | null;
  scope?: Partial<SessionScope>;
  maxFeeSweep?: bigint;
}

/**
 * Everything a co-signer test needs: a manual clock shared by the
 * simulated chain and the co-signer, a deployed Safe7579 account whose
 * 2-of-2 session (session key + this co-signer) is installed on-chain by the
 * owner, funded with test USDC, and registered with the co-signer together
 * with an initial owner-signed policy.
 */
export class World {
  readonly org = newId("org");
  readonly agent = newId("agent");
  readonly accountId = newId("account");
  readonly sessionId = newId("session");
  clock!: ManualClock;
  chain!: SimulatedChain;
  cosigner!: Cosigner;
  signer!: LocalSigner;
  account!: Address;
  permissionId!: Hex;
  scope!: SessionScope;
  db!: ToggleDb;
  #closeDb!: () => Promise<void>;
  #payments = 0;
  #lane = 0;

  static async create(options: WorldOptions = {}): Promise<World> {
    const w = new World();
    await w.#init(options);
    return w;
  }

  async #init(options: WorldOptions): Promise<void> {
    this.clock = new ManualClock(START);
    const { db, close } = await createTestDb();
    this.db = new ToggleDb(db);
    this.#closeDb = close;
    this.chain = new SimulatedChain({ clock: this.clock });
    this.signer = LocalSigner.create({
      privateKey: ANVIL_KEYS.cosigner,
      chainId: this.chain.chainId,
      nodeEnv: "test",
    });
    this.cosigner = await createCosigner({
      db: this.db,
      signer: this.signer,
      chain: this.chain.gateway,
      sharedSecret: SECRET,
      revenueAddress: REVENUE,
      clock: this.clock,
      failClosed: options.failClosed ?? false,
      ...(options.maxFeeSweep !== undefined ? { maxFeeSweep: options.maxFeeSweep } : {}),
    });
    const gateway = this.chain.gateway;
    const deployment = { owner: keys.owner.address, cosigner: this.signer.address, salt: 1n };
    this.account = await gateway.predictAccountAddress(deployment);
    this.scope = {
      asset: "USDC",
      max_per_tx: "200.00",
      max_per_day: "1000.00",
      expires_at: new Date(this.clock.now().getTime() + 24 * 3600_000).toISOString(),
      ...options.scope,
    };
    const grant = {
      sessionKey: keys.session.address,
      cosigner: this.signer.address,
      salt: sessionSalt(this.sessionId),
      scope: onchainScopeFromWire(this.scope, {
        token: gateway.contracts.usdc,
        issuedAt: unixSeconds(this.clock.now()),
      }),
    };
    this.permissionId = sessionPermissionId(grant, gateway.contracts);
    const install = await gateway.prepareOwnerOperation({
      account: this.account,
      deployment,
      calls: sessionInstallCalls({ contracts: gateway.contracts, grant }),
    });
    await gateway.submitOperation({
      op: install,
      signature: encodeOwnerSignature(await signOperationHash(keys.owner, install.userOpHash)),
    });
    this.chain.faucet(this.account, usd(10_000));
    await this.registerSession();
    if (options.policy !== null) await this.putPolicy(options.policy ?? DEFAULT_POLICY);
  }

  get client() {
    return this.cosigner.client;
  }

  get service() {
    return this.cosigner.service;
  }

  get usdc(): Address {
    return this.chain.contracts.usdc;
  }

  now(): number {
    return unixSeconds(this.clock.now());
  }

  async registerSession(
    overrides: Partial<{ sessionId: string; publicKey: Address; scope: SessionScope }> = {},
  ): Promise<void> {
    const sessionId = overrides.sessionId ?? this.sessionId;
    const publicKey = overrides.publicKey ?? keys.session.address;
    const scope = overrides.scope ?? this.scope;
    await this.client.registerSession({
      session_id: sessionId,
      org_id: this.org,
      agent_id: this.agent,
      account_id: this.accountId,
      chain_id: this.chain.chainId,
      account_address: this.account,
      owner_address: keys.owner.address,
      public_key: publicKey,
      scope,
      owner_authorization: await signOwnerAction(
        keys.owner,
        this.chain.chainId,
        ownerPayloads.sessionGrant({ account_id: this.accountId, public_key: publicKey, scope }),
        this.now(),
      ),
    });
  }

  async putPolicy(policy: PolicyDocumentInput, sign: PrivateKeyAccount | null = keys.owner) {
    return this.client.putPolicy({
      org_id: this.org,
      agent_id: this.agent,
      chain_id: this.chain.chainId,
      owner_address: keys.owner.address,
      policy: policy as never,
      ...(sign
        ? {
            owner_authorization: await signOwnerAction(
              sign,
              this.chain.chainId,
              ownerPayloads.policyLoosen(this.agent, PolicyDocumentSchema.parse(policy)),
              this.now(),
            ),
          }
        : {}),
    });
  }

  /** Prepare a session operation for `calls` (as the API would) and have the session key sign it. */
  async prepare(calls: Call[]): Promise<{ op: PreparedOperation; sessionSignature: Hex }> {
    const op = await this.chain.gateway.prepareOperation({
      account: this.account,
      session: { permissionId: this.permissionId },
      calls,
    });
    return this.#ownLane(op);
  }

  /**
   * Tests prepare many operations without submitting them, so the account's
   * nonce never advances; give each operation its own ERC-4337 nonce lane
   * (still routed to Smart Sessions, still valid on-chain) so every one has
   * a distinct hash, as consecutive operations from the API do.
   */
  async #ownLane(op: PreparedOperation): Promise<{ op: PreparedOperation; sessionSignature: Hex }> {
    this.#lane += 1;
    const lane = this.#lane;
    return tamper(op, (userOp) => {
      userOp.nonce = (validatorNonceKey(this.chain.contracts.smartSessions, lane) << 64n).toString();
    });
  }

  /**
   * Build a session operation executing exactly `calls`, the way a
   * compromised API would: encoded directly (no gateway dry run), re-hashed,
   * and signed by the session key, which signs whatever hash it is handed.
   */
  async craft(calls: Call[]): Promise<{ op: PreparedOperation; sessionSignature: Hex }> {
    const benign = await this.prepare([transferCall({ token: this.usdc, to: PAYEE, amount: 1n })]);
    return tamper(benign.op, (userOp) => {
      userOp.callData = encodeExecute(calls);
    });
  }

  /** `prepare`, or `craft` when the gateway's dry run refuses the calls (e.g. beyond the on-chain scope). */
  async prepareOrCraft(calls: Call[]): Promise<{ op: PreparedOperation; sessionSignature: Hex }> {
    try {
      return await this.prepare(calls);
    } catch {
      return this.craft(calls);
    }
  }

  /** A transfer of `amount` to `to` plus the fee transfer to the revenue address. */
  transferCalls(to: Address, amount: bigint, fee: bigint): Call[] {
    const calls = [transferCall({ token: this.usdc, to, amount })];
    if (fee > 0n) calls.push(transferCall({ token: this.usdc, to: REVENUE, amount: fee }));
    return calls;
  }

  nextPaymentId(): string {
    this.#payments += 1;
    return `pay_${this.#payments.toString().padStart(4, "0")}`;
  }

  /** The co-sign request the API would send for a prepared operation. */
  cosignRequest(
    prepared: { op: PreparedOperation; sessionSignature: Hex },
    intent: { to: Address; amount: bigint; fee: bigint; kind?: CosignInternal["intent"]["kind"] },
    extra: Partial<CosignInternal> = {},
  ): CosignInternal {
    return {
      payment_id: this.nextPaymentId(),
      org_id: this.org,
      agent_id: this.agent,
      account_id: this.accountId,
      account_address: this.account,
      chain_id: this.chain.chainId,
      session_id: this.sessionId,
      operation: JSON.parse(JSON.stringify(prepared.op)) as Record<string, unknown>,
      user_op_hash: prepared.op.userOpHash,
      session_signature: prepared.sessionSignature,
      intent: {
        kind: intent.kind ?? "transfer",
        amount: intent.amount.toString(),
        asset: "USDC",
        counterparty: { address: intent.to },
      },
      fee: intent.fee.toString(),
      ...extra,
    };
  }

  /** Prepare, sign and co-sign a transfer; returns the request and the co-signer's answer. */
  async pay(to: Address, amount: bigint, fee = 0n, extra: Partial<CosignInternal> = {}) {
    const prepared = await this.prepareOrCraft(this.transferCalls(to, amount, fee));
    const request = this.cosignRequest(prepared, { to, amount, fee }, extra);
    const result = await this.client.cosign(request);
    return { prepared, request, result };
  }

  /** Submit a co-signed operation to the simulated chain (2-of-2 session signature). */
  async submit(prepared: { op: PreparedOperation; sessionSignature: Hex }, cosignerSignature: Hex) {
    const signature = encodeSessionSignature({
      permissionId: this.permissionId,
      sessionSignature: prepared.sessionSignature,
      cosignerSignature,
    });
    const { userOpHash } = await this.chain.gateway.submitOperation({ op: prepared.op, signature });
    return this.chain.gateway.getOperationReceipt(userOpHash);
  }

  /** Register an AP2 open payment mandate signed by the owner (`mandate.issue`). */
  async registerMandate(
    mandateId: string,
    constraints: OpenPaymentMandate["constraints"],
    ttlSeconds = 86_400,
  ) {
    const mandate: OpenPaymentMandate = {
      vct: "mandate.payment.open.1",
      constraints,
      iat: this.now(),
      exp: this.now() + ttlSeconds,
      agent_id: this.agent,
    };
    await this.client.registerMandate({
      mandate_id: mandateId,
      org_id: this.org,
      agent_id: this.agent,
      chain_id: this.chain.chainId,
      owner_address: keys.owner.address,
      mandate,
      owner_authorization: await signOwnerAction(
        keys.owner,
        this.chain.chainId,
        ownerPayloads.mandateIssue(this.agent, OpenPaymentMandateSchema.parse(mandate)),
        this.now(),
      ),
    });
    return mandate;
  }

  /** An owner-signed unfreeze request (`agent.unfreeze` / `org.unfreeze`, payload `{reason}`). */
  async unfreezeRequest(
    scope: "org" | "agent" | "session",
    id: string,
    reason = "reviewed",
    signer = keys.owner,
  ) {
    return {
      scope,
      id,
      reason,
      chain_id: this.chain.chainId,
      owner_address: keys.owner.address,
      owner_authorization: await signOwnerAction(
        signer,
        this.chain.chainId,
        scope === "org" ? ownerPayloads.orgUnfreeze(id, reason) : ownerPayloads.agentUnfreeze(id, reason),
        this.now(),
      ),
    } as const;
  }

  /** A raw internal request through the app (for auth and HTTP-level tests). */
  async inject(input: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    body?: string;
    authorization?: string | null;
    signedPath?: string;
    signedMethod?: string;
    signedBody?: string;
    secret?: string;
    t?: number;
  }) {
    const body = input.body ?? "";
    const authorization =
      input.authorization === null
        ? undefined
        : (input.authorization ??
          signInternalRequest(
            input.secret ?? SECRET,
            input.signedMethod ?? input.method,
            input.signedPath ?? input.url,
            input.signedBody ?? body,
            input.t ?? this.now(),
          ));
    return this.cosigner.app.inject({
      method: input.method,
      url: input.url,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { payload: body } : {}),
    });
  }

  async close(): Promise<void> {
    await this.cosigner.close();
    await this.#closeDb();
  }
}

/**
 * Re-encode a prepared operation after changing its user operation (as a
 * compromised API could): recompute the hash and have the session key sign
 * the new hash, so only the co-signer's own checks stand in the way.
 */
export async function tamper(
  op: PreparedOperation,
  change: (userOp: PreparedOperation["userOp"]) => void,
): Promise<{ op: PreparedOperation; sessionSignature: Hex }> {
  const next = JSON.parse(JSON.stringify(op)) as PreparedOperation;
  change(next.userOp);
  next.userOpHash = hashUserOperation(next.userOp, next.chainId, next.entryPoint);
  return { op: next, sessionSignature: await signOperationHash(keys.session, next.userOpHash) };
}
