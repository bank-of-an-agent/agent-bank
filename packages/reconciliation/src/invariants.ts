import { AgentBankError } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { JournalEntry, Ledger } from "@agentbank/ledger";
import { all } from "./rows";
import type { ReconciliationReport, ReconciliationViolation } from "./types";

/**
 * The data-model invariants that span chain evidence, payments and the ledger (the ledger's own
 * — balanced entries, cached balances, holds — are `Ledger.verifyInvariants`):
 *
 * - each chain event matches at most one entry, and each entry at most one live event; the
 *   matched entry exists and names that event (directly or through the rebinds of a re-included
 *   transaction);
 * - every entry posted for a transaction of an orphaned block is reversed (or rebound);
 * - no payment is `settled` without an `allow` decision, an approved approval or an owner
 *   operation, and every settled payment's hold is posted.
 */
export async function verifyReconciliation(
  db: SqlClient,
  ledger: Ledger,
  chainId: number,
): Promise<ReconciliationReport> {
  const violations: ReconciliationViolation[] = [];
  const events = await all<{
    id: string;
    ledger_ref: string;
    chain_tx_id: string;
    status: string;
    matched_entry_id: string | null;
    rebound_from: string | null;
  }>(
    db,
    `SELECT id, ledger_ref, chain_tx_id, status, matched_entry_id, detail->>'rebound_from' AS rebound_from
       FROM chain_event WHERE chain_id = $1`,
    [chainId],
  );
  const refOf = new Map(events.map((e) => [e.id, e.ledger_ref]));
  const reboundFrom = new Map(
    events.filter((e) => e.rebound_from).map((e) => [e.id, e.rebound_from as string]),
  );
  const matchedBy = new Map<string, string[]>();
  let matched = 0;
  for (const event of events) {
    if (!event.matched_entry_id) continue;
    matched++;
    matchedBy.set(event.matched_entry_id, [...(matchedBy.get(event.matched_entry_id) ?? []), event.id]);
    let entry: JournalEntry;
    try {
      entry = await ledger.getEntry(event.matched_entry_id);
    } catch (error) {
      if (!(error instanceof AgentBankError && error.code === "not_found")) throw error;
      violations.push({
        invariant: "matched_entry_exists",
        subject: event.id,
        detail: `entry ${event.matched_entry_id} does not exist`,
      });
      continue;
    }
    // Follow rebinds back to the first inclusion, whose ledger id the immutable entry carries.
    const chain = new Set<string>([event.ledger_ref]);
    let cursor = event.id;
    while (reboundFrom.has(cursor) && chain.size < 64) {
      cursor = reboundFrom.get(cursor) as string;
      chain.add(refOf.get(cursor) ?? cursor);
    }
    if (!entry.chainEventId || !chain.has(entry.chainEventId)) {
      violations.push({
        invariant: "event_matches_one_entry",
        subject: event.id,
        detail: `matched entry ${entry.id} names chain event ${entry.chainEventId ?? "none"}`,
      });
    }
  }
  for (const [entryId, ids] of matchedBy) {
    if (ids.length > 1) {
      violations.push({
        invariant: "entry_matches_one_event",
        subject: entryId,
        detail: `matched by ${ids.join(", ")}`,
      });
    }
  }

  const txs = await all<{
    id: string;
    status: string;
    reversal: string;
    entry_ids: string[];
    reversal_entry_ids: string[];
  }>(db, "SELECT id, status, reversal, entry_ids, reversal_entry_ids FROM chain_tx WHERE chain_id = $1", [
    chainId,
  ]);
  const owner = new Map<string, string>();
  for (const tx of txs) {
    if (tx.status === "processed") {
      for (const entryId of tx.entry_ids) {
        const other = owner.get(entryId);
        if (other) {
          violations.push({
            invariant: "entry_matches_one_event",
            subject: entryId,
            detail: `posted for ${other} and ${tx.id}`,
          });
        }
        owner.set(entryId, tx.id);
      }
    } else if (tx.status === "reorged") {
      if (tx.reversal === "pending") {
        violations.push({
          invariant: "orphaned_entries_reversed",
          subject: tx.id,
          detail: "reversal still pending",
        });
      } else if (tx.reversal === "done" && tx.reversal_entry_ids.length !== tx.entry_ids.length) {
        violations.push({
          invariant: "orphaned_entries_reversed",
          subject: tx.id,
          detail: `${tx.entry_ids.length} entries, ${tx.reversal_entry_ids.length} reversals`,
        });
      }
    }
  }

  const unauthorized = await all<{ id: string }>(
    db,
    `SELECT p.id FROM payment p
      WHERE p.status = 'settled'
        AND NOT EXISTS (SELECT 1 FROM policy_decision d WHERE d.payment_id = p.id AND d.outcome = 'allow')
        AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.payment_id = p.id AND a.status = 'approved')
        AND p.owner_operation_id IS NULL`,
  );
  for (const p of unauthorized) {
    violations.push({
      invariant: "settled_payment_authorized",
      subject: p.id,
      detail: "settled without allow, approval or owner signature",
    });
  }
  const settled = await all<{ id: string; hold_id: string | null }>(
    db,
    "SELECT id, hold_id FROM payment WHERE status = 'settled' AND hold_id IS NOT NULL",
  );
  for (const p of settled) {
    try {
      const hold = await ledger.getHold(p.hold_id as string);
      if (hold.status !== "posted") {
        violations.push({
          invariant: "settled_payment_posted",
          subject: p.id,
          detail: `hold ${hold.id} is ${hold.status}`,
        });
      }
    } catch (error) {
      if (!(error instanceof AgentBankError && error.code === "not_found")) throw error;
      violations.push({
        invariant: "settled_payment_posted",
        subject: p.id,
        detail: `hold ${p.hold_id} does not exist`,
      });
    }
  }
  return {
    ok: violations.length === 0,
    events: events.length,
    matchedEvents: matched,
    transactions: txs.length,
    violations,
  };
}
