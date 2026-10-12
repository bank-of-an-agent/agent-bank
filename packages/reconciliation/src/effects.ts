import type { SqlClient, SqlParam } from "@agentbank/db";
import { one } from "./rows";

/**
 * Row changes the reconciler makes from chain evidence, recorded on the `chain_tx` that caused
 * them (JSON, in order) so a reorg can undo them exactly, newest first. Undo is conservative:
 * a column is only restored while it still holds the value the reconciler set, so a later
 * change by the API is never overwritten.
 */
export type Effect =
  | {
      type: "payment_settled";
      payment_id: string;
      prev: { status: string; tx_hash: string | null; settled_at: string | null };
    }
  | {
      type: "fee_charge";
      kind: string;
      source_ref: string;
      entry_id: string | null;
      /** The row before (null: the reconciler inserted it). */
      prev: { ledger_entry_id: string | null; amount: string } | null;
    }
  | {
      type: "escrow";
      escrow_id: string;
      prev: Record<string, string | null>;
      next: Record<string, string | null>;
    }
  | {
      type: "stream";
      stream_id: string;
      prev: Record<string, string | null>;
      next: Record<string, string | null>;
      /** Added to `settled` (undo subtracts it). */
      settled_delta: string;
    };

export function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Ids of payments, escrows and streams an undo returned to their earlier status. */
export interface UndoResult {
  reopened: string[];
}

/** Undo effects newest first. */
export async function undoEffects(tx: SqlClient, effects: readonly Effect[], now: Date): Promise<UndoResult> {
  const reopened: string[] = [];
  for (let i = effects.length - 1; i >= 0; i--) {
    const effect = effects[i] as Effect;
    switch (effect.type) {
      case "payment_settled": {
        const row = await one<{ id: string }>(
          tx,
          `UPDATE payment SET status = $2, tx_hash = $3, settled_at = $4, updated_at = $5
            WHERE id = $1 AND status = 'settled' RETURNING id`,
          [
            effect.payment_id,
            effect.prev.status,
            effect.prev.tx_hash,
            effect.prev.settled_at ? new Date(effect.prev.settled_at) : null,
            now,
          ],
        );
        if (row) reopened.push(effect.payment_id);
        break;
      }
      case "fee_charge": {
        if (effect.prev === null) {
          await tx.query(
            "DELETE FROM fee_charge WHERE kind = $1 AND source_ref = $2 AND ledger_entry_id IS NOT DISTINCT FROM $3",
            [effect.kind, effect.source_ref, effect.entry_id],
          );
        } else {
          await tx.query(
            `UPDATE fee_charge SET ledger_entry_id = $3, amount = $4
              WHERE kind = $1 AND source_ref = $2 AND ledger_entry_id IS NOT DISTINCT FROM $5`,
            [
              effect.kind,
              effect.source_ref,
              effect.prev.ledger_entry_id,
              BigInt(effect.prev.amount),
              effect.entry_id,
            ],
          );
        }
        break;
      }
      case "escrow": {
        if (await restoreColumns(tx, "escrow", effect.escrow_id, effect.prev, effect.next, now)) {
          reopened.push(effect.escrow_id);
        }
        break;
      }
      case "stream": {
        const delta = BigInt(effect.settled_delta);
        if (delta !== 0n) {
          await tx.query("UPDATE stream SET settled = GREATEST(settled - $2, 0) WHERE id = $1", [
            effect.stream_id,
            delta,
          ]);
        }
        const restored = await restoreColumns(tx, "stream", effect.stream_id, effect.prev, effect.next, now);
        if (restored || delta !== 0n) reopened.push(effect.stream_id);
        break;
      }
    }
  }
  return { reopened: [...new Set(reopened)] };
}

const RESTORABLE: Record<"escrow" | "stream", readonly string[]> = {
  escrow: [
    "status",
    "onchain_id",
    "tx_hash",
    "pending_action",
    "resolution_payee_amount",
    "resolution_payer_amount",
  ],
  stream: ["status", "onchain_id", "tx_hash", "pending_action", "deposit", "last_settled_at"],
};

const TYPED: Record<string, "bigint" | "timestamptz" | "text"> = {
  deposit: "bigint",
  resolution_payee_amount: "bigint",
  resolution_payer_amount: "bigint",
  last_settled_at: "timestamptz",
};

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Restore columns that still hold the reconciler's value. Returns whether anything changed. */
async function restoreColumns(
  tx: SqlClient,
  table: "escrow" | "stream",
  id: string,
  prev: Record<string, string | null>,
  next: Record<string, string | null>,
  now: Date,
): Promise<boolean> {
  const current = await one<Record<string, unknown>>(tx, `SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!current) return false;
  const sets: string[] = [];
  const params: SqlParam[] = [id];
  for (const column of RESTORABLE[table]) {
    if (!(column in next)) continue;
    if (textOf(current[column]) !== (next[column] ?? null)) continue;
    const value = prev[column] ?? null;
    const type = TYPED[column] ?? "text";
    params.push(
      value === null
        ? null
        : type === "bigint"
          ? BigInt(value)
          : type === "timestamptz"
            ? new Date(value)
            : value,
    );
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return false;
  params.push(now);
  await tx.query(
    `UPDATE ${table} SET ${sets.join(", ")}, updated_at = $${params.length} WHERE id = $1`,
    params,
  );
  return true;
}
