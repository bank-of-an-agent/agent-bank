import type { SqlClient, SqlParam } from "@agentbank/db";
import type { ChainEventRow, ChainTxRow } from "./rows";
import type { EventWriter, PendingEvent } from "./notify";
import type { ChainEvent, TxGroup } from "./parse";

/**
 * Row writes of one reconciler transaction, batched: a chain transaction's evidence, the
 * payments it settles, fee charges and webhook events are written with a handful of multi-row
 * statements per ingest request instead of several statements per chain transaction. The
 * buffer is flushed before anything reads or updates those rows directly (reorg handling) and
 * at the end of the request, always inside the same database transaction.
 */

export interface TxFields {
  status: ChainTxRow["status"];
  outcome?: string | null;
  deferredReason?: ChainTxRow["deferred_reason"];
  generation: number;
  entryIds?: string[];
  effects?: unknown[];
  reversal?: ChainTxRow["reversal"];
  reversalEntryIds?: string[];
  supersededBy?: string | null;
  alertedAt?: Date | null;
  detail?: Record<string, unknown>;
  processedAt?: Date | null;
  reorgedAt?: Date | null;
}

export interface EventOutcome {
  status: ChainEventRow["status"];
  result: ChainEventRow["result"];
  ref: string | null;
  entryId: string | null;
  matchedEntryId: string | null;
  detail?: Record<string, unknown>;
}

export interface FeeWrite {
  id: string;
  accountId: string;
  orgId: string;
  kind: string;
  sourceRef: string;
  amount: bigint;
  entryId: string | null;
  at: Date;
}

const TX_COLUMNS =
  "id, chain_id, block_number, block_hash, block_timestamp, tx_hash, first_log_index, fingerprint, status, outcome, " +
  "deferred_reason, generation, entry_ids, effects, reversal, reversal_entry_ids, superseded_by, alerted_at, detail, " +
  "created_at, updated_at, processed_at, reorged_at";

const EVENT_COLUMNS =
  "id, ledger_ref, chain_tx_id, chain_id, block_number, block_hash, block_timestamp, tx_hash, log_index, contract, " +
  "event_name, args, user_op_hash, finality, status, result, ref, entry_id, matched_entry_id, detail, created_at, updated_at";

