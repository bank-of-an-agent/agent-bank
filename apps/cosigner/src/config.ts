import {
  AddressSchema,
  chainByName,
  ChainNameSchema,
  DecimalString,
  parseAmount,
  type ChainInfo,
} from "@agentbank/core";
import { getAddress, type Address } from "viem";
import { z } from "zod";

/** The example secret from `.env.example`; refused in production. */
const EXAMPLE_SECRET = "dev-only-shared-secret-change-me";

/**
 * Boolean flags fail safe: only an explicit false value ("false", "0", "no",
 * "off" or empty) turns a flag off. Anything else, including typos, is true,
 * which for `COSIGNER_FAIL_CLOSED` means refusing everything.
 */
const FailSafeFlag = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined ? false : !["", "false", "0", "no", "off"].includes(v.trim().toLowerCase()),
  );

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  AGENTBANK_CHAIN: ChainNameSchema.default("simulated"),
  COSIGNER_SHARED_SECRET: z.string().min(32, "COSIGNER_SHARED_SECRET must be at least 32 characters"),
  COSIGNER_DATABASE_URL: z.string().min(1, "COSIGNER_DATABASE_URL is required"),
  COSIGNER_SIGNER: z.enum(["local", "kms"]).default("local"),
  COSIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "COSIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key")
    .optional(),
  COSIGNER_KMS_KEY_ID: z.string().optional(),
  COSIGNER_KMS_ENDPOINT: z.url().optional(),
  AWS_REGION: z.string().optional(),
  COSIGNER_FAIL_CLOSED: FailSafeFlag,
  COSIGNER_REVENUE_ADDRESS: AddressSchema,
  COSIGNER_MAX_FEE_SWEEP: DecimalString.default("100.00"),
  /** JSON object of Agent Bank contract addresses on the chain, e.g. {"escrow":"0x…","streams":"0x…"}. */
  COSIGNER_CONTRACTS: z.string().optional(),
  /** CloudWatch EMF namespace (e.g. "AgentBank/Cosigner"); unset disables EMF log lines. */
  METRICS_NAMESPACE: z.string().optional(),
  /** EIP-712 domain chain id of owner authorizations (the API's `GET /v1/meta`); default: the chain's id. */
  OWNER_AUTHORIZATION_CHAIN_ID: z.coerce.number().int().positive().optional(),
});

export interface CosignerConfig {
  nodeEnv: string;
  port: number;
  host: string;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  chain: ChainInfo;
  sharedSecret: string;
  databaseUrl: string;
  signer: {
    kind: "local" | "kms";
    privateKey?: string | undefined;
    kmsKeyId?: string | undefined;
    kmsEndpoint?: string | undefined;
    awsRegion?: string | undefined;
  };
  failClosed: boolean;
  revenueAddress: Address;
  /** Largest fee sweep (accrued fees) one operation may carry to the revenue address, minor units. */
  maxFeeSweep: bigint;
  /** Agent Bank contracts (escrow, streams, …) for chains where they are configured by deployment. */
  contracts: Record<string, Address>;
  /** CloudWatch Embedded Metric Format namespace, when metrics are shipped through logs. */
  metricsNamespace?: string | undefined;
  /** EIP-712 domain chain id owner authorizations are signed for. */
  ownerAuthorizationChainId: number;
}

const ContractsSchema = z.partialRecord(
  z.enum(["escrow", "streams", "vaults", "policyHook", "topUpExecutor", "sweepExecutor"]),
  AddressSchema,
);

/** Parse and validate the environment. Throws with every problem listed (fail fast at startup). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CosignerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid co-signer configuration:\n  ${issues.join("\n  ")}`);
  }
  const e = parsed.data;
  const nodeEnv = e.NODE_ENV ?? "development";
  const production = nodeEnv === "production";
  const problems: string[] = [];

  const chain = chainByName(e.AGENTBANK_CHAIN);
  if (production && e.COSIGNER_SIGNER !== "kms") problems.push("COSIGNER_SIGNER must be kms in production");
  if (e.COSIGNER_SIGNER === "kms" && !e.COSIGNER_KMS_KEY_ID)
    problems.push("COSIGNER_KMS_KEY_ID is required for kms");
  if (e.COSIGNER_SIGNER === "local" && !e.COSIGNER_PRIVATE_KEY) {
    problems.push("COSIGNER_PRIVATE_KEY is required for the local (testnet/development) signer");
  }
  if (production && e.COSIGNER_SHARED_SECRET === EXAMPLE_SECRET) {
    problems.push("COSIGNER_SHARED_SECRET is the example value; set a real secret from the secret manager");
  }
  if (production && (e.COSIGNER_DATABASE_URL.startsWith("pglite:") || e.COSIGNER_DATABASE_URL === "")) {
    problems.push(
      "COSIGNER_DATABASE_URL must be PostgreSQL in production (spend history must survive restarts)",
    );
  }
  let contracts: Record<string, Address> = {};
  if (e.COSIGNER_CONTRACTS) {
    try {
      const raw = ContractsSchema.parse(JSON.parse(e.COSIGNER_CONTRACTS));
      contracts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, getAddress(v)]));
    } catch (error) {
      problems.push(
        `COSIGNER_CONTRACTS must be a JSON object of contract addresses (${(error as Error).message})`,
      );
    }
  }
  if (problems.length > 0) throw new Error(`Invalid co-signer configuration:\n  ${problems.join("\n  ")}`);

  return {
    nodeEnv,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    chain,
    sharedSecret: e.COSIGNER_SHARED_SECRET,
    databaseUrl: e.COSIGNER_DATABASE_URL,
    signer: {
      kind: e.COSIGNER_SIGNER,
      privateKey: e.COSIGNER_PRIVATE_KEY,
      kmsKeyId: e.COSIGNER_KMS_KEY_ID,
      kmsEndpoint: e.COSIGNER_KMS_ENDPOINT,
      awsRegion: e.AWS_REGION,
    },
    failClosed: e.COSIGNER_FAIL_CLOSED,
    revenueAddress: getAddress(e.COSIGNER_REVENUE_ADDRESS),
    maxFeeSweep: parseAmount(e.COSIGNER_MAX_FEE_SWEEP, 6),
    contracts,
    metricsNamespace: e.METRICS_NAMESPACE?.trim() || undefined,
    ownerAuthorizationChainId: e.OWNER_AUTHORIZATION_CHAIN_ID ?? chain.id,
  };
}
