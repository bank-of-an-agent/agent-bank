import { accrueAllSubscriptions } from "../domain/billing";
import { runAutoSave } from "../domain/auto-save";
import { deliverCosignerOutbox } from "../domain/cosigner-outbox";
import { applyDueUnfreezes } from "../domain/freeze";
import { pollReceipts } from "../domain/receipts";
import type { AppDeps } from "../deps";
import { expirePending, prune } from "./expiry";
import { settleStreams, triggerTopUps } from "./keepers";
import { runProofReservations, runProofRoots } from "./proofs";
import { processSettled } from "./settlement";
import { notifyStatements } from "./statements";
import { deliverWebhooks } from "./webhooks";

/**
 * Background jobs. Each is a plain function of the dependencies (tests call them directly);
 * `src/worker.ts` runs them on pg-boss, and `RUN_WORKER_IN_PROCESS=true` runs them on timers
 * inside the API process (local sandbox on the simulated chain).
 */
export interface JobDefinition {
  /** pg-boss queue name. */
  name: string;
  /** Target period; pg-boss throttles to one run per period across all workers. */
  everySeconds: number;
  run: (deps: AppDeps) => Promise<number>;
}

export const JOBS: readonly JobDefinition[] = [
  { name: "webhooks-deliver", everySeconds: 5, run: (d) => deliverWebhooks(d) },
  { name: "operations-receipts", everySeconds: 5, run: pollReceipts },
  { name: "payments-expire", everySeconds: 15, run: expirePending },
  { name: "payments-post-settlement", everySeconds: 15, run: processSettled },
  { name: "cosigner-outbox", everySeconds: 10, run: (d) => deliverCosignerOutbox(d) },
  { name: "agents-unfreeze", everySeconds: 30, run: (d) => applyDueUnfreezes(d, d.clock.now()) },
  { name: "streams-settle", everySeconds: 60, run: settleStreams },
  { name: "topup-trigger", everySeconds: 60, run: triggerTopUps },
  { name: "autosave-run", everySeconds: 300, run: runAutoSave },
  { name: "billing-subscriptions", everySeconds: 3_600, run: accrueAllSubscriptions },
  { name: "statements-ready", everySeconds: 3_600, run: notifyStatements },
  { name: "maintenance-prune", everySeconds: 3_600, run: prune },
  { name: "proofs-roots", everySeconds: 30, run: runProofRoots },
  { name: "proofs-reservations", everySeconds: 60, run: runProofReservations },
  {
    name: "reconciliation-retry-reversals",
    everySeconds: 60,
    run: async (d) => (d.reconciler?.retryPendingReversals ? d.reconciler.retryPendingReversals() : 0),
  },
];

/** Run one job, logging (never throwing) so one failure cannot stop the others. */
export async function runJob(deps: AppDeps, job: JobDefinition): Promise<number> {
  const started = Date.now();
  try {
    const count = await job.run(deps);
    if (count > 0) deps.logger.info({ job: job.name, count, ms: Date.now() - started }, "job ran");
    return count;
  } catch (error) {
    deps.logger.error({ err: error, job: job.name }, "job failed");
    return 0;
  }
}

/** Timers for in-process mode. Returns a stop function. */
export function startInProcessJobs(deps: AppDeps): () => Promise<void> {
  const running = new Set<Promise<unknown>>();
  const timers = JOBS.map((job) => {
    let busy = false;
    return setInterval(() => {
      if (busy) return;
      busy = true;
      const p = runJob(deps, job).finally(() => {
        busy = false;
        running.delete(p);
      });
      running.add(p);
    }, job.everySeconds * 1000);
  });
  return async () => {
    for (const t of timers) clearInterval(t);
    await Promise.allSettled([...running]);
  };
}
