import { SimulatedChain } from "@agentbank/chain/simulated";
import { CHAINS, getAsset } from "@agentbank/core";
import { createSqlClient, loadMigrations, migrate, MIGRATIONS_DIR, type SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { createCosigner, LocalSigner, type Cosigner } from "@agentbank/cosigner";
import { PostgresLedger, type Ledger } from "@agentbank/ledger";
import type { Reconciler } from "@agentbank/reconciliation";
import {
  buildApp as buildFacilitatorApp,
  Facilitator,
  SandboxScreening as FacilitatorScreening,
  simulatedReceipts,
} from "../../../apps/facilitator/src/index";
import type { FastifyInstance } from "fastify";
import { getAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../../apps/api/src/app";
import { loadConfig, type Config } from "../../../apps/api/src/config";
import type { AppDeps } from "../../../apps/api/src/deps";
import { JOBS, runJob } from "../../../apps/api/src/jobs/index";
import { createLogger, type Logger } from "../../../apps/api/src/logger";
import { SandboxKyb } from "../../../apps/api/src/providers/kyb";
import { SandboxScreening } from "../../../apps/api/src/providers/screening";
import { createApiReconciler } from "../../../apps/api/src/wiring";
import {
  Indexer,
  IndexerStore,
  migrateIndexer,
  HttpReconcilerTransport,
} from "../../../apps/indexer/src/index";
import { freePort, LOOPBACK } from "./net";
import { WorldClock } from "./world-clock";

/**
 * The whole Agent Bank stack in one process, on random ports, over real HTTP:
 *
 * - one {@link SimulatedChain} shared by every service (its own clock, short finality);
 * - `apps/api` (`buildApp`) with PGlite (or `DATABASE_URL`), the Postgres ledger, the real
 *   in-process co-signer (`@agentbank/cosigner`, its own PGlite database) reached through its
 *   in-process client, and the real reconciler mounted on `/internal/*`;
 * - `apps/indexer`'s real `Indexer` loop against the same chain, pushing normalized events to
 *   the API's internal routes over HTTP (HMAC-signed, as in production);
 * - `apps/facilitator`'s `Facilitator` sharing the same chain, on its own port and PGlite;
 * - the API's background jobs (receipts, settlement, webhooks, expiry, keepers, auto-save),
 *   run on a fast pump so settlement, approvals and fees progress on their own.
 *
 * A background driver mines blocks, runs one indexer tick and one pass of the jobs on a short
 * interval, so clients that poll for settlement (the SDKs, the MCP tools) see it happen. Clients
 * are the real SDKs over HTTP. `startStack()` / `stopStack()` bring it up and tear it down.
 */

export interface StartStackOptions {
  /** `simulated` (default) or `base-sepolia`; falls back to `E2E_CHAIN`. */
  chain?: "simulated" | "base-sepolia";
  /** `memory` (default) or `postgres`: the bank ledger engine over the same database. */
  ledger?: "memory" | "postgres";
  /** Bank database URL (default: in-memory PGlite; `DATABASE_URL` wins when set). */
  databaseUrl?: string;
  /** Fixed API port (default: a free port). The long-running sandbox pins 8080. */
  apiPort?: number;
  /** Fixed facilitator port (default: a free port). The sandbox pins 8083. */
  facilitatorPort?: number;
  /** How many blocks finality lags (default 3; the sandbox and scenarios keep it short). */
  finalityDepth?: number;
  /** Driver interval in ms (default 20; higher for the sandbox to spare the CPU). */
  driverIntervalMs?: number;
  /**
   * Use the raw `DATABASE_URL` as the bank database (the long-running sandbox, which persists).
   * Tests leave this off: each gets an isolated schema (on CI's Postgres) or a fresh PGlite.
   */
  persistentDb?: boolean;
  logLevel?: "silent" | "error" | "warn" | "info" | "debug";
  /** Extra API env overrides (feature flags, denylist, …). */
  env?: Record<string, string>;
}

export interface Stack {
  /** Which chain the stack runs on. */
  readonly chainName: "simulated" | "base-sepolia";
  /** Whether the clock can be moved (only on the simulated chain). */
  readonly canTimeTravel: boolean;
  /** The in-memory chain (simulated only): faucet, balances, time, reorg injection. */
  readonly sim: SimulatedChain;
  /** The world clock every service and the SDKs share. */
  readonly clock: WorldClock;
  readonly config: Config;
  readonly deps: AppDeps;
  /** The reconciler mounted in the API (full interface, incl. `verify`/`stats`). */
  readonly reconciler: Reconciler;
  readonly ledger: Ledger;
  readonly cosigner: Cosigner;
  readonly api: FastifyInstance;
  readonly facilitator: FastifyInstance;
  readonly indexer: Indexer;
  /** API base URL, e.g. `http://127.0.0.1:8080` (also `PUBLIC_BASE_URL`, so RFC 9421 matches). */
  readonly apiUrl: string;
  /** Facilitator base the SDK paywall points at: `<facilitator>/v1/x402`. */
  readonly facilitatorUrl: string;
  readonly chainId: number;
  readonly logger: Logger;
  /** Run one driver step now (mine, index, jobs) and wait for it — tests use it to hurry settlement. */
  pump(): Promise<void>;
  /** Stop the background driver (the indexer loop and jobs), as if the indexer were offline. */
  pauseDriver(): Promise<void>;
  /** Restart the background driver after {@link pauseDriver}. */
  resumeDriver(): void;
  /** The reconciler's view of what every watched address must hold on-chain (global invariants). */
  expectedOnChain(): Promise<{ address: string; onchain: bigint; expected: bigint }[]>;
  /** On-chain USDC balance of an address (chain-agnostic). */
  balanceOf(address: string): Promise<bigint>;
  /** Put USDC on an address: a faucet mint (simulated) or a funder transfer (Base Sepolia). */
  fund(address: string, minor: bigint): Promise<void>;
  stopStack(): Promise<void>;
}

/** The API's background jobs, run far more often than production for a fast test loop. */
async function runJobsOnce(deps: AppDeps): Promise<void> {
  for (const job of JOBS) {
    try {
      await runJob(deps, job);
    } catch {
      // runJob already logs; never let one job stop the pump.
    }
  }
}

export async function startStack(options: StartStackOptions = {}): Promise<Stack> {
  const chain = options.chain ?? (process.env.E2E_CHAIN === "base-sepolia" ? "base-sepolia" : "simulated");
  if (chain === "base-sepolia") {
    const { startBaseSepoliaStack } = await import("./stack-base-sepolia");
    return startBaseSepoliaStack(options);
  }
  const clock = new WorldClock();
  const logLevel = options.logLevel ?? "silent";
  const logger = createLogger(logLevel);
  const chainId = CHAINS.simulated.id;
  const finalityDepth = options.finalityDepth ?? 3;
  // Share the world clock with the chain: block timestamps follow it, so advancing the world
  // (approvals expiring, loosening/unfreeze delays, stream accrual) advances on-chain time too.
  const sim = new SimulatedChain({ chainId, clock, safeDepth: 1, finalityDepth, automine: true });
  clock.raiseTo(sim.head.timestamp * 1000);

  const apiPort = options.apiPort ?? (await freePort());
  const facilitatorPort = options.facilitatorPort ?? (await freePort());
  const apiUrl = `http://${LOOPBACK}:${apiPort}`;
  const facilitatorBase = `http://${LOOPBACK}:${facilitatorPort}`;
  const facilitatorUrl = `${facilitatorBase}/v1/x402`;
  const internalSecret = "e2e-internal-shared-secret-0123456789abcdef";
  const cosignerSecret = "e2e-cosigner-shared-secret-0123456789abcdef";

  const databaseUrl = process.env.DATABASE_URL ?? options.databaseUrl ?? "pglite://memory";
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    AGENTBANK_CHAIN: "simulated",
    COSIGNER_SHARED_SECRET: cosignerSecret,
    INTERNAL_API_SHARED_SECRET: internalSecret,
    ALLOW_OPEN_SIGNUP: "true",
    PUBLIC_BASE_URL: apiUrl,
    FACILITATOR_PUBLIC_URL: facilitatorUrl,
    PAY_LINK_BASE_URL: apiUrl,
    RATE_LIMIT_PER_MINUTE: "1000000",
    LOG_LEVEL: logLevel,
    RUN_WORKER_IN_PROCESS: "false",
    ...options.env,
  });

  // The bank database (ledger + API rows), migrated. Tests get an isolated schema on a real
  // PostgreSQL (so parallel files never collide) or a fresh in-memory PGlite; the sandbox uses
  // the raw DATABASE_URL so its data persists.
  const db: SqlClient = options.persistentDb
    ? await createSqlClient(databaseUrl, { statementTimeoutMs: 30_000 })
    : await createTestDatabase();
  if (options.persistentDb) await migrate(db, loadMigrations(MIGRATIONS_DIR));

  // The real co-signer, its own PGlite database, reached through its in-process client.
  const cosignerDb = await createSqlClient(undefined);
  const signer = LocalSigner.create({ privateKey: generatePrivateKey(), chainId, nodeEnv: "test" });
  const cosigner = await createCosigner({
    db: cosignerDb,
    signer,
    chain: sim.gateway,
    sharedSecret: cosignerSecret,
    revenueAddress: config.revenueAddress,
    clock,
  });

  const ledger: Ledger = new PostgresLedger(db, { clock });
  const base = {
    config,
    db,
    ledger,
    chain: sim.gateway,
    cosigner: cosigner.client,
    clock,
    screening: new SandboxScreening(config.screening.denylist),
    kyb: new SandboxKyb(),
    logger,
    simulator: sim,
  };
  const deps: AppDeps = {
    ...base,
    reconciler: createApiReconciler(base),
    close: async () => {
      await cosigner.close();
      await cosignerDb.close();
    },
  };
  const api = await buildApp(deps);
  await api.listen({ host: LOOPBACK, port: apiPort });

  // The x402 facilitator over the same chain, its own PGlite database.
  const facilitatorDb = await createSqlClient(undefined);
  await migrate(facilitatorDb, loadMigrations(MIGRATIONS_DIR));
  const facilitatorService = new Facilitator({
    db: facilitatorDb,
    gateway: sim.gateway,
    receipts: simulatedReceipts(sim),
    screening: new FacilitatorScreening(config.screening.denylist),
    clock,
    options: {
      chain: CHAINS.simulated,
      asset: getAsset(chainId, "USDC"),
      payeeMode: "any",
      receiptTimeoutMs: 5_000,
    },
  });
  const facilitator = await buildFacilitatorApp({
    facilitator: facilitatorService,
    disableRequestLogging: logLevel === "silent",
    rateLimits: false,
  });
  await facilitator.listen({ host: LOOPBACK, port: facilitatorPort });

  // The real indexer loop against the same chain, pushing to the API's internal routes over HTTP.
  const indexerDb = await createSqlClient(undefined);
  await migrateIndexer(indexerDb);
  const transport = new HttpReconcilerTransport({
    baseUrl: apiUrl,
    secret: internalSecret,
    now: () => clock.nowSeconds(),
  });
  const indexer = new Indexer({
    chain: sim.gateway,
    transport,
    store: new IndexerStore(indexerDb, chainId, () => clock.now()),
    windowBlocks: 20,
    startBlock: 0n,
    clock,
    maxBlocksPerTick: 2_000,
    watchlistRefreshMs: 0, // always refresh: new accounts are watched (and backfilled) at once
  });

  let stepInFlight: Promise<void> | null = null;
  const step = async (): Promise<void> => {
    // One block advances finality; automine already mined any submitted operations.
    sim.mine(1);
    clock.raiseTo(sim.head.timestamp * 1000);
    await indexer.tick();
    await runJobsOnce(deps);
  };
  const runStep = (): Promise<void> => {
    if (stepInFlight) return stepInFlight;
    stepInFlight = step()
      .catch((error) => logger.error({ err: error }, "e2e driver step failed"))
      .finally(() => {
        stepInFlight = null;
      });
    return stepInFlight;
  };
  const intervalMs = options.driverIntervalMs ?? 20;
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => void runStep(), intervalMs);
  timer.unref();

  const reconciler = deps.reconciler as unknown as Reconciler;
  const stack: Stack = {
    chainName: "simulated",
    canTimeTravel: true,
    sim,
    clock,
    config,
    deps,
    reconciler,
    ledger,
    cosigner,
    api,
    facilitator,
    indexer,
    apiUrl,
    facilitatorUrl,
    chainId,
    logger,
    async pump() {
      // Two steps so a block mined in the first is indexed and its jobs run in the second.
      await runStep();
      await runStep();
    },
    async pauseDriver() {
      if (timer) clearInterval(timer);
      timer = null;
      await stepInFlight?.catch(() => undefined);
    },
    resumeDriver() {
      if (timer) return;
      timer = setInterval(() => void runStep(), intervalMs);
      timer.unref();
    },
    async balanceOf(address: string) {
      return sim.balanceOf(getAddress(address));
    },
    async fund(address: string, minor: bigint) {
      sim.faucet(getAddress(address), minor);
    },
    async expectedOnChain() {
      const list = await reconciler.watchlist();
      const addresses = list.addresses.map((a) => a.address);
      const expected = await reconciler.expectedBalances({ chain_id: chainId, addresses });
      const byAddress = new Map(expected.balances.map((b) => [b.address.toLowerCase(), BigInt(b.expected)]));
      return addresses.map((address) => ({
        address,
        onchain: sim.balanceOf(getAddress(address)),
        expected: byAddress.get(address.toLowerCase()) ?? 0n,
      }));
    },
    async stopStack() {
      if (timer) clearInterval(timer);
      await stepInFlight?.catch(() => undefined);
      await indexer.stop().catch(() => undefined);
      await api.close().catch(() => undefined);
      await facilitator.close().catch(() => undefined);
      await deps.close?.().catch(() => undefined);
      await db.close().catch(() => undefined);
      await facilitatorDb.close().catch(() => undefined);
      await indexerDb.close().catch(() => undefined);
    },
  };
  return stack;
}
