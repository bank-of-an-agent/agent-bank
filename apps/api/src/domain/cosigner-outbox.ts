import type { FreezeInternal, SettlementReportInternal } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { all } from "../db/sql";
import type { CosignerOutboxRow } from "../db/rows";
import type { AppDeps } from "../deps";
import { internalId } from "../util/ids";

/**
 * Tightening changes (freezes, revocations) and settlement reports must reach the co-signer
 * even if it is briefly unreachable. They are written to `cosigner_outbox` in the same
 * transaction as the local change, delivered right after commit, and retried by the worker
 * with backoff until the co-signer acknowledges them. (Loosening changes are never queued:
 * they call the co-signer synchronously and fail closed.)
 */

export type OutboxItem =
  | { kind: "freeze"; payload: FreezeInternal }
  | { kind: "revoke_session"; payload: { session_id: string } }
  | { kind: "revoke_mandate"; payload: { mandate_id: string } }
  | { kind: "report_settlement"; payload: SettlementReportInternal };

export async function enqueueCosigner(tx: SqlClient, now: Date, item: OutboxItem): Promise<string> {
  const id = internalId("cso", now);
  await tx.query(
    `INSERT INTO cosigner_outbox (id, kind, payload, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', 0, $4, $4, $4)`,
    [id, item.kind, item.payload as object, now],
  );
  return id;
}

/** Backoff after `attempts` failures: 5 s doubling, capped at 5 minutes. */
export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(attempts, 10));
}

async function send(deps: AppDeps, row: CosignerOutboxRow): Promise<void> {
  switch (row.kind) {
    case "freeze":
      await deps.cosigner.freeze(row.payload as unknown as FreezeInternal);
      return;
    case "revoke_session":
      await deps.cosigner.revokeSession(String(row.payload.session_id));
      return;
    case "revoke_mandate":
      await deps.cosigner.revokeMandate(String(row.payload.mandate_id));
      return;
    case "report_settlement":
      await deps.cosigner.reportSettlement(row.payload as unknown as SettlementReportInternal);
      return;
  }
}

/**
 * Deliver due outbox items (or exactly `ids`, e.g. right after the change committed).
 * Returns how many were delivered.
 */
export async function deliverCosignerOutbox(deps: AppDeps, ids?: readonly string[]): Promise<number> {
  const now = deps.clock.now();
  const rows = ids
    ? await all<CosignerOutboxRow>(
        deps.db,
        "SELECT * FROM cosigner_outbox WHERE id = ANY($1) AND status = 'pending' ORDER BY created_at",
        [[...ids]],
      )
    : await all<CosignerOutboxRow>(
        deps.db,
        "SELECT * FROM cosigner_outbox WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY created_at LIMIT 100",
        [now],
      );
  let delivered = 0;
  for (const row of rows) {
    try {
      await send(deps, row);
      await deps.db.query("UPDATE cosigner_outbox SET status = 'done', updated_at = $2 WHERE id = $1", [
        row.id,
        deps.clock.now(),
      ]);
      delivered++;
    } catch (error) {
      const attempts = row.attempts + 1;
      const next = new Date(now.getTime() + outboxBackoffSeconds(attempts) * 1000);
      await deps.db.query(
        `UPDATE cosigner_outbox SET attempts = $2, next_attempt_at = $3, last_error = $4, updated_at = $5
          WHERE id = $1`,
        [row.id, attempts, next, String((error as Error).message ?? error).slice(0, 500), now],
      );
      deps.logger.warn({ outboxId: row.id, kind: row.kind, attempts }, "co-signer outbox delivery failed");
    }
  }
  return delivered;
}