/** Placeholders for one row; `casts` maps 0-based columns to a SQL cast. */
function placeholders(offset: number, columns: number, casts: Record<number, string> = {}): string {
  return `(${Array.from({ length: columns }, (_, i) => `$${offset + i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ")})`;
}

/** Rows per statement (well under PostgreSQL's 65,535 parameters). */
const CHUNK = 1_000;

function txParams(group: TxGroup, fields: TxFields, at: Date): SqlParam[] {
  return [
    group.id,
    group.chainId,
    group.blockNumber,
    group.blockHash,
    group.blockTimestamp,
    group.txHash,
    group.firstLogIndex,
    group.fingerprint,
    fields.status,
    fields.outcome ?? null,
    fields.deferredReason ?? null,
    fields.generation,
    fields.entryIds ?? [],
    JSON.stringify(fields.effects ?? []),
    fields.reversal ?? "none",
    fields.reversalEntryIds ?? [],
    fields.supersededBy ?? null,
    fields.alertedAt ?? null,
    JSON.stringify(fields.detail ?? {}),
    at,
    at,
    fields.processedAt ?? null,
    fields.reorgedAt ?? null,
  ];
}

const TX_CASTS = { 12: "text[]", 13: "jsonb", 15: "text[]", 18: "jsonb" };
const TX_UPSERT = `ON CONFLICT (id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, status = EXCLUDED.status,
  outcome = EXCLUDED.outcome, deferred_reason = EXCLUDED.deferred_reason, generation = EXCLUDED.generation,
  entry_ids = EXCLUDED.entry_ids, effects = EXCLUDED.effects, reversal = EXCLUDED.reversal,
  reversal_entry_ids = EXCLUDED.reversal_entry_ids, superseded_by = EXCLUDED.superseded_by,
  alerted_at = COALESCE(chain_tx.alerted_at, EXCLUDED.alerted_at), detail = EXCLUDED.detail,
  updated_at = EXCLUDED.updated_at, processed_at = EXCLUDED.processed_at, reorged_at = EXCLUDED.reorged_at`;

/** Insert or update one chain_tx row now (reorg paths that must see it immediately). */
export async function writeTx(tx: SqlClient, group: TxGroup, fields: TxFields, at: Date): Promise<void> {
  await tx.query(
    `INSERT INTO chain_tx (${TX_COLUMNS}) VALUES ${placeholders(0, 23, TX_CASTS)} ${TX_UPSERT}`,
    txParams(group, fields, at),
  );
}

/** The row `writeTx` writes, without reading it back. */
export function txRowOf(group: TxGroup, fields: TxFields, at: Date, previous?: ChainTxRow): ChainTxRow {
  return {
    id: group.id,
    chain_id: group.chainId,
    block_number: group.blockNumber,
    block_hash: group.blockHash,
    block_timestamp: group.blockTimestamp,
    tx_hash: group.txHash,
    first_log_index: group.firstLogIndex,
    fingerprint: group.fingerprint,
    status: fields.status,
    outcome: fields.outcome ?? null,
    deferred_reason: fields.deferredReason ?? null,
    generation: fields.generation,
    entry_ids: fields.entryIds ?? [],
    effects: fields.effects ?? [],
    reversal: fields.reversal ?? "none",
    reversal_entry_ids: fields.reversalEntryIds ?? [],
    superseded_by: fields.supersededBy ?? null,
    alerted_at: previous?.alerted_at ?? fields.alertedAt ?? null,
    detail: fields.detail ?? {},
    created_at: previous?.created_at ?? at,
    updated_at: at,
    processed_at: fields.processedAt ?? null,
    reorged_at: fields.reorgedAt ?? null,
  };
}

function eventParams(group: TxGroup, event: ChainEvent, o: EventOutcome, at: Date): SqlParam[] {
  return [
    event.id,
    event.ledgerRef,
    group.id,
    group.chainId,
    group.blockNumber,
    group.blockHash,
    group.blockTimestamp,
    group.txHash,
    event.logIndex,
    event.contract,
    event.name,
    JSON.stringify(event.args),
    event.userOpHash,
    event.raw.finality,
    o.status,
    o.result,
    o.ref,
    o.entryId,
    o.matchedEntryId,
    JSON.stringify(o.detail ?? {}),
    at,
    at,
  ];
}

const EVENT_CASTS = { 11: "jsonb", 19: "jsonb" };
const EVENT_UPSERT = `ON CONFLICT (id) DO UPDATE SET finality = EXCLUDED.finality, status = EXCLUDED.status,
  result = EXCLUDED.result, ref = EXCLUDED.ref, entry_id = EXCLUDED.entry_id, matched_entry_id = EXCLUDED.matched_entry_id,
  detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`;

/** Insert or update a group's chain_event rows now. */
export async function writeEvents(
  tx: SqlClient,
  group: TxGroup,
  outcomeOf: (eventId: string) => EventOutcome,
  at: Date,
): Promise<void> {
  if (group.events.length === 0) return;
  const params: SqlParam[] = [];
  const tuples: string[] = [];
  for (const event of group.events) {
    tuples.push(placeholders(params.length, 22, EVENT_CASTS));
    params.push(...eventParams(group, event, outcomeOf(event.id), at));
  }
  await tx.query(
    `INSERT INTO chain_event (${EVENT_COLUMNS}) VALUES ${tuples.join(", ")} ${EVENT_UPSERT}`,
    params,
  );
}

export class WriteBuffer {
  private readonly txs = new Map<string, { group: TxGroup; fields: TxFields; at: Date }>();
  private readonly events = new Map<
    string,
    { group: TxGroup; event: ChainEvent; outcome: EventOutcome; at: Date }
  >();
  private readonly payments = new Map<string, { txHash: string; settledAt: Date; at: Date }>();
  private readonly fees = new Map<string, FeeWrite>();
  private notifications: (PendingEvent & { at: Date })[] = [];

  constructor(
    private readonly tx: SqlClient,
    private readonly writer: EventWriter,
  ) {}

  get empty(): boolean {
    return (
      this.txs.size === 0 &&
      this.events.size === 0 &&
      this.payments.size === 0 &&
      this.fees.size === 0 &&
      this.notifications.length === 0
    );
  }

  putTx(group: TxGroup, fields: TxFields, at: Date): void {
    this.txs.set(group.id, { group, fields, at });
  }

  putEvents(group: TxGroup, outcomeOf: (eventId: string) => EventOutcome, at: Date): void {
    for (const event of group.events)
      this.events.set(event.id, { group, event, outcome: outcomeOf(event.id), at });
  }

  settlePayment(paymentId: string, txHash: string, settledAt: Date, at: Date): void {
    this.payments.set(paymentId, { txHash, settledAt, at });
  }

  fee(write: FeeWrite): void {
    this.fees.set(`${write.kind}|${write.sourceRef}`, write);
  }

  emit(events: readonly PendingEvent[], at: Date): void {
    for (const event of events) this.notifications.push({ ...event, at });
  }

  async flush(): Promise<void> {
    if (this.empty) return;
    const txs = [...this.txs.values()];
    for (let i = 0; i < txs.length; i += CHUNK) {
      const chunk = txs.slice(i, i + CHUNK);
      const params: SqlParam[] = [];
      const tuples: string[] = [];
      for (const t of chunk) {
        tuples.push(placeholders(params.length, 23, TX_CASTS));
        params.push(...txParams(t.group, t.fields, t.at));
      }
      await this.tx.query(
        `INSERT INTO chain_tx (${TX_COLUMNS}) VALUES ${tuples.join(", ")} ${TX_UPSERT}`,
        params,
      );
    }
    const events = [...this.events.values()];
    for (let i = 0; i < events.length; i += CHUNK) {
      const chunk = events.slice(i, i + CHUNK);
      const params: SqlParam[] = [];
      const tuples: string[] = [];
      for (const e of chunk) {
        tuples.push(placeholders(params.length, 22, EVENT_CASTS));
        params.push(...eventParams(e.group, e.event, e.outcome, e.at));
      }
      await this.tx.query(
        `INSERT INTO chain_event (${EVENT_COLUMNS}) VALUES ${tuples.join(", ")} ${EVENT_UPSERT}`,
        params,
      );
    }
    const payments = [...this.payments.entries()];
    for (let i = 0; i < payments.length; i += CHUNK) {
      const chunk = payments.slice(i, i + CHUNK);
      const params: SqlParam[] = [];
      const tuples: string[] = [];
      for (const [id, p] of chunk) {
        tuples.push(
          placeholders(params.length, 4, { 0: "text", 1: "text", 2: "timestamptz", 3: "timestamptz" }),
        );
        params.push(id, p.txHash, p.settledAt, p.at);
      }
      await this.tx.query(
        `UPDATE payment AS p SET status = 'settled', tx_hash = v.tx_hash, settled_at = v.settled_at, updated_at = v.updated_at
           FROM (VALUES ${tuples.join(", ")}) AS v (id, tx_hash, settled_at, updated_at)
          WHERE p.id = v.id`,
        params,
      );
    }
    const fees = [...this.fees.values()];
    for (let i = 0; i < fees.length; i += CHUNK) {
      const chunk = fees.slice(i, i + CHUNK);
      const params: SqlParam[] = [];
      const tuples: string[] = [];
      for (const f of chunk) {
        tuples.push(placeholders(params.length, 8));
        params.push(f.id, f.accountId, f.orgId, f.kind, f.sourceRef, f.amount, f.entryId, f.at);
      }
      await this.tx.query(
        `INSERT INTO fee_charge (id, account_id, org_id, kind, source_ref, amount, ledger_entry_id, created_at)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (kind, source_ref) DO UPDATE SET amount = EXCLUDED.amount, ledger_entry_id = EXCLUDED.ledger_entry_id`,
        params,
      );
    }
    if (this.notifications.length > 0) await this.writer.emit(this.notifications);
    this.txs.clear();
    this.events.clear();
    this.payments.clear();
    this.fees.clear();
    this.notifications = [];
  }
}
