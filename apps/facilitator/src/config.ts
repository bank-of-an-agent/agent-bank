import {
  AddressSchema,
  assertTestnet,
  CHAINS,
  DecimalString,
  isAgentBankError,
  parseAmount,
  type ChainInfo,
} from "@agentbank/core";
import { getAddress, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { LogLevel } from "./logger";

/**
 * Environment configuration, validated with Zod at startup (fail fast; every problem is
 * listed). Secrets (`DATABASE_URL`, `FACILITATOR_RELAYER_KEY`, `SCREENING_API_KEY`) come from
 * the secret manager through the environment. The relayer key is turned into a viem account
 * immediately: the configuration object never holds the key, and no error message repeats it.
 * Mainnet is impossible: only testnet chains are accepted (`assertTestnet`), production may
 * only serve Base Sepolia, and `src/main.ts` re-checks the chain id the RPC node reports.
 */

/** Default relayer gas floor on JSON-RPC chains: 0.001 ETH (thousands of Base Sepolia settlements). */
export const DEFAULT_RELAYER_MIN_BALANCE_WEI = 1_000_000_000_000_000n;

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1" || v === "yes"));

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const optionalUrl = z
  .url()
  .optional()
  .or(z.literal("").transform(() => undefined));

const ChainSelector = z
  .string()
  .regex(
    /^(base-sepolia|anvil|simulated|eip155:[0-9]{1,15})$/,
    "must be base-sepolia, anvil, simulated or eip155:<chainId>",
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: optionalString,
  PORT: int(8083, 1, 65_535),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /**
   * Which proxies to trust for the client IP (rate limits): `false` (default), `true` (every
   * hop: the left-most X-Forwarded-For entry, which clients can forge), a hop count (`1` behind
   * the ALB: the address the load balancer saw) or a comma-separated list of proxy IPs/CIDRs.
   */
  TRUST_PROXY: optionalString,
  BODY_LIMIT_BYTES: int(65_536, 1_024, 1_048_576),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MIGRATE_ON_START: bool,

  /** The served network: `base-sepolia` (infra), `anvil` or `simulated` (development), or CAIP-2. */
  X402_NETWORK: ChainSelector.optional(),
  /** Fallback for `X402_NETWORK` (shared with the other services). */
  AGENTBANK_CHAIN: ChainSelector.optional(),
  /** Numeric chain id set by the infrastructure; must agree with the network. */
  CHAIN_ID: z.coerce.number().int().positive().optional(),
  CHAIN_RPC_URL: optionalUrl,
  BASE_SEPOLIA_RPC_URL: optionalUrl,
  ANVIL_RPC_URL: optionalUrl,
  /** USDC (or MockUSDC) on Anvil when it is not Base Sepolia's address (fork). */
  USDC_ADDRESS: AddressSchema.optional().or(z.literal("").transform(() => undefined)),

  FACILITATOR_RELAYER_KEY: optionalString,

  SCREENING_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  SCREENING_DENYLIST: optionalString,
  SCREENING_API_KEY: optionalString,

  /** Largest single settlement in USDC (decimal), e.g. "100.00". Unset: no cap. */
  MAX_SETTLEMENT: DecimalString.optional().or(z.literal("").transform(() => undefined)),
  /** Published in /supported: sellers settle before serving above this (USDC, decimal). */
  SETTLE_BEFORE_SERVE_ABOVE: DecimalString.default("1.00"),
  SETTLEMENT_RECEIPT_TIMEOUT_MS: int(20_000, 0, 120_000),
  SCREENING_TIMEOUT_MS: int(5_000, 100, 60_000),
  /** Interval of the sweep that resolves unconfirmed settlements (0 disables it). */
  STALE_SETTLEMENT_SWEEP_SECONDS: int(60, 0, 3_600),

  /** Per client IP and minute. Settle is stricter: every settlement costs relayer gas. */
  RATE_LIMIT_VERIFY_PER_MINUTE: int(300, 1, 1_000_000),
  RATE_LIMIT_SETTLE_PER_MINUTE: int(60, 1, 1_000_000),
  /** Settle requests one process handles at once; more get 503 facilitator_busy. */
  MAX_INFLIGHT_SETTLEMENTS: int(16, 1, 10_000),
  /** `any` | `registered` (only Agent Bank accounts in x402_payee). Required `registered` when APP_ENV=production. */
  FACILITATOR_PAYEE_MODE: z.enum(["any", "registered"]).optional(),
  /** Refuse to settle below this relayer ETH balance (wei; 0 only reports it). Default 0.001 ETH. */
  RELAYER_MIN_BALANCE_WEI: z
    .string()
    .regex(/^[0-9]{1,30}$/, "must be a non-negative integer number of wei")
    .optional(),

  PUBLIC_BASE_URL: optionalUrl,
  METRICS_NAMESPACE: optionalString,
});

