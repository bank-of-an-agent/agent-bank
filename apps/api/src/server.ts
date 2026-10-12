import { buildApp } from "./app";
import { loadConfig } from "./config";
import { startInProcessJobs } from "./jobs";
import { createLogger } from "./logger";
import { SimulatedIndexer } from "./dev/simulated-indexer";
import { createDeps } from "./wiring";

/**
 * HTTP entry point. Listens on `HOST:PORT` (0.0.0.0:8080), serves `/healthz`, and exits within
 * 30 s of SIGTERM (in-flight requests drain, the database pool closes).
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const deps = await createDeps(config, logger);
  const app = await buildApp(deps);
  // The simulated chain lives in this process: produce blocks and feed the reconciler here.
  const stopChain = deps.simulator
    ? new SimulatedIndexer(deps, deps.simulator).start(config.simulatedBlockTimeMs)
    : undefined;
  const stopJobs = config.runWorkerInProcess ? startInProcessJobs(deps) : undefined;
  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { port: config.port, chain: config.chain.name, cosigner: config.cosigner.mode },
    "api listening",
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    void (async () => {
      await stopJobs?.();
      await stopChain?.();
      await app.close();
      await deps.close?.();
      await deps.db.close();
      clearTimeout(force);
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
