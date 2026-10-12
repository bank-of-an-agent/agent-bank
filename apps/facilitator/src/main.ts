import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestnet, systemClock } from "@agentbank/core";
import { createSqlClient, loadMigrations, migrate, MIGRATIONS_DIR } from "@agentbank/db";
import { buildApp } from "./app";
import { createChainRuntime, type ChainRuntime } from "./chain";
import { loadConfig, type FacilitatorConfig } from "./config";
import { Facilitator, safeErrorMessage } from "./facilitator";
import { createLogger, type Logger } from "./logger";
import { Metrics } from "./metrics";
import { SandboxScreening } from "./screening";

/** Migrations ship next to the bundle (`dist/migrations`); from source they live in packages/db. */
function migrationsDir(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return existsSync(bundled) ? bundled : MIGRATIONS_DIR;
}

/**
 * Refuse to run against a node that serves another chain, mainnet above all. An unreachable
 * node is not fatal: every request then fails closed until it answers (the gateway re-checks
 * the chain id before its first call).
 */
async function checkRpcChain(
  runtime: ChainRuntime,
  config: FacilitatorConfig,
  logger: Logger,
): Promise<void> {
  if (!runtime.rpcChainId) return;
  let reported: number;
  try {
    reported = await runtime.rpcChainId();
  } catch (error) {
    logger.warn(
      { err: safeErrorMessage(error) },
      "chain RPC unreachable at startup; requests fail closed until it answers",
    );
    return;
  }
  assertTestnet(reported);
  if (reported !== config.chain.id) {
    throw new Error(
      `The RPC node serves chain ${reported}, but the facilitator is configured for ${config.chain.id}`,
    );
  }
}

/**
 * x402 facilitator server (port 8083). Fails fast on bad configuration (mainnet, missing
 * relayer key, ...); at runtime every dependency failure refuses the payment.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = await createSqlClient(config.databaseUrl, { max: 10, statementTimeoutMs: 5_000 });
  if (config.migrateOnStart) {
    const ran = await migrate(db, loadMigrations(migrationsDir()));
    logger.info({ migrations: ran }, ran.length > 0 ? "database migrated" : "database up to date");
  }
  const runtime = createChainRuntime(config);
  await checkRpcChain(runtime, config, logger);

  const metrics = new Metrics({ emfNamespace: config.metricsNamespace });
  const facilitator = new Facilitator({
    db,
    gateway: runtime.gateway,
    receipts: runtime.receipts,
    contractSignatures: runtime.contractSignatures,
    screening: new SandboxScreening(config.screening.denylist),
    clock: systemClock,
    relayer: config.relayer,
    metrics,
    logger,
    options: {
      chain: config.chain,
      asset: runtime.asset,
      settleBeforeServeAbove: config.settleBeforeServeAbove,
      maxSettlement: config.maxSettlement,
      receiptTimeoutMs: config.receiptTimeoutMs,
      screeningTimeoutMs: config.screening.timeoutMs,
    },
  });
  const app = buildApp({
    facilitator,
    metrics,
    logger,
    bodyLimitBytes: config.bodyLimitBytes,
    trustProxy: config.trustProxy,
  });

  // Resolve settlements whose receipt was not seen in time (or whose bookkeeping was cut short).
  let sweep: ReturnType<typeof setInterval> | undefined;
  if (config.staleSweepSeconds > 0) {
    let running = false;
    sweep = setInterval(() => {
      if (running) return;
      running = true;
      facilitator
        .sweepStale(config.staleSweepSeconds)
        .then((result) => {
          if (result.checked > 0) logger.info(result, "pending settlements checked");
        })
        .catch((error: unknown) =>
          logger.warn({ err: safeErrorMessage(error) }, "pending settlement sweep failed"),
        )
        .finally(() => {
          running = false;
        });
    }, config.staleSweepSeconds * 1000);
    sweep.unref();
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    if (sweep) clearInterval(sweep);
    try {
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    {
      network: config.chain.caip2,
      chain: config.chain.name,
      asset: runtime.asset.address,
      relayer: config.relayer?.address,
      settle_before_serve_above: facilitator.supported().kinds[0]?.extra?.settleBeforeServeAbove,
      max_settlement: config.maxSettlement?.toString(),
      facilitator_url: config.publicBaseUrl ? `${config.publicBaseUrl}/v1/x402` : undefined,
      app_env: config.appEnv,
    },
    "x402 facilitator listening",
  );
  if (config.chain.name === "simulated") {
    logger.warn("serving the in-memory simulated chain: development only, balances do not persist");
  }
}

main().catch((error: unknown) => {
  console.error("facilitator failed to start:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
