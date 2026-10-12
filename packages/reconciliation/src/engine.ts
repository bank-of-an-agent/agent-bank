import { AgentBankError, isAgentBankError, newId, type Clock, type IngestResult } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { vaultRef, type JournalEntry, type Ledger } from "@agentbank/ledger";
import { txRowOf, WriteBuffer, writeEvents, writeTx, type EventOutcome, type TxFields } from "./buffer";
import { loadContext, type ResolvedConfig, type RunContext } from "./context";
import { isoOrNull, undoEffects, type Effect } from "./effects";
import { queueFreeze, type QueuedFreeze } from "./freeze";
import { EventWriter, type PendingEvent } from "./notify";
import {
  ASSET,
  BalanceView,
  GroupPlanner,
  OPEN_STATUSES,
  type ActionContext,
  type Plan,
  type PlannedPosting,
} from "./plan";
import type { TxGroup } from "./parse";
import { all, type ChainEventRow, type ChainTxRow, type PaymentRow } from "./rows";
import type { LedgerFactory, ReconcilerLogger, ReconcilerStats } from "./types";

/**
 * The reconciler's write path. One serializable database transaction per ingest request
 * (retried by `SqlClient.transaction`); inside it each chain transaction is processed in order:
 *
 *   duplicate? ─ yes ─► results from the stored rows
 *   same tx in another block (implicit orphan)? ─ same fingerprint ─► rebind its postings here
 *                                              └ different ─► reverse it, then continue
 *   plan (matching) ─► unexplained outflow inside the window, or a large movement before
 *   finality ─► deferred (the indexer resends) ─► otherwise post entries, apply row changes,
 *   emit events, pause agents, and record chain_tx + chain_event.
 *
 * Row writes are batched in a {@link WriteBuffer} and flushed before any reorg path touches
 * existing rows, and at the end of the request.
 */

export interface EngineDeps {
  db: SqlClient;
  ledger: Ledger | LedgerFactory;
  clock: Clock;
  cfg: ResolvedConfig;
  logger: ReconcilerLogger;
  stats: ReconcilerStats;
}

export interface Reversal {
  state: "done" | "pending";
  reversed: string[];
  reopened: string[];
}

/** Ledger idempotency key of a posting: namespaced `rec:`, pinned to block, transaction and generation. */
export function postingKey(groupId: string, generation: number, name: string): string {
  return `rec:${groupId}:g${generation}:${name}`;
}

export function ledgerFor(deps: Pick<EngineDeps, "ledger">, tx: SqlClient): Ledger {
  return typeof deps.ledger === "function" ? deps.ledger(tx) : deps.ledger;
}

/**
 * Reverse everything a chain transaction posted (newest first) and undo its row changes. When
 * reversing would overdraw a pocket (the credited funds are held for a later payment, or were
 * spent), nothing is reversed yet: the transaction is marked `reorged` with a pending reversal,
 * retried on later calls, and rebound instead if the transaction is re-included.
 */