export interface FacilitatorConfig {
  env: "development" | "test" | "production";
  appEnv: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  /** Fastify `trustProxy`: false, true, a hop count or a list of proxy addresses. */
  trustProxy: boolean | number | string;
  bodyLimitBytes: number;
  databaseUrl: string;
  migrateOnStart: boolean;
  chain: ChainInfo;
  /** JSON-RPC endpoint (Base Sepolia, Anvil); undefined for the in-memory simulator. */
  rpcUrl: string | undefined;
  /** USDC override for Anvil. */
  usdcAddress: Address | undefined;
  /** The relayer that pays gas for settlements (testnet key). Never the raw key. */
  relayer: LocalAccount | undefined;
  screening: { provider: "sandbox"; denylist: string[]; apiKey: string | undefined; timeoutMs: number };
  maxSettlement: bigint | undefined;
  settleBeforeServeAbove: bigint;
  receiptTimeoutMs: number;
  staleSweepSeconds: number;
  rateLimit: { verifyPerMinute: number; settlePerMinute: number };
  maxInflightSettlements: number;
  payeeMode: "any" | "registered";
  /** Relayer gas floor (wei); unused on the simulator, which has no gas. */
  relayerMinBalanceWei: bigint;
  publicBaseUrl: string | undefined;
  metricsNamespace: string | undefined;
}

/** Thrown when the environment is invalid; the message lists every problem (never a secret). */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid facilitator configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

