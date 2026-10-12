import { newId, type CosignerClient, type FreezeInternal } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { agentResource, type AgentRowForEvent, type PendingEvent } from "./notify";
import { one } from "./rows";
import type { ReconcilerLogger } from "./types";

/**
 * Pausing an agent after an unexplained outflow or a balance mismatch (design § Reconciliation:
 * "pauses that agent's session keys until reviewed"). Like the API's own freeze it is a
 * tightening change: inside the reconciler's transaction the agent becomes `frozen` (so the API
 * refuses its writes), `agent.frozen` is emitted and a `freeze` row is queued in
 * `cosigner_outbox`; after commit the co-signer is called. If that call fails the row stays
 * pending and the API worker retries it, so the pause always reaches the co-signer; the
 * suspense entry and the mismatch event are recorded either way (fail safe).
 */

export const FREEZE_REASON = "reconciliation";

export interface QueuedFreeze {
  agentId: string;
  /** `cosigner_outbox` row, or `null` when the table does not exist (delivery without retry). */
  outboxId: string | null;
  payload: FreezeInternal;
}

const outboxByDb = new WeakMap<object, Promise<boolean>>();

/** Whether `cosigner_outbox` (0005_api) exists in this database; cached per root client. */
function hasOutbox(db: SqlClient, tx: SqlClient): Promise<boolean> {
  let known = outboxByDb.get(db);
  if (!known) {
    known = one<{ present: boolean }>(
      tx,
      "SELECT to_regclass('cosigner_outbox') IS NOT NULL AS present",
    ).then((row) => row?.present === true);
    outboxByDb.set(db, known);
  }
  return known;
}

/**
 * Freeze `agentId` inside `tx`. Returns the co-signer call to make after commit, and the
 * `agent.frozen` event when the agent was still active.
 */
export async function queueFreeze(
  db: SqlClient,
  tx: SqlClient,
  agentId: string,
  now: Date,
): Promise<{ queued: QueuedFreeze; events: PendingEvent[] }> {
  const events: PendingEvent[] = [];
  const agent = await one<AgentRowForEvent>(
    tx,
    `UPDATE agent SET status = 'frozen', frozen_reason = $2, pending_unfreeze_at = NULL
      WHERE id = $1 AND status = 'active' RETURNING *`,
    [agentId, FREEZE_REASON],
  );
  if (agent) events.push({ orgId: agent.org_id, type: "agent.frozen", data: agentResource(agent) });
  const payload: FreezeInternal = { scope: "agent", id: agentId, reason: FREEZE_REASON };
  let outboxId: string | null = null;
  if (await hasOutbox(db, tx)) {
    outboxId = `cso_${newId("audit", now.getTime()).slice("aud_".length)}`;
    await tx.query(
      `INSERT INTO cosigner_outbox (id, kind, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, 'freeze', $2, 'pending', 0, $3, $3, $3)`,
      [outboxId, payload, now],
    );
  }
  return { queued: { agentId, outboxId, payload }, events };
}

/** Backoff after a failed delivery (same schedule as the API's outbox worker). */
const RETRY_AFTER_SECONDS = 10;

/**
 * Call the co-signer for freezes queued by a committed transaction, once per agent. Failures
 * are recorded on the outbox rows (the API worker retries them) and logged; they never throw.
 */
export async function deliverFreezes(
  db: SqlClient,
  cosigner: Pick<CosignerClient, "freeze">,
  freezes: readonly QueuedFreeze[],
  now: () => Date,
  logger: ReconcilerLogger,
): Promise<{ delivered: number; failed: number }> {
  const byAgent = new Map<string, QueuedFreeze[]>();
  for (const freeze of freezes) byAgent.set(freeze.agentId, [...(byAgent.get(freeze.agentId) ?? []), freeze]);
  let delivered = 0;
  let failed = 0;
  for (const [agentId, queued] of byAgent) {
    const outboxIds = queued.map((q) => q.outboxId).filter((id): id is string => id !== null);
    try {
      await cosigner.freeze((queued[0] as QueuedFreeze).payload);
      delivered++;
      if (outboxIds.length > 0) {
        await db.query(
          "UPDATE cosigner_outbox SET status = 'done', updated_at = $2 WHERE id = ANY($1::text[])",
          [outboxIds, now()],
        );
      }
    } catch (error) {
      failed++;
      const message = String((error as Error)?.message ?? error).slice(0, 500);
      logger.error(
        { agent_id: agentId, outbox_ids: outboxIds, err: message },
        "co-signer freeze failed after a reconciliation mismatch; the co-signer outbox retries it",
      );
      if (outboxIds.length > 0) {
        const at = now();
        await db
          .query(
            `UPDATE cosigner_outbox SET attempts = attempts + 1, next_attempt_at = $2, last_error = $3, updated_at = $4
              WHERE id = ANY($1::text[]) AND status = 'pending'`,
            [outboxIds, new Date(at.getTime() + RETRY_AFTER_SECONDS * 1000), message, at],
          )
          .catch(() => undefined);
      }
    }
  }
  return { delivered, failed };
}
