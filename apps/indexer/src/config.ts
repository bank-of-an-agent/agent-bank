import { CHAINS, chainByName, type ChainInfo } from "@agentbank/core";
import { z } from "zod";

/**
 * Environment configuration, validated at startup (fail fast). Secrets (`DATABASE_URL`,
 * `CHAIN_RPC_URL`, `INTERNAL_API_SHARED_SECRET`) come from the secret manager; nothing here has a
 * production default for a secret, and mainnet chains are impossible (`chainByName` re-checks).
 */

const DEV_SECRET = "dev-only-internal-secret-change-me";

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  HOST: z.string().default("0.0.0.0"),
  PORT: int(8082, 1, 65_535),
  DATABASE_URL: z.string().min(1, "DATABASE_URL (the indexer's own database) is required"),
  AGENTBANK_CHAIN: z.enum(["simulated", "anvil", "base-sepolia"]).optional(),
  CHAIN_ID: z.coerce.number().int().optional(),
  CHAIN_RPC_URL: optional,
  API_INTERNAL_URL: z.url({ message: "API_INTERNAL_URL must be the API's internal base URL" }),
  INTERNAL_API_SHARED_SECRET: z.string().min(16, "INTERNAL_API_SHARED_SECRET must be at least 16 characters"),
  RECONCILIATION_WINDOW: int(20, 1, 10_000),
  POLL_INTERVAL_MS: int(2_000, 100, 600_000),
  MAX_BLOCKS_PER_TICK: int(500, 1, 100_000),
  INGEST_BATCH_EVENTS: int(2_000, 1, 5_000),
  REORG_HISTORY_BLOCKS: int(256, 16, 100_000),
  WATCHLIST_REFRESH_MS: int(30_000, 1_000, 3_600_000),
  START_BLOCK: z.coerce.bigint().nonnegative().optional(),
  BALANCE_CHECK_HOUR_UTC: int(3, 0, 23),
  BALANCE_CHECK_CONTRACTS: z.enum(["exact", "at_least"]).default("at_least"),
  HTTP_TIMEOUT_MS: int(30_000, 1_000, 300_000),
  METRICS_NAMESPACE: optional,
  RECONCILIATION_METRICS_NS: optional,
});

export interface IndexerConfig {
  env: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  host: string;
  port: number;
  databaseUrl: string;
  chain: ChainInfo;
  rpcUrl: string | undefined;
  apiInternalUrl: string;
  internalSecret: string;
  windowBlocks: number;
  pollIntervalMs: number;
  maxBlocksPerTick: number;
  batchEvents: number;
  reorgHistory: number;
  watchlistRefreshMs: number;
  startBlock: bigint | undefined;
  balanceCheckHourUtc: number;
  balanceCheckContracts: "exact" | "at_least";
  httpTimeoutMs: number;
  metricsNamespace: string | undefined;
  reconciliationMetricsNamespace: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): IndexerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration:\n  ${parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("\n  ")}`,
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  // AGENTBANK_CHAIN wins; otherwise CHAIN_ID (set by the infrastructure) picks the chain.
  const byId =
    e.CHAIN_ID === undefined ? undefined : Object.values(CHAINS).find((c) => c.id === e.CHAIN_ID)?.name;
  if (e.CHAIN_ID !== undefined && !byId) problems.push(`CHAIN_ID: ${e.CHAIN_ID} is not a supported testnet`);
  const name = e.AGENTBANK_CHAIN ?? byId ?? "base-sepolia";
  let chain: ChainInfo = CHAINS["base-sepolia"];
  try {
    chain = chainByName(name);
  } catch (error) {
    problems.push(`AGENTBANK_CHAIN: ${(error as Error).message}`);
  }
  if (e.CHAIN_ID !== undefined && byId && e.CHAIN_ID !== chain.id) {
    problems.push(`CHAIN_ID ${e.CHAIN_ID} does not match AGENTBANK_CHAIN=${name}`);
  }
  if (chain.name !== "simulated" && !e.CHAIN_RPC_URL)
    problems.push(`CHAIN_RPC_URL: required on ${chain.name}`);
  const production = e.NODE_ENV === "production";
  if (production && chain.name === "simulated")
    problems.push("AGENTBANK_CHAIN: the simulated chain cannot be used in production");
  if (
    production &&
    (e.INTERNAL_API_SHARED_SECRET === DEV_SECRET || e.INTERNAL_API_SHARED_SECRET.length < 32)
  ) {
    problems.push(
      "INTERNAL_API_SHARED_SECRET: use a secret of at least 32 characters from the secret manager in production",
    );
  }
  if (problems.length > 0) throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    chain,
    rpcUrl: e.CHAIN_RPC_URL,
    apiInternalUrl: e.API_INTERNAL_URL.replace(/\/+$/, ""),
    internalSecret: e.INTERNAL_API_SHARED_SECRET,
    windowBlocks: e.RECONCILIATION_WINDOW,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    maxBlocksPerTick: e.MAX_BLOCKS_PER_TICK,
    batchEvents: e.INGEST_BATCH_EVENTS,
    reorgHistory: e.REORG_HISTORY_BLOCKS,
    watchlistRefreshMs: e.WATCHLIST_REFRESH_MS,
    startBlock: e.START_BLOCK,
    balanceCheckHourUtc: e.BALANCE_CHECK_HOUR_UTC,
    balanceCheckContracts: e.BALANCE_CHECK_CONTRACTS,
    httpTimeoutMs: e.HTTP_TIMEOUT_MS,
    metricsNamespace: e.METRICS_NAMESPACE,
    reconciliationMetricsNamespace: e.RECONCILIATION_METRICS_NS,
  };
}
