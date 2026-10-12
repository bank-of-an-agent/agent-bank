import {
  AddressSchema,
  assertTestnet,
  CHAINS,
  chainByName,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  type ChainInfo,
} from "@agentbank/core";
import { z } from "zod";

/**
 * Environment configuration, validated with Zod at startup (fail fast). Secrets only ever
 * come from the environment (populated by the secret manager); nothing here has a production
 * default for a secret. Mainnet is impossible: the chain is chosen by `AGENTBANK_CHAIN` (or the
 * infra's `CHAIN_ID`), only testnets are accepted, and the choice is re-checked with
 * `assertTestnet`.
 */

const DEV_COSIGNER_SECRET = "dev-only-shared-secret-change-me";

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1" || v === "yes"));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optionalUrl = z
  .url()
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const optionalAddress = AddressSchema.optional().or(z.literal("").transform(() => undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: optionalString,
  PORT: int(8080, 1, 65_535),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: bool(false),
  BODY_LIMIT_BYTES: int(1_048_576, 1_024, 10_485_760),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Default: true for PGlite (a fresh in-memory or file database), false for PostgreSQL. */
  MIGRATE_ON_START: z.enum(["true", "false", "1", "0", "yes", "no"]).optional(),

  AGENTBANK_CHAIN: z.enum(["simulated", "anvil", "base-sepolia"]).optional(),
  CHAIN_ID: z.coerce.number().int().positive().optional(),
  CHAIN_RPC_URL: optionalUrl,
  BASE_SEPOLIA_RPC_URL: optionalUrl,
  ANVIL_RPC_URL: optionalUrl,
  BUNDLER_URL: optionalUrl,
  PIMLICO_API_KEY: optionalString,
  PIMLICO_SPONSORSHIP_POLICY_ID: optionalString,
  REVENUE_ADDRESS: optionalAddress,
  /** Testnet gas wallet for permissionless calls (keepers, spend-key permits). */
  API_RELAYER_KEY: optionalString,
  /** Former name of API_RELAYER_KEY. */
  KEEPER_RELAYER_KEY: optionalString,
  AGENTBANK_DEPLOYMENT_JSON: optionalString,

  COSIGNER_URL: optionalUrl,
  /** `http` (default): the co-signer service at COSIGNER_URL. `inprocess`: local development only. */
  COSIGNER_MODE: z.enum(["http", "inprocess"]).default("http"),
  /** In-process co-signer key (testnet, development). Absent: a fresh key per process. */
  COSIGNER_DEV_PRIVATE_KEY: optionalString,
  /** In-process co-signer database (default: in-memory PGlite). */
  COSIGNER_DATABASE_URL: optionalString,
  COSIGNER_SHARED_SECRET: optionalString,
  COSIGNER_TIMEOUT_MS: int(3_000, 100, 60_000),
  SANDBOX_FAUCET_KEY: optionalString,
  SIMULATED_BLOCK_TIME_MS: int(2_000, 100, 60_000),
  COSIGNER_ADDRESS: optionalAddress,

  INTERNAL_API_SHARED_SECRET: optionalString,

  PUBLIC_BASE_URL: optionalUrl,
  CONSOLE_ORIGIN: optionalUrl,
  WEBAUTHN_RP_ID: optionalString,
  WEBAUTHN_RP_NAME: z.string().default("Agent Bank"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  CONSOLE_SESSION_TTL_SECONDS: int(12 * 3600, 300, 7 * 24 * 3600),
  STAFF_TOKEN: optionalString,

  ALLOW_OPEN_SIGNUP: bool(false),
  FEATURE_ESCROW: bool(true),
  FEATURE_STREAMS: bool(true),
  FEATURE_TREASURY_SWEEP: bool(false),

  RATE_LIMIT_PER_MINUTE: int(600, 1, 1_000_000),
  WEBHOOK_RETRY_SCHEDULE_SECONDS: optionalString,
  WEBHOOK_TIMEOUT_MS: int(10_000, 100, 60_000),
  WEBHOOK_ALLOW_INSECURE_URLS: z.enum(["true", "false"]).optional(),
  WEBHOOK_SIGNING_KEY: optionalString,
  /** Public base URL of apps/facilitator; sellers point x402 at `<it>/v1/x402`. */
  FACILITATOR_PUBLIC_URL: optionalUrl,
  PAY_LINK_BASE_URL: optionalUrl,

  PAYMENT_SIGNATURE_TTL_SECONDS: int(600, 60, 3_600),
  OWNER_OPERATION_TTL_SECONDS: int(900, 60, 3_600),
  X402_MAX_TIMEOUT_SECONDS: int(3_600, 6, 86_400),
  IDEMPOTENCY_STALE_SECONDS: int(120, 5, 3_600),

  SCREENING_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  SCREENING_DENYLIST: optionalString,
  SCREENING_API_KEY: optionalString,
  KYB_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  KYB_API_KEY: optionalString,

  AUDIT_LOG_BUCKET: optionalString,
  AUDIT_LOG_PREFIX: optionalString,
  METRICS_NAMESPACE: optionalString,

  /** Default: true when nothing else could run the jobs (simulated chain, in-process co-signer, PGlite). */
  RUN_WORKER_IN_PROCESS: z.enum(["true", "false", "1", "0", "yes", "no"]).optional(),
  VALIDATE_RESPONSES: z.enum(["true", "false"]).optional(),
});

export type Env = z.input<typeof EnvSchema>;

export interface Config {
  env: "development" | "test" | "production";
  appEnv: string;
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  trustProxy: boolean;
  bodyLimitBytes: number;
  databaseUrl: string;
  migrateOnStart: boolean;
  chain: ChainInfo;
  rpcUrl: string | undefined;
  bundlerUrl: string | undefined;
  pimlicoApiKey: string | undefined;
  pimlicoSponsorshipPolicyId: string | undefined;
  /** Address that receives Agent Bank fees (`sys:revenue`). */
  revenueAddress: `0x${string}`;
  /**
   * Testnet gas wallet (`API_RELAYER_KEY`) for permissionless calls: keeper calls (stream settle,
   * top-up, unlocked vault withdrawals, validator releases) and user-signed spend-key permits.
   * It never holds funds and cannot move anyone's.
   */
  relayerKey: `0x${string}` | undefined;
  /** Agent Bank contract deployment (contracts repo `deployments/<chainId>.json`), EVM chains. */
  deployment: Record<string, unknown> | undefined;
  /** `url` absent: every co-signer call fails closed (payments refused with `cosigner_unavailable`). */
  cosigner: {
    /** `inprocess`: `createCosigner` from `@agentbank/cosigner` in this process (development only). */
    mode: "http" | "inprocess";
    url: string | undefined;
    sharedSecret: string;
    timeoutMs: number;
    address: `0x${string}` | undefined;
    devPrivateKey: `0x${string}` | undefined;
    databaseUrl: string | undefined;
  };
  /** Anvil only: key that sends MockUSDC `mint` for `POST /v1/sandbox/faucet`. */
  sandboxFaucetKey: `0x${string}` | undefined;
  /** Simulated chain only: the development block producer's interval. */
  simulatedBlockTimeMs: number;
  /** HMAC secret for `/internal/*` (indexer → API). Absent: internal routes reject everything. */
  internalApiSecret: string | undefined;
  publicBaseUrl: string | undefined;
  consoleOrigin: string | undefined;
  webauthn: { rpId: string; rpName: string; origins: string[] };
  cookieSecure: boolean;
  consoleSessionTtlSeconds: number;
  staffToken: string | undefined;
  allowOpenSignup: boolean;
  features: { escrow: boolean; streams: boolean; treasurySweep: boolean };
  rateLimitPerMinute: number;
  webhookRetryScheduleSeconds: readonly number[];
  webhookTimeoutMs: number;
  webhookAllowInsecureUrls: boolean;
  /** Key that encrypts webhook endpoint secrets at rest (AES-256-GCM). Absent: stored as is (dev). */
  webhookSigningKey: string | undefined;
  /** The x402 facilitator endpoint sellers configure (`<FACILITATOR_PUBLIC_URL>/v1/x402`). */
  facilitatorUrl: string;
  payLinkBaseUrl: string;
  paymentSignatureTtlSeconds: number;
  ownerOperationTtlSeconds: number;
  x402MaxTimeoutSeconds: number;
  idempotencyStaleSeconds: number;
  screening: { provider: "sandbox"; denylist: string[]; apiKey: string | undefined };
  kyb: { provider: "sandbox"; apiKey: string | undefined };
  auditExport: { bucket: string; prefix: string } | undefined;
  metricsNamespace: string | undefined;
  runWorkerInProcess: boolean;
  validateResponses: boolean;
}

/** Placeholder revenue address used only on the in-memory simulated chain. */
export const SIMULATED_REVENUE_ADDRESS = "0x00000000000000000000000000000000000Fee00" as const;

function parseSchedule(raw: string | undefined): readonly number[] {
  if (!raw) return WEBHOOK_RETRY_SCHEDULE_SECONDS;
  const values = raw.split(",").map((s) => Number(s.trim()));
  if (values.length === 0 || values.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error("WEBHOOK_RETRY_SCHEDULE_SECONDS must be a comma-separated list of non-negative integers");
  }
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) < (values[i - 1] ?? 0)) {
      throw new Error("WEBHOOK_RETRY_SCHEDULE_SECONDS must be non-decreasing");
    }
  }
  return values;
}