/** `TRUST_PROXY` → Fastify's `trustProxy`; `undefined` when the value is not understood. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "false" || value === "no" || value === "0") return false;
  if (value === "true" || value === "yes") return true;
  if (/^[0-9]{1,2}$/.test(value)) return Number(value);
  const entries = value.split(",").map((e) => e.trim());
  if (entries.every((e) => /^[0-9a-f:.]+(\/[0-9]{1,3})?$/.test(e) && /[.:]/.test(e)))
    return entries.join(",");
  return undefined;
}

function chainFromSelector(selector: string): ChainInfo {
  const caip = /^eip155:([0-9]+)$/.exec(selector);
  if (caip) return assertTestnet(Number(caip[1]));
  return assertTestnet(CHAINS[selector as keyof typeof CHAINS].id);
}

/** Validate the environment and build the typed configuration. Throws {@link ConfigError}. */
export function loadConfig(env: Record<string, string | undefined> = process.env): FacilitatorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Zod messages describe the rule, never the value, so secrets cannot leak through here.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const problems: string[] = [];

  // --- chain: testnet only ------------------------------------------------------------------
  let chain: ChainInfo | undefined;
  const selector = e.X402_NETWORK ?? e.AGENTBANK_CHAIN;
  try {
    if (e.CHAIN_ID !== undefined) assertTestnet(e.CHAIN_ID);
    chain = selector
      ? chainFromSelector(selector)
      : e.CHAIN_ID !== undefined
        ? assertTestnet(e.CHAIN_ID)
        : CHAINS.simulated;
    if (e.CHAIN_ID !== undefined && e.CHAIN_ID !== chain.id) {
      problems.push(`CHAIN_ID ${e.CHAIN_ID} does not match X402_NETWORK/AGENTBANK_CHAIN (${chain.caip2})`);
    }
  } catch (error) {
    problems.push(`X402_NETWORK/CHAIN_ID: ${isAgentBankError(error) ? error.message : String(error)}`);
  }
  if (chain && production && chain.name !== "base-sepolia") {
    problems.push(
      `X402_NETWORK: production serves Base Sepolia only (eip155:${CHAINS["base-sepolia"].id}), not ${chain.caip2}`,
    );
  }

  let rpcUrl: string | undefined;
  if (chain?.name === "base-sepolia") {
    rpcUrl = e.CHAIN_RPC_URL ?? e.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) problems.push("CHAIN_RPC_URL: required on base-sepolia");
  } else if (chain?.name === "anvil") {
    rpcUrl = e.CHAIN_RPC_URL ?? e.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
  }

  // --- relayer: a testnet key, required wherever a real transaction is sent -----------------
  let relayer: LocalAccount | undefined;
  if (e.FACILITATOR_RELAYER_KEY !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(e.FACILITATOR_RELAYER_KEY)) {
      problems.push(
        "FACILITATOR_RELAYER_KEY: must be a 0x-prefixed 32-byte hex private key (testnet gas wallet)",
      );
    } else {
      try {
        relayer = privateKeyToAccount(e.FACILITATOR_RELAYER_KEY as `0x${string}`);
      } catch {
        problems.push("FACILITATOR_RELAYER_KEY: not a valid secp256k1 private key");
      }
    }
  } else if (chain && chain.name !== "simulated") {
    problems.push(
      `FACILITATOR_RELAYER_KEY: required on ${chain.name} (the relayer pays gas for transferWithAuthorization)`,
    );
  }

  // --- database -------------------------------------------------------------------------------
  const inProcessDb = e.DATABASE_URL === "pglite://memory" || e.DATABASE_URL.startsWith("pglite:");
  if (production && inProcessDb) {
    problems.push(
      "DATABASE_URL: production needs PostgreSQL (the single-use authorization log must be shared and durable)",
    );
  }

  // --- screening --------------------------------------------------------------------------------
  const denylist = (e.SCREENING_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const badEntries = denylist.filter((a) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (badEntries.length > 0) problems.push(`SCREENING_DENYLIST: not addresses: ${badEntries.join(", ")}`);

  // --- abuse protection -------------------------------------------------------------------------
  const trustProxy = parseTrustProxy(e.TRUST_PROXY);
  if (trustProxy === undefined) {
    problems.push(
      "TRUST_PROXY: must be true, false, a hop count or a comma-separated list of proxy IPs/CIDRs",
    );
  }
  const appEnvRaw = e.APP_ENV ?? (production ? "sandbox" : e.NODE_ENV);
  let payeeMode = e.FACILITATOR_PAYEE_MODE ?? (appEnvRaw === "production" ? "registered" : "any");
  if (appEnvRaw === "production" && payeeMode !== "registered") {
    problems.push("FACILITATOR_PAYEE_MODE: must be registered when APP_ENV=production");
    payeeMode = "registered";
  }
  const relayerMinBalanceWei =
    e.RELAYER_MIN_BALANCE_WEI !== undefined
      ? BigInt(e.RELAYER_MIN_BALANCE_WEI)
      : DEFAULT_RELAYER_MIN_BALANCE_WEI;

  // --- amounts ----------------------------------------------------------------------------------
  const maxSettlement = e.MAX_SETTLEMENT !== undefined ? parseAmount(e.MAX_SETTLEMENT, 6) : undefined;
  if (maxSettlement !== undefined && maxSettlement <= 0n)
    problems.push("MAX_SETTLEMENT: must be greater than zero");
  const settleBeforeServeAbove = parseAmount(e.SETTLE_BEFORE_SERVE_ABOVE, 6);

  if (problems.length > 0 || !chain) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    appEnv: appEnvRaw,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxy: trustProxy ?? false,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    databaseUrl: e.DATABASE_URL,
    // An in-process database starts empty, so it is always migrated.
    migrateOnStart: e.MIGRATE_ON_START ?? inProcessDb,
    chain,
    rpcUrl,
    usdcAddress: e.USDC_ADDRESS ? getAddress(e.USDC_ADDRESS.toLowerCase()) : undefined,
    relayer,
    screening: {
      provider: e.SCREENING_PROVIDER,
      denylist,
      apiKey: e.SCREENING_API_KEY,
      timeoutMs: e.SCREENING_TIMEOUT_MS,
    },
    maxSettlement,
    settleBeforeServeAbove,
    receiptTimeoutMs: e.SETTLEMENT_RECEIPT_TIMEOUT_MS,
    staleSweepSeconds: e.STALE_SETTLEMENT_SWEEP_SECONDS,
    rateLimit: {
      verifyPerMinute: e.RATE_LIMIT_VERIFY_PER_MINUTE,
      settlePerMinute: e.RATE_LIMIT_SETTLE_PER_MINUTE,
    },
    maxInflightSettlements: e.MAX_INFLIGHT_SETTLEMENTS,
    payeeMode,
    relayerMinBalanceWei,
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
    metricsNamespace: e.METRICS_NAMESPACE,
  };
}