export async function reverseTx(
  deps: EngineDeps,
  tx: SqlClient,
  ledger: Ledger,
  txRow: ChainTxRow,
  now: Date,
): Promise<Reversal> {
  const effects = (txRow.effects ?? []) as Effect[];
  const entries: JournalEntry[] = [];
  for (const id of txRow.entry_ids) entries.push(await ledger.getEntry(id));
  const view = new BalanceView(ledger);
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const line of (entries[i] as JournalEntry).lines) {
      if (line.ownerRef === "system") continue;
      const ref = { ownerRef: line.ownerRef, code: line.code, asset: line.asset };
      if ((await view.get(ref)) - line.amount < 0n) {
        await tx.query(
          `UPDATE chain_tx SET status = 'reorged', reversal = 'pending', deferred_reason = NULL,
                  reorged_at = COALESCE(reorged_at, $2), updated_at = $2
            WHERE id = $1`,
          [txRow.id, now],
        );
        await tx.query("UPDATE chain_event SET status = 'reorged', updated_at = $2 WHERE chain_tx_id = $1", [
          txRow.id,
          now,
        ]);
        if (txRow.reversal !== "pending") {
          deps.stats.pendingReversals++;
          deps.logger.warn(
            { chain_tx_id: txRow.id, pocket: `${line.ownerRef} ${line.code}` },
            "reorg reversal blocked: the credited funds are held or spent; retrying later",
          );
        }
        return { state: "pending", reversed: [], reopened: [] };
      }
      await view.apply(ref, -line.amount);
    }
  }
  const reversed: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as JournalEntry;
    const reversal = await ledger.reverse({
      idempotencyKey: `rec:rev:${entry.id}`,
      entryId: entry.id,
      memo: `chain reorg: block ${txRow.block_hash} orphaned`,
      ...(entry.chainEventId ? { chainEventId: entry.chainEventId } : {}),
      metadata: { reorged_block: txRow.block_hash, tx_hash: txRow.tx_hash },
    });
    reversed.push(reversal.id);
  }
  const { reopened } = await undoEffects(tx, effects, now);
  await tx.query(
    `UPDATE chain_tx SET status = 'reorged', reversal = 'done', reversal_entry_ids = $2::text[],
            reorged_at = COALESCE(reorged_at, $3), updated_at = $3, deferred_reason = NULL
      WHERE id = $1`,
    [txRow.id, reversed, now],
  );
  await tx.query("UPDATE chain_event SET status = 'reorged', updated_at = $2 WHERE chain_tx_id = $1", [
    txRow.id,
    now,
  ]);
  deps.stats.reversedEntries += reversed.length;
  return { state: "done", reversed, reopened };
}

/** Retry blocked reversals, newest first. */
export async function retryPending(
  deps: EngineDeps,
  tx: SqlClient,
  ledger: Ledger,
  now: Date,
  limit: number,
): Promise<{ completed: number; reversed: string[]; reopened: string[] }> {
  const rows = await all<ChainTxRow>(
    tx,
    `SELECT * FROM chain_tx WHERE chain_id = $1 AND reversal = 'pending'
      ORDER BY block_number DESC, first_log_index DESC LIMIT $2`,
    [deps.cfg.chainId, limit],
  );
  let completed = 0;
  const reversed: string[] = [];
  const reopened: string[] = [];
  for (const txRow of rows) {
    const r = await reverseTx(deps, tx, ledger, txRow, now);
    if (r.state === "done") {
      completed++;
      reversed.push(...r.reversed);
      reopened.push(...r.reopened);
    }
  }
  return { completed, reversed, reopened };
}

const IGNORED: EventOutcome = {
  status: "processed",
  result: "ignored",
  ref: null,
  entryId: null,
  matchedEntryId: null,
};

/** One ingest request inside one database transaction. */
export class IngestRun {
  readonly results = new Map<string, IngestResult>();
  readonly freezes: QueuedFreeze[] = [];
  private readonly buffer: WriteBuffer;
  private readonly ledger: Ledger;

  private constructor(
    private readonly deps: EngineDeps,
    private readonly tx: SqlClient,
    private readonly ctx: RunContext,
    private readonly head: bigint,
    private readonly finalized: bigint,
  ) {
    this.buffer = new WriteBuffer(tx, new EventWriter(tx));
    this.ledger = ledgerFor(deps, tx);
  }

