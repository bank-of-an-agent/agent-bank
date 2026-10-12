import { all } from "../db/sql";
import { emitEvent } from "../domain/events";
import type { AppDeps } from "../deps";
import { monthWindow, periodOf } from "../util/time";

/**
 * `statement.ready` (worker): once a month has ended, each account that existed during it gets
 * one event pointing at its statement. `statement_notice` makes it exactly once per
 * account and month, written in the same transaction as the event.
 */
export async function notifyStatements(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const current = monthWindow(now);
  const previous = monthWindow(new Date(current.start.getTime() - 1));
  const period = periodOf(previous.start);
  const accounts = await all<{ id: string; org_id: string }>(
    deps.db,
    `SELECT a.id, a.org_id FROM account a
      WHERE a.created_at < $1
        AND NOT EXISTS (SELECT 1 FROM statement_notice s WHERE s.account_id = a.id AND s.period = $2)
      LIMIT 500`,
    [previous.end, period],
  );
  let sent = 0;
  for (const account of accounts) {
    const notified = await deps.db.transaction(async (tx) => {
      const claimed = await tx.query<{ account_id: string }>(
        `INSERT INTO statement_notice (account_id, period, event_id, created_at) VALUES ($1, $2, '', $3)
         ON CONFLICT DO NOTHING RETURNING account_id`,
        [account.id, period, now],
      );
      if (claimed.rows.length === 0) return false;
      const eventId = await emitEvent(tx, now, {
        orgId: account.org_id,
        type: "statement.ready",
        data: {
          account_id: account.id,
          period,
          json_url: `/v1/statements?account_id=${account.id}&period=${period}`,
          csv_url: `/v1/statements?account_id=${account.id}&period=${period}&format=csv`,
        },
      });
      await tx.query("UPDATE statement_notice SET event_id = $3 WHERE account_id = $1 AND period = $2", [
        account.id,
        period,
        eventId,
      ]);
      return true;
    });
    if (notified) sent++;
  }
  return sent;
}