/** Thrown when the environment is invalid; the message lists every problem. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Chain from `AGENTBANK_CHAIN` or the infra's numeric `CHAIN_ID` (they must agree when both are set). */
/** `<facilitator base>/v1/x402`, the URL sellers configure (accepts a value that already ends in it). */
export function x402FacilitatorUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/x402") ? trimmed : `${trimmed}/v1/x402`;
}

function selectChain(name: string | undefined, chainId: number | undefined): ChainInfo {
  if (chainId !== undefined) {
    const byId = assertTestnet(chainId); // mainnet ids throw mainnet_locked
    if (name !== undefined && CHAINS[name as keyof typeof CHAINS]?.id !== chainId) {
      throw new ConfigError(
        `Invalid configuration:\n  CHAIN_ID ${chainId} does not match AGENTBANK_CHAIN=${name}`,
      );
    }
    return byId;
  }
  return chainByName(name ?? "simulated");
}

/** Validate the environment and build the typed configuration. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  let chain: ChainInfo;
  try {
    chain = selectChain(e.AGENTBANK_CHAIN, e.CHAIN_ID);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Invalid configuration:\n  AGENTBANK_CHAIN/CHAIN_ID: ${(error as Error).message}`);
  }

  const problems: string[] = [];
  const secret = e.COSIGNER_SHARED_SECRET ?? "";
  if (e.COSIGNER_URL && secret.length < 16) {
    problems.push("COSIGNER_SHARED_SECRET: required (at least 16 characters) when COSIGNER_URL is set");
  }
  if (production && e.COSIGNER_URL && secret === DEV_COSIGNER_SECRET) {
    problems.push("COSIGNER_SHARED_SECRET: the development secret cannot be used in production");
  }
  if (production && e.COSIGNER_URL && secret.length < 32) {
    problems.push("COSIGNER_SHARED_SECRET: must be at least 32 characters in production");
  }
  if (e.COSIGNER_MODE === "inprocess") {
    if (production) problems.push("COSIGNER_MODE: inprocess is for local development only");
    if (chain.name !== "simulated" && chain.name !== "anvil") {
      problems.push("COSIGNER_MODE: inprocess runs only on the simulated chain or Anvil");
    }
    if (e.COSIGNER_URL) problems.push("COSIGNER_MODE: inprocess and COSIGNER_URL are mutually exclusive");
  }
  if (e.COSIGNER_DEV_PRIVATE_KEY !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(e.COSIGNER_DEV_PRIVATE_KEY)) {
    problems.push("COSIGNER_DEV_PRIVATE_KEY: must be a 32-byte hex key");
  }
  if (e.SANDBOX_FAUCET_KEY !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(e.SANDBOX_FAUCET_KEY))
      problems.push("SANDBOX_FAUCET_KEY: must be a 32-byte hex key");
    if (chain.name !== "anvil") problems.push("SANDBOX_FAUCET_KEY: Anvil only");
  }
  if (e.INTERNAL_API_SHARED_SECRET !== undefined && e.INTERNAL_API_SHARED_SECRET.length < 32 && production) {
    problems.push("INTERNAL_API_SHARED_SECRET: must be at least 32 characters in production");
  }
  if (e.STAFF_TOKEN !== undefined && e.STAFF_TOKEN.length < 32) {
    problems.push("STAFF_TOKEN: must be at least 32 characters");
  }
  if (e.WEBHOOK_SIGNING_KEY !== undefined && e.WEBHOOK_SIGNING_KEY.length < 32) {
    problems.push("WEBHOOK_SIGNING_KEY: must be at least 32 characters");
  }
  if (production && chain.name === "simulated") {
    problems.push("AGENTBANK_CHAIN/CHAIN_ID: the simulated chain cannot be used in production");
  }
  let rpcUrl: string | undefined;
  if (chain.name === "base-sepolia") {
    rpcUrl = e.CHAIN_RPC_URL ?? e.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) problems.push("CHAIN_RPC_URL: required on base-sepolia");
  } else if (chain.name === "anvil") {
    rpcUrl = e.CHAIN_RPC_URL ?? e.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
  }
  let revenueAddress = e.REVENUE_ADDRESS as `0x${string}` | undefined;
  if (!revenueAddress) {
    if (chain.name === "simulated") revenueAddress = SIMULATED_REVENUE_ADDRESS;
    else problems.push("REVENUE_ADDRESS: required on anvil and base-sepolia");
  }
  let relayerKey: `0x${string}` | undefined;
  const rawRelayerKey = e.API_RELAYER_KEY ?? e.KEEPER_RELAYER_KEY;
  if (rawRelayerKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(rawRelayerKey))
      problems.push("API_RELAYER_KEY: must be a 32-byte hex key");
    else relayerKey = rawRelayerKey as `0x${string}`;
  }
  let deployment: Record<string, unknown> | undefined;
  if (e.AGENTBANK_DEPLOYMENT_JSON) {
    try {
      deployment = JSON.parse(e.AGENTBANK_DEPLOYMENT_JSON) as Record<string, unknown>;
      if (Number(deployment.chainId) !== chain.id)
        problems.push("AGENTBANK_DEPLOYMENT_JSON: chainId does not match the chain");
    } catch {
      problems.push("AGENTBANK_DEPLOYMENT_JSON: must be the JSON of a contracts deployment file");
    }
  }
  let schedule: readonly number[] = WEBHOOK_RETRY_SCHEDULE_SECONDS;
  try {
    schedule = parseSchedule(e.WEBHOOK_RETRY_SCHEDULE_SECONDS);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (problems.length > 0) throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);

  const consoleOrigin = e.CONSOLE_ORIGIN ? new URL(e.CONSOLE_ORIGIN).origin : undefined;
  const publicBaseUrl = e.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const rpId = e.WEBAUTHN_RP_ID ?? (consoleOrigin ? new URL(consoleOrigin).hostname : "localhost");

  return {
    env: e.NODE_ENV,
    appEnv: e.APP_ENV ?? (production ? "sandbox" : e.NODE_ENV),
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    databaseUrl: e.DATABASE_URL,
    migrateOnStart:
      e.MIGRATE_ON_START === undefined
        ? e.DATABASE_URL.startsWith("pglite://")
        : ["true", "1", "yes"].includes(e.MIGRATE_ON_START),
    chain,
    rpcUrl,
    bundlerUrl: e.BUNDLER_URL,
    pimlicoApiKey: e.PIMLICO_API_KEY,
    pimlicoSponsorshipPolicyId: e.PIMLICO_SPONSORSHIP_POLICY_ID,
    revenueAddress: revenueAddress as `0x${string}`,
    relayerKey,
    deployment,
    cosigner: {
      mode: e.COSIGNER_MODE,
      url: e.COSIGNER_URL?.replace(/\/+$/, ""),
      sharedSecret: e.COSIGNER_MODE === "inprocess" && secret.length < 16 ? DEV_COSIGNER_SECRET : secret,
      timeoutMs: e.COSIGNER_TIMEOUT_MS,
      address: e.COSIGNER_ADDRESS as `0x${string}` | undefined,
      devPrivateKey: e.COSIGNER_DEV_PRIVATE_KEY as `0x${string}` | undefined,
      databaseUrl: e.COSIGNER_DATABASE_URL,
    },
    sandboxFaucetKey: e.SANDBOX_FAUCET_KEY as `0x${string}` | undefined,
    simulatedBlockTimeMs: e.SIMULATED_BLOCK_TIME_MS,
    internalApiSecret: e.INTERNAL_API_SHARED_SECRET,
    publicBaseUrl,
    consoleOrigin,
    webauthn: {
      rpId,
      rpName: e.WEBAUTHN_RP_NAME,
      origins: consoleOrigin ? [consoleOrigin] : ["http://localhost:3000"],
    },
    cookieSecure: e.COOKIE_SECURE === undefined ? production : e.COOKIE_SECURE === "true",
    consoleSessionTtlSeconds: e.CONSOLE_SESSION_TTL_SECONDS,
    staffToken: e.STAFF_TOKEN,
    allowOpenSignup: e.ALLOW_OPEN_SIGNUP,
    features: {
      escrow: e.FEATURE_ESCROW,
      streams: e.FEATURE_STREAMS,
      treasurySweep: e.FEATURE_TREASURY_SWEEP,
    },
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    webhookRetryScheduleSeconds: schedule,
    webhookTimeoutMs: e.WEBHOOK_TIMEOUT_MS,
    webhookAllowInsecureUrls:
      e.WEBHOOK_ALLOW_INSECURE_URLS === undefined ? !production : e.WEBHOOK_ALLOW_INSECURE_URLS === "true",
    webhookSigningKey: e.WEBHOOK_SIGNING_KEY,
    facilitatorUrl: x402FacilitatorUrl(e.FACILITATOR_PUBLIC_URL ?? "http://localhost:8083"),
    payLinkBaseUrl: (
      e.PAY_LINK_BASE_URL ??
      consoleOrigin ??
      publicBaseUrl ??
      "http://localhost:3000"
    ).replace(/\/+$/, ""),
    paymentSignatureTtlSeconds: e.PAYMENT_SIGNATURE_TTL_SECONDS,
    ownerOperationTtlSeconds: e.OWNER_OPERATION_TTL_SECONDS,
    x402MaxTimeoutSeconds: e.X402_MAX_TIMEOUT_SECONDS,
    idempotencyStaleSeconds: e.IDEMPOTENCY_STALE_SECONDS,
    screening: {
      provider: e.SCREENING_PROVIDER,
      denylist: (e.SCREENING_DENYLIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      apiKey: e.SCREENING_API_KEY,
    },
    kyb: { provider: e.KYB_PROVIDER, apiKey: e.KYB_API_KEY },
    auditExport: e.AUDIT_LOG_BUCKET
      ? { bucket: e.AUDIT_LOG_BUCKET, prefix: e.AUDIT_LOG_PREFIX ?? "api/" }
      : undefined,
    metricsNamespace: e.METRICS_NAMESPACE,
    runWorkerInProcess:
      e.RUN_WORKER_IN_PROCESS === undefined
        ? chain.name === "simulated" ||
          e.COSIGNER_MODE === "inprocess" ||
          e.DATABASE_URL.startsWith("pglite://")
        : ["true", "1", "yes"].includes(e.RUN_WORKER_IN_PROCESS),
    validateResponses: e.VALIDATE_RESPONSES === undefined ? !production : e.VALIDATE_RESPONSES === "true",
  };
}