  static async create(
    deps: EngineDeps,
    tx: SqlClient,
    groups: readonly TxGroup[],
    head: bigint,
    finalized: bigint,
  ): Promise<IngestRun> {
    return new IngestRun(deps, tx, await loadContext(tx, deps.cfg, groups), head, finalized);
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  private result(
    eventId: string,
    sentId: string,
    status: IngestResult["status"],
    entryId: string | null,
    ref: string | null,
  ): void {
    this.results.set(eventId, { event_id: sentId, status, entry_id: entryId, ref });
  }

  /** Write everything buffered (called before reorg paths and at the end of the request). */
  flush(): Promise<void> {
    return this.buffer.flush();
  }

  async process(group: TxGroup): Promise<void> {
    const existing = this.ctx.chainTx.get(group.id);
    if (existing?.status === "processed") return this.duplicate(group, existing);

    // The same transaction in another block: that block is orphaned (the reorg notice may follow).
    const restoring = existing?.status === "reorged" && existing.reversal === "pending";
    const others = this.ctx.otherInclusions(group);
    if (others.length > 0 || restoring) await this.flush();
    for (const old of others) {
      if (old.status === "deferred") {
        await this.retire(old);
      } else if (
        !restoring &&
        old.fingerprint === group.fingerprint &&
        (this.ctx.chainEvents.get(old.id) ?? []).length === group.events.length
      ) {
        return this.rebind(old, group, existing);
      } else {
        const r = await reverseTx(this.deps, this.tx, this.ledger, old, this.now());
        this.ctx.chainTx.set(old.id, { ...old, status: "reorged", reversal: r.state });
      }
    }
    if (restoring) return this.restore(group, existing);

    // Postings of an earlier processing of this very block were reversed or moved elsewhere: new
    // postings get a new generation so their idempotency keys never replay the old entries.
    const reprocessed = existing?.status === "reorged" && existing.entry_ids.length > 0;
    const generation =
      existing === undefined ? 0 : reprocessed ? existing.generation + 1 : existing.generation;
    const history = historyOf(existing);
    const plan = await new GroupPlanner(group, this.ctx, this.ledger, new BalanceView(this.ledger), (name) =>
      postingKey(group.id, generation, name),
    ).build();
    const cfg = this.deps.cfg;
    const waiting = plan.unexplained.length > 0 || plan.blocked.length > 0;
    if (waiting && this.head - group.blockNumber < cfg.windowBlocks) {
      return this.defer(group, plan, "window", generation, existing, null, history);
    }
    const large =
      plan.postings.some((p) => p.amount >= cfg.finalityThreshold) ||
      plan.unexplained.some((u) => u.transfer.value >= cfg.finalityThreshold);
    if (large && group.blockNumber > this.finalized) {
      // Past the window but not final: pause the agent now, post when final (fail safe).
      let alertedAt = existing?.alerted_at ?? null;
      if (plan.unexplained.length > 0 && alertedAt === null) {
        alertedAt = this.now();
        await this.runActions(
          plan.unexplained.map((u) => u.alert),
          new Map(),
          false,
        );
      }
      return this.defer(group, plan, "finality", generation, existing, alertedAt, history);
    }
    await this.execute(group, plan, generation, existing, history);
  }

  /** Post, apply and record a planned transaction. */
  private async execute(
    group: TxGroup,
    plan: Plan,
    generation: number,
    existing: ChainTxRow | undefined,
    history: unknown[],
  ): Promise<void> {
    const now = this.now();
    const entries = new Map<string, string>();
    const entryIds: string[] = [];
    for (const posting of plan.postings) {
      const entry = await this.post(group, posting, generation);
      entries.set(posting.name, entry.id);
      entryIds.push(entry.id);
    }
    const effects = await this.runActions(plan.actions, entries, (existing?.alerted_at ?? null) !== null);

    const outcomes = new Map<string, EventOutcome>();
    for (const posting of plan.postings) {
      const entryId = entries.get(posting.name) ?? null;
      const status = posting.result === "suspense" ? "suspense" : "processed";
      for (const covered of posting.covers) {
        if (!outcomes.has(covered)) {
          outcomes.set(covered, {
            status,
            result: posting.result,
            ref: posting.ref,
            entryId,
            matchedEntryId: null,
          });
        }
      }
    }
    for (const posting of plan.postings) {
      const entryId = entries.get(posting.name) ?? null;
      const status = posting.result === "suspense" ? "suspense" : "processed";
      outcomes.set(posting.evidence, {
        status,
        result: posting.result,
        ref: posting.ref,
        entryId,
        matchedEntryId: entryId,
      });
    }
    for (const [id, extra] of plan.extra) {
      if (!outcomes.has(id)) {
        outcomes.set(id, {
          status: "processed",
          result: extra.result,
          ref: extra.ref,
          entryId: null,
          matchedEntryId: null,
        });
      }
    }
    // Unexplained outflows that nothing could cover (shortfall) still count as suspense.
    for (const u of plan.unexplained) {
      if (!outcomes.has(u.transfer.event.id)) {
        outcomes.set(u.transfer.event.id, {
          status: "suspense",
          result: "suspense",
          ref: u.party.kind === "revenue" ? null : u.party.account.id,
          entryId: null,
          matchedEntryId: null,
          detail: { shortfall: u.transfer.value.toString() },
        });
      }
    }
    const kinds = new Set([...outcomes.values()].map((o) => o.result));
    const outcome = kinds.size === 0 ? "ignored" : kinds.size === 1 ? [...kinds][0] : "mixed";
    const fields: TxFields = {
      status: "processed",
      outcome,
      generation,
      entryIds,
      effects,
      alertedAt: plan.unexplained.length > 0 ? (existing?.alerted_at ?? now) : (existing?.alerted_at ?? null),
      detail: {
        ...(plan.notes.length > 0 ? { notes: plan.notes.slice(0, 20) } : {}),
        ...(history.length > 0 ? { history } : {}),
      },
      processedAt: now,
    };
    this.buffer.putTx(group, fields, now);
    this.ctx.chainTx.set(group.id, txRowOf(group, fields, now, existing));
    this.buffer.putEvents(group, (id) => outcomes.get(id) ?? IGNORED, now);
    this.ctx.chainEvents.set(
      group.id,
      group.events.map((e) => {
        const o = outcomes.get(e.id) ?? IGNORED;
        return {
          id: e.id,
          chain_tx_id: group.id,
          log_index: e.logIndex,
          event_name: e.name,
          status: o.status,
          result: o.result,
          ref: o.ref,
          entry_id: o.entryId,
          matched_entry_id: o.matchedEntryId,
        };
      }),
    );
    const stats = this.deps.stats;
    for (const e of group.events) {
      const o = outcomes.get(e.id) ?? IGNORED;
      this.result(e.id, e.sentId, o.result, o.entryId, o.ref);
      if (o.result === "matched") stats.matched++;
      else if (o.result === "deposit") stats.deposits++;
      else if (o.result === "suspense") stats.suspense++;
    }
  }

  /** Run actions with an action context; returns the recorded effects. */
  private async runActions(
    actions: readonly ((x: ActionContext) => Promise<void>)[],
    entries: Map<string, string>,
    alerted: boolean,
  ): Promise<Effect[]> {
    const now = this.now();
    const effects: Effect[] = [];
    const events: PendingEvent[] = [];
    const freezes = new Set<string>();
    const ctx = this.ctx;
    const buffer = this.buffer;
    const x: ActionContext = {
      tx: this.tx,
      now,
      entryOf: (name) => entries.get(name) ?? null,
      effect: (effect) => effects.push(effect),
      emit: (event) => events.push(event),
      freeze: (agentId) => freezes.add(agentId),
      alerted,
      settlePayment(payment, txHash, settledAt) {
        const current = ctx.payments.get(payment.id) ?? payment;
        if (!OPEN_STATUSES.has(current.status)) return null;
        const row: PaymentRow = {
          ...current,
          status: "settled",
          tx_hash: txHash,
          settled_at: settledAt,
          updated_at: now,
        };
        ctx.payments.set(payment.id, row);
        buffer.settlePayment(payment.id, txHash, settledAt, now);
        effects.push({
          type: "payment_settled",
          payment_id: payment.id,
          prev: {
            status: current.status,
            tx_hash: current.tx_hash,
            settled_at: isoOrNull(current.settled_at),
          },
        });
        return row;
      },
      feeCharge(input) {
        const key = `${input.kind}|${input.sourceRef}`;
        const prev = ctx.feeCharges.get(key) ?? null;
        ctx.feeCharges.set(key, { ledger_entry_id: input.entryId, amount: input.amount });
        buffer.fee({ ...input, id: `fee_${newId("feeCharge", now.getTime()).slice(4)}`, at: now });
        effects.push({
          type: "fee_charge",
          kind: input.kind,
          source_ref: input.sourceRef,
          entry_id: input.entryId,
          prev: prev ? { ledger_entry_id: prev.ledger_entry_id, amount: prev.amount.toString() } : null,
        });
      },
    };
    for (const action of actions) await action(x);
    for (const agentId of freezes) {
      const { queued, events: frozen } = await queueFreeze(this.deps.db, this.tx, agentId, now);
      this.freezes.push(queued);
      events.push(...frozen);
      this.deps.stats.freezes++;
    }
    this.buffer.emit(events, now);
    return effects;
  }

  /** Write one planned posting to the ledger (idempotent: a retried transaction replays it). */
  private async post(group: TxGroup, posting: PlannedPosting, generation: number): Promise<JournalEntry> {
    const key = postingKey(group.id, generation, posting.name);
    const c = posting.context;
    const write = async (): Promise<JournalEntry> => {
      if (posting.ensureVault) {
        await this.ledger.ensureAccount({
          ...vaultRef(posting.ensureVault.accountId, posting.ensureVault.vaultId, ASSET),
          location: "vault_contract",
        });
      }
      if (posting.spec.kind === "hold") {
        return this.ledger.postHold({
          idempotencyKey: key,
          holdId: posting.spec.holdId,
          amount: posting.spec.amount,
          destinations: posting.spec.destinations,
          chainEventId: c.chainEventId,
          metadata: c.metadata,
        });
      }
      return this.ledger.post({
        idempotencyKey: key,
        lines: posting.spec.lines,
        refType: c.refType ?? "chain",
        refId: c.refId ?? null,
        memo: c.memo ?? null,
        agentId: c.agentId ?? null,
        paymentId: c.paymentId ?? null,
        chainEventId: c.chainEventId,
        metadata: c.metadata,
      });
    };
    try {
      return await write();
    } catch (error) {
      // A pocket of a known account that was never opened: open the standard pockets, retry once.
      const owner =
        isAgentBankError(error) && error.code === "not_found" ? error.extensions.owner_ref : undefined;
      if (typeof owner !== "string" || !owner.startsWith("acct_")) throw error;
      await this.ledger.openPockets(owner, ASSET, this.deps.cfg.chainId);
      return write();
    }
  }

  private async defer(
    group: TxGroup,
    plan: Plan,
    reason: "window" | "finality",
    generation: number,
    existing: ChainTxRow | undefined,
    alertedAt: Date | null,
    history: unknown[],
  ): Promise<void> {
    const now = this.now();
    const ref = plan.refs[0] ?? null;
    const fields: TxFields = {
      status: "deferred",
      deferredReason: reason,
      generation,
      alertedAt: alertedAt ?? existing?.alerted_at ?? null,
      detail: {
        notes: [...plan.blocked, ...plan.notes].slice(0, 20),
        head: this.head.toString(),
        ...(history.length > 0 ? { history } : {}),
      },
    };
    this.buffer.putTx(group, fields, now);
    this.ctx.chainTx.set(group.id, txRowOf(group, fields, now, existing));
    this.buffer.putEvents(
      group,
      () => ({ status: "deferred", result: "deferred", ref, entryId: null, matchedEntryId: null }),
      now,
    );
    this.ctx.chainEvents.set(
      group.id,
      group.events.map((e) => ({
        id: e.id,
        chain_tx_id: group.id,
        log_index: e.logIndex,
        event_name: e.name,
        status: "deferred",
        result: "deferred",
        ref,
        entry_id: null,
        matched_entry_id: null,
      })),
    );
    for (const e of group.events) this.result(e.id, e.sentId, "deferred", null, ref);
    this.deps.stats.deferred += group.events.length;
  }

  /** Results for a transaction that was already processed (events never seen before are ignored). */
  private async duplicate(group: TxGroup, existing: ChainTxRow): Promise<void> {
    const rows = new Map((this.ctx.chainEvents.get(existing.id) ?? []).map((r) => [r.id, r]));
    const fresh = group.events.filter((e) => !rows.has(e.id));
    if (fresh.length > 0) {
      this.deps.logger.warn(
        { chain_tx_id: group.id, events: fresh.map((e) => e.id) },
        "new events for an already processed transaction were ignored",
      );
      this.buffer.putEvents({ ...group, events: fresh }, () => IGNORED, this.now());
    }
    for (const e of group.events) {
      const r = rows.get(e.id);
      this.result(e.id, e.sentId, r ? "duplicate" : "ignored", r?.entry_id ?? null, r?.ref ?? null);
    }
    this.deps.stats.duplicates += group.events.length;
  }

  /** A deferred inclusion of a transaction that now appears in another block: nothing to undo. */
  private async retire(old: ChainTxRow): Promise<void> {
    const now = this.now();
    await this.tx.query(
      `UPDATE chain_tx SET status = 'reorged', reversal = 'done', deferred_reason = NULL,
              reorged_at = COALESCE(reorged_at, $2), updated_at = $2 WHERE id = $1`,
      [old.id, now],
    );
    await this.tx.query("UPDATE chain_event SET status = 'reorged', updated_at = $2 WHERE chain_tx_id = $1", [
      old.id,
      now,
    ]);
    this.ctx.chainTx.set(old.id, { ...old, status: "reorged", reversal: "done", deferred_reason: null });
  }

  /**
   * The transaction was re-included with the same effects: move its postings and row changes
   * to the new block instead of reversing and re-posting them (which could overdraw pockets the
   * credited funds were already held from).
   */
  private async rebind(old: ChainTxRow, group: TxGroup, existing: ChainTxRow | undefined): Promise<void> {
    const now = this.now();
    const oldEvents = [...(this.ctx.chainEvents.get(old.id) ?? [])].sort((a, b) => a.log_index - b.log_index);
    await this.tx.query(
      "UPDATE chain_event SET matched_entry_id = NULL, status = 'reorged', updated_at = $2 WHERE chain_tx_id = $1",
      [old.id, now],
    );
    const fields: TxFields = {
      status: "processed",
      outcome: old.outcome,
      generation: existing?.generation ?? old.generation,
      entryIds: old.entry_ids,
      effects: old.effects,
      alertedAt: old.alerted_at,
      detail: { ...old.detail, rebound_from: old.id },
      processedAt: now,
    };
    await writeTx(this.tx, group, fields, now);
    await this.tx.query(
      `UPDATE chain_tx SET status = 'reorged', reversal = 'rebound', superseded_by = $2, deferred_reason = NULL,
              reorged_at = COALESCE(reorged_at, $3), updated_at = $3 WHERE id = $1`,
      [old.id, group.id, now],
    );
    const byPosition = new Map(group.events.map((e, i) => [e.id, oldEvents[i] as ChainEventRow]));
    await writeEvents(
      this.tx,
      group,
      (id) => {
        const o = byPosition.get(id) as ChainEventRow;
        return {
          status: o.status === "reorged" ? (o.result === "suspense" ? "suspense" : "processed") : o.status,
          result: o.result,
          ref: o.ref,
          entryId: o.entry_id,
          matchedEntryId: o.matched_entry_id,
          detail: { rebound_from: o.id },
        };
      },
      now,
    );
    this.ctx.chainTx.set(old.id, { ...old, status: "reorged", reversal: "rebound", superseded_by: group.id });
    this.ctx.chainTx.set(group.id, txRowOf(group, fields, now, existing));
    this.ctx.chainEvents.set(
      group.id,
      group.events.map((e) => ({
        ...(byPosition.get(e.id) as ChainEventRow),
        id: e.id,
        chain_tx_id: group.id,
        log_index: e.logIndex,
      })),
    );
    for (const e of group.events) {
      const o = byPosition.get(e.id) as ChainEventRow;
      this.result(e.id, e.sentId, o.result, o.entry_id, o.ref);
    }
    this.deps.stats.rebound++;
  }

  /** The orphaned block is canonical again before its blocked reversal ran: keep everything. */
  private async restore(group: TxGroup, existing: ChainTxRow): Promise<void> {
    const now = this.now();
    await this.tx.query(
      `UPDATE chain_tx SET status = 'processed', reversal = 'none', reorged_at = NULL, updated_at = $2 WHERE id = $1`,
      [existing.id, now],
    );
    await this.tx.query(
      `UPDATE chain_event SET status = CASE result WHEN 'suspense' THEN 'suspense' ELSE 'processed' END, updated_at = $2
        WHERE chain_tx_id = $1`,
      [existing.id, now],
    );
    this.ctx.chainTx.set(existing.id, {
      ...existing,
      status: "processed",
      reversal: "none",
      reorged_at: null,
    });
    const rows = new Map((this.ctx.chainEvents.get(existing.id) ?? []).map((r) => [r.id, r]));
    for (const e of group.events) {
      const r = rows.get(e.id);
      this.result(e.id, e.sentId, r?.result ?? "ignored", r?.entry_id ?? null, r?.ref ?? null);
    }
  }

  /** Blocked reversals that may have become possible (after this request's own postings). */
  async retryPendingReversals(): Promise<number> {
    await this.flush();
    const r = await retryPending(
      this.deps,
      this.tx,
      this.ledger,
      this.now(),
      this.deps.cfg.reversalRetryLimit,
    );
    return r.completed;
  }
}

/** Record a transaction whose processing failed unexpectedly: deferred (`error`), resent later. */
export async function recordFailure(
  deps: EngineDeps,
  tx: SqlClient,
  group: TxGroup,
  error: unknown,
): Promise<IngestResult[]> {
  const now = deps.clock.now();
  const message = String((error as Error)?.message ?? error).slice(0, 500);
  const existing = await all<ChainTxRow>(tx, "SELECT * FROM chain_tx WHERE id = $1", [group.id]);
  const current = existing[0];
  if (current && current.status !== "deferred") {
    // Never downgrade processed or reorged evidence; report it as deferred so it is resent.
    return group.events.map((e) => ({ event_id: e.sentId, status: "deferred", entry_id: null, ref: null }));
  }
  await writeTx(
    tx,
    group,
    {
      status: "deferred",
      deferredReason: "error",
      generation: current?.generation ?? 0,
      detail: { error: message },
    },
    now,
  );
  await writeEvents(
    tx,
    group,
    () => ({
      status: "deferred",
      result: "deferred",
      ref: null,
      entryId: null,
      matchedEntryId: null,
      detail: { error: message },
    }),
    now,
  );
  return group.events.map((e) => ({ event_id: e.sentId, status: "deferred", entry_id: null, ref: null }));
}

/** Earlier processings of the same block (kept when the block is processed again after a reorg). */
function historyOf(existing: ChainTxRow | undefined): unknown[] {
  if (!existing) return [];
  const earlier = Array.isArray(existing.detail?.history) ? (existing.detail.history as unknown[]) : [];
  if (existing.status !== "reorged") return earlier;
  return [
    ...earlier,
    {
      generation: existing.generation,
      reversal: existing.reversal,
      entry_ids: existing.entry_ids,
      reversal_entry_ids: existing.reversal_entry_ids,
      superseded_by: existing.superseded_by,
    },
  ];
}

export function assertChain(cfg: ResolvedConfig, chainId: number): void {
  if (chainId !== cfg.chainId) {
    throw new AgentBankError(
      "invalid_request",
      `This reconciler handles chain ${cfg.chainId}, not ${chainId}`,
    );
  }
}
