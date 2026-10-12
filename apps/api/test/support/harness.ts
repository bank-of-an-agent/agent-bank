import type { ChainGateway } from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";
import {
  ManualClock,
  ownerAuthorizationTypedData,
  signRequest,
  unixSeconds,
  type OwnerAction,
} from "@agentbank/core";
import { createSqlClient, type SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { InMemoryLedger, PostgresLedger, type Ledger } from "@agentbank/ledger";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createCosigner, LocalSigner } from "@agentbank/cosigner";
import { buildApp } from "../../src/app";
import { createApiReconciler } from "../../src/wiring";
import { loadConfig, type Config } from "../../src/config";
import type { AppDeps } from "../../src/deps";
import { createLogger, type Logger } from "../../src/logger";
import { SandboxKyb } from "../../src/providers/kyb";
import { SandboxScreening, type ScreeningProvider } from "../../src/providers/screening";
import { FakeCosigner } from "./fake-cosigner";
import { TestIndexer } from "./indexer";
import { RecordingCosigner } from "./recording-cosigner";

export const TEST_PUBLIC_BASE_URL = "http://api.test";
export const TEST_CONSOLE_ORIGIN = "http://console.test";
export const TEST_STAFF_TOKEN = "staff-token-0123456789abcdef0123456789abcdef";

export const TEST_INTERNAL_SECRET = "internal-api-test-secret-0123456789abcdef";
export const TEST_COSIGNER_SECRET = "cosigner-test-secret-0123456789abcdef";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "pglite://memory",
    AGENTBANK_CHAIN: "simulated",
    COSIGNER_SHARED_SECRET: TEST_COSIGNER_SECRET,
    INTERNAL_API_SHARED_SECRET: TEST_INTERNAL_SECRET,
    ALLOW_OPEN_SIGNUP: "true",
    STAFF_TOKEN: TEST_STAFF_TOKEN,
    CONSOLE_ORIGIN: TEST_CONSOLE_ORIGIN,
    WEBAUTHN_RP_ID: "console.test",
    PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL,
    RATE_LIMIT_PER_MINUTE: "100000",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export interface HarnessOptions {
  config?: Record<string, string>;
  ledger?: "postgres" | "memory";
  screening?: ScreeningProvider;
  start?: string;
  logger?: Logger;
  /** `real` (default): the in-process co-signer from `@agentbank/cosigner`; `fake`: the light double. */
  cosigner?: "real" | "fake";
}

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  db: SqlClient;
  ledger: Ledger;
  clock: ManualClock;
  cosigner: RecordingCosigner;
  chain: ChainGateway;
  /** The in-memory chain behind `chain` (faucet, time, reorgs, contract state). */
  sim: SimulatedChain;
  /** Pushes chain logs to the API's internal ingest route (the real reconciler settles from them). */
  indexer: TestIndexer;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = testConfig(options.config);
  const db = await createTestDatabase();
  const clock = new ManualClock(options.start ?? "2026-10-11T12:00:00Z");
  const ledger: Ledger =
    options.ledger === "memory" ? new InMemoryLedger({ clock }) : new PostgresLedger(db, { clock });
  // Short finality keeps the clock drift of each indexer sync small (it mines finalityDepth + 1 blocks).
  const sim = new SimulatedChain({ clock, safeDepth: 1, finalityDepth: 2 });
  const chain = sim.gateway;
  let cosigner: RecordingCosigner;
  let closeCosigner: () => Promise<void> = async () => undefined;
  if (options.cosigner === "fake") {
    const fake = new FakeCosigner(clock, () => chain);
    cosigner = new RecordingCosigner(fake, fake.address);
  } else {
    const cosignerDb = await createSqlClient(undefined); // the co-signer's own database (PGlite)
    const signer = LocalSigner.create({
      privateKey: generatePrivateKey(),
      chainId: chain.chainId,
      nodeEnv: "test",
    });
    const real = await createCosigner({
      db: cosignerDb,
      signer,
      chain,
      sharedSecret: TEST_COSIGNER_SECRET,
      revenueAddress: config.revenueAddress,
      clock,
    });
    cosigner = new RecordingCosigner(real.client, signer.address);
    closeCosigner = async () => {
      await real.close();
      await cosignerDb.close();
    };
  }
  const base = {
    config,
    db,
    ledger,
    chain,
    cosigner,
    clock,
    screening: options.screening ?? new SandboxScreening(config.screening.denylist),
    kyb: new SandboxKyb(),
    logger: options.logger ?? createLogger("silent"),
    simulator: sim,
  };
  const deps: AppDeps = { ...base, reconciler: createApiReconciler(base) };
  const app = await buildApp(deps);
  await app.ready();
  const indexer = new TestIndexer(app, sim, chain, clock, TEST_INTERNAL_SECRET);
  return {
    app,
    deps,
    db,
    ledger,
    clock,
    cosigner,
    chain,
    sim,
    indexer,
    async close() {
      await app.close();
      await closeCosigner();
      await db.close();
    },
  };
}

