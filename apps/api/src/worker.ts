import { PgBoss } from "pg-boss";
import { loadConfig } from "./config";
import { JOBS, runJob } from "./jobs";
import { createLogger } from "./logger";
import { createDeps } from "./wiring";

/**
 * Background worker entry point (`dist/worker.js`). Every job in `src/jobs` gets a pg-boss
 * queue; a ticker sends one throttled job per period (pg-boss dedupes across worker
 * instances), and a handler runs it. Job names: see `JOBS` (e.g. `webhooks-deliver`,
 * `operations-receipts`, `payments-expire`, `streams-settle`, `billing-subscriptions`,
 * `proofs-roots`, `proofs-reservations`).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  if (config.databaseUrl.startsWith("pglite://")) {
    throw new Error("The worker needs PostgreSQL; with PGlite run the API with RUN_WORKER_IN_PROCESS=true");
  }
  if (config.chain.name === "simulated" || config.cosigner.mode === "inprocess") {
    // The simulated chain and the in-process co-signer live in the API process.
    throw new Error(
      "Run the jobs inside the API (RUN_WORKER_IN_PROCESS=true) with a simulated chain or in-process co-signer",
    );
  }
  const deps = await createDeps(config, logger);
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: "pgboss",
    application_name: "agentbank-worker",
  });
  boss.on("error", (error: unknown) => logger.error({ err: error }, "pg-boss error"));
  await boss.start();
  for (const job of JOBS) {
    await boss.createQueue(job.name, { expireInSeconds: Math.max(60, job.everySeconds * 4), retryLimit: 0 });
    await boss.work(
      job.name,
      { pollingIntervalSeconds: Math.max(0.5, Math.min(job.everySeconds / 2, 30)) },
      async () => {
        await runJob(deps, job);
      },
    );
  }
  const tick = () => {
    for (const job of JOBS) {
      boss.sendThrottled(job.name, {}, null, job.everySeconds).catch((error: unknown) => {
        logger.warn({ err: error, job: job.name }, "could not enqueue job");
      });
    }
  };
  tick();
  const timer = setInterval(tick, 5_000);
  logger.info({ jobs: JOBS.map((j) => j.name) }, "worker started");

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker shutting down");
    clearInterval(timer);
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    void (async () => {
      await boss.stop({ graceful: true, timeout: 20_000 });
      await deps.db.close();
      clearTimeout(force);
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