// ---------------------------------------------------------------- HTTP helpers

/** Loosely typed JSON for test assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiResponse<T = Json> {
  status: number;
  body: T;
  text: string;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface CallOptions {
  body?: unknown;
  token?: string;
  /** `false` sends no Idempotency-Key; default: a fresh random key for writes. */
  idempotencyKey?: string | false;
  headers?: Record<string, string>;
  cookie?: string;
}

let keyCounter = 0;
export function newKey(): string {
  keyCounter += 1;
  return `test-key-${Date.now().toString(36)}-${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function parse(text: string): unknown {
  try {
    return text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

export async function call(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  options: CallOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (method !== "GET" && options.idempotencyKey !== false) {
    headers["idempotency-key"] = options.idempotencyKey ?? newKey();
  }
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
  return { status: res.statusCode, text: res.body, body: parse(res.body), headers: res.headers };
}

export interface AgentSession {
  id: string;
  key: PrivateKeyAccount;
}

/** A request signed by an agent session key (RFC 9421, eip191-secp256k1). */
export async function agentCall(
  h: Pick<Harness, "app" | "clock">,
  session: AgentSession,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  options: {
    body?: unknown;
    idempotencyKey?: string | false;
    nonce?: string;
    created?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (method !== "GET" && options.idempotencyKey !== false) {
    headers["idempotency-key"] = options.idempotencyKey ?? newKey();
  }
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const signed = await signRequest(
    { method, url: `${TEST_PUBLIC_BASE_URL}${url}`, headers, body: payload ?? null },
    {
      keyId: session.id,
      signer: session.key,
      created: options.created ?? unixSeconds(h.clock.now()),
      ...(options.nonce ? { nonce: options.nonce } : {}),
    },
  );
  for (const [k, v] of Object.entries(signed)) if (v !== undefined) headers[k] = v;
  const res = await h.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
  return { status: res.statusCode, text: res.body, body: parse(res.body), headers: res.headers };
}

/** EIP-712 owner authorization signed by the org owner key. */
export async function ownerAuth(
  owner: PrivateKeyAccount,
  clock: ManualClock,
  action: OwnerAction,
  subject: string,
  payload: unknown,
  chainId = 1337,
) {
  const issuedAt = unixSeconds(clock.now());
  const expiresAt = issuedAt + 600;
  const typed = ownerAuthorizationTypedData({ chainId, action, subject, payload, issuedAt, expiresAt });
  const signature = await owner.signTypedData(typed);
  return { signer: owner.address, signature, issued_at: issuedAt, expires_at: expiresAt };
}

export interface TestOrg {
  org: Json;
  apiKey: string;
  owner: PrivateKeyAccount;
}

let orgCounter = 0;
export async function signupOrg(app: FastifyInstance, name = "Acme Robotics"): Promise<TestOrg> {
  orgCounter += 1;
  const owner = privateKeyToAccount(generatePrivateKey());
  const res = await call(app, "POST", "/v1/orgs", {
    body: {
      legal_name: `${name} ${orgCounter}`,
      kind: "company",
      country: "us",
      contact_email: `ops+${orgCounter}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      owner_address: owner.address,
    },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  return { org: res.body.org, apiKey: res.body.api_key.secret, owner };
}

export async function createAgent(
  app: FastifyInstance,
  apiKey: string,
  name = "research-agent",
): Promise<Json> {
  const res = await call(app, "POST", "/v1/agents", { token: apiKey, body: { name } });
  if (res.status !== 201) throw new Error(`createAgent failed: ${res.status} ${res.text}`);
  return res.body;
}
