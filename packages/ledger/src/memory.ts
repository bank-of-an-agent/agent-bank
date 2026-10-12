import { isReserveCode, refKey } from "./accounts";
import { LedgerEngine } from "./engine";
import { buildReport, compare, RESOLUTION_KINDS, violation } from "./invariants";
import type { EntryKeyRecord, LedgerStore, StoreTx } from "./store";
import type {
  EntryFilter,
  Hold,
  InvariantReport,
  InvariantViolation,
  JournalEntry,
  LedgerAccount,
  LedgerAccountRef,
  LedgerOptions,
} from "./types";
import type { EntryQuery } from "./validation";

/**
 * A fast, fully in-process {@link Ledger} for simulations and tests. It shares every business
 * rule with {@link PostgresLedger} and mirrors its storage semantics: operations run one at a
 * time (as if serializable), a failed operation leaves no trace, and the database constraints
 * (zero-sum entries, non-negative pockets, unique idempotency keys, single reversal) are
 * asserted again on every write. State lives only as long as the instance.
 */
export class InMemoryLedger extends LedgerEngine {
  constructor(options: LedgerOptions = {}) {
    super(new MemoryStore(), options);
  }
}

function compareEntries(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  return delta !== 0 ? Math.sign(delta) : compare(a.id, b.id);
}

function matches(entry: JournalEntry, filter: EntryFilter): boolean {
  const fields = ["kind", "refType", "refId", "agentId", "paymentId", "holdId", "chainEventId"] as const;
  if (fields.some((field) => filter[field] !== undefined && entry[field] !== filter[field])) return false;
  if (filter.since && entry.createdAt.getTime() < filter.since.getTime()) return false;
  if (filter.until && entry.createdAt.getTime() >= filter.until.getTime()) return false;
  if (filter.ownerRef === undefined && filter.ledgerAccountId === undefined && filter.asset === undefined)
    return true;
  return entry.lines.some(
    (line) =>
      (filter.ownerRef === undefined || line.ownerRef === filter.ownerRef) &&
      (filter.ledgerAccountId === undefined || line.ledgerAccountId === filter.ledgerAccountId) &&
      (filter.asset === undefined || line.asset === filter.asset),
  );
}

/** Thrown when a write would break a constraint the database enforces; it means an engine bug. */
class ConstraintError extends Error {
  constructor(detail: string) {
    super(`in-memory ledger constraint violated: ${detail}`);
    this.name = "ConstraintError";
  }
}

/** @internal */
export class MemoryStore implements LedgerStore, StoreTx {
  private readonly accounts = new Map<string, LedgerAccount>();
  private readonly accountIds = new Map<string, string>();
  private readonly accountsByOwnerRef = new Map<string, Set<string>>();
  private readonly entriesById = new Map<string, JournalEntry>();
  private readonly entryIdsByKey = new Map<string, string>();
  /** Line count each entry was written with (the `line_count` column in PostgreSQL). */
  private readonly lineCounts = new Map<string, number>();
  private readonly reversals = new Map<string, string>();
  private readonly holds = new Map<string, Hold>();
  private readonly pendingHolds = new Set<string>();
  private readonly history = new Map<string, { at: number; amount: bigint }[]>();
  /** Entries in ascending (createdAt, id) order. */
  private readonly timeline: JournalEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private undo: (() => void)[] = [];

  write<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.undo = [];
      try {
        return await fn(this);
      } catch (error) {
        for (const revert of this.undo.reverse()) revert();
        throw error;
      } finally {
        this.undo = [];
      }
    });
  }

  read<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.exclusive(() => fn(this));
  }

  /** One operation at a time, like a single serializable connection. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async entryByKey(key: string): Promise<EntryKeyRecord | null> {
    const id = this.entryIdsByKey.get(key);
    const entry = id === undefined ? undefined : this.entriesById.get(id);
    return entry
      ? { id: entry.id, kind: entry.kind, requestHash: entry.requestHash, holdId: entry.holdId }
      : null;
  }

  async accountsByRefs(refs: readonly LedgerAccountRef[]): Promise<LedgerAccount[]> {
    const ids = new Set<string>();
    for (const ref of refs) {
      const id = this.accountIds.get(refKey(ref));
      if (id !== undefined) ids.add(id);
    }
    return this.cloneAccounts(ids).sort((a, b) => compare(a.id, b.id));
  }

  async accountsByOwner(ownerRef: string, asset: string | null): Promise<LedgerAccount[]> {
    return this.cloneAccounts(this.accountsByOwnerRef.get(ownerRef) ?? [])
      .filter((account) => asset === null || account.asset === asset)
      .sort((a, b) => compare(a.code, b.code) || compare(a.asset, b.asset));
  }

  async insertAccounts(accounts: readonly LedgerAccount[]): Promise<void> {
    for (const account of accounts) {
      const key = refKey(account);
      if (this.accountIds.has(key)) continue;
      const stored = structuredClone(account);
      const owned = this.accountsByOwnerRef.get(stored.ownerRef) ?? new Set<string>();
      this.accounts.set(stored.id, stored);
      this.accountIds.set(key, stored.id);
      this.accountsByOwnerRef.set(stored.ownerRef, owned.add(stored.id));
      this.undo.push(() => {
        this.accounts.delete(stored.id);
        this.accountIds.delete(key);
        owned.delete(stored.id);
      });
    }
  }

  async lockAccounts(ids: readonly string[]): Promise<Map<string, LedgerAccount>> {
    const sorted = [...new Set(ids)].sort(compare);
    return new Map(this.cloneAccounts(sorted).map((account) => [account.id, account]));
  }

  async insertEntry(entry: JournalEntry): Promise<void> {
    const stored = structuredClone(entry);
    this.assertInsertable(stored);
    this.entriesById.set(stored.id, stored);
    this.entryIdsByKey.set(stored.idempotencyKey, stored.id);
    this.lineCounts.set(stored.id, stored.lines.length);
    if (stored.reversesEntryId !== null) this.reversals.set(stored.reversesEntryId, stored.id);
    let low = 0;
    let high = this.timeline.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareEntries(this.timeline[middle] as JournalEntry, stored) < 0) low = middle + 1;
      else high = middle;
    }
    this.timeline.splice(low, 0, stored);
    for (const line of stored.lines) {
      (this.accounts.get(line.ledgerAccountId) as LedgerAccount).balance += line.amount;
      const history = this.history.get(line.ledgerAccountId) ?? [];
      history.push({ at: stored.createdAt.getTime(), amount: line.amount });
      this.history.set(line.ledgerAccountId, history);
    }
    this.undo.push(() => {
      for (const line of stored.lines) {
        (this.accounts.get(line.ledgerAccountId) as LedgerAccount).balance -= line.amount;
        this.history.get(line.ledgerAccountId)?.pop();
      }
      this.timeline.splice(this.timeline.indexOf(stored), 1);
      if (stored.reversesEntryId !== null) this.reversals.delete(stored.reversesEntryId);
      this.entryIdsByKey.delete(stored.idempotencyKey);
      this.lineCounts.delete(stored.id);
      this.entriesById.delete(stored.id);
    });
  }

  /** The checks PostgreSQL makes on every journal write (constraints and commit triggers). */
  private assertInsertable(entry: JournalEntry): void {
    if (this.entriesById.has(entry.id) || this.entryIdsByKey.has(entry.idempotencyKey)) {
      throw new ConstraintError(`duplicate entry ${entry.id} / key ${entry.idempotencyKey}`);
    }
    if (entry.reversesEntryId !== null && this.reversals.has(entry.reversesEntryId)) {
      throw new ConstraintError(`entry ${entry.reversesEntryId} is already reversed`);
    }
    const totals = new Map<string, bigint>();
    const net = new Map<string, bigint>();
    for (const line of entry.lines) {
      const account = this.accounts.get(line.ledgerAccountId);
      if (
        !account ||
        account.ownerRef !== line.ownerRef ||
        account.asset !== line.asset ||
        line.amount === 0n
      ) {
        throw new ConstraintError(`entry ${entry.id} has an invalid line`);
      }
      totals.set(line.asset, (totals.get(line.asset) ?? 0n) + line.amount);
      net.set(account.id, (net.get(account.id) ?? 0n) + line.amount);
    }
    if (entry.lines.length < 2 || [...totals.values()].some((total) => total !== 0n)) {
      throw new ConstraintError(`entry ${entry.id} does not balance`);
    }
    for (const [id, delta] of net) {
      const account = this.accounts.get(id) as LedgerAccount;
      if (!account.allowNegative && account.balance + delta < 0n) {
        throw new ConstraintError(`pocket ${id} would go negative`);
      }
    }
  }

  async entries(ids: readonly string[]): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (const id of new Set(ids)) {
      const entry = this.entriesById.get(id);
      if (entry) out.push(structuredClone(entry));
    }
    return out;
  }

  async reversalOf(entryId: string): Promise<string | null> {
    return this.reversals.get(entryId) ?? null;
  }

  async hold(id: string): Promise<Hold | null> {
    const hold = this.holds.get(id);
    return hold ? structuredClone(hold) : null;
  }

  async insertHold(hold: Hold): Promise<void> {
    if (this.holds.has(hold.id)) throw new ConstraintError(`duplicate hold ${hold.id}`);
    this.holds.set(hold.id, structuredClone(hold));
    this.pendingHolds.add(hold.id);
    this.undo.push(() => {
      this.holds.delete(hold.id);
      this.pendingHolds.delete(hold.id);
    });
  }

  async updateHold(hold: Hold): Promise<void> {
    const previous = this.holds.get(hold.id) as Hold;
    this.holds.set(hold.id, {
      ...previous,
      status: hold.status,
      postedAmount: hold.postedAmount,
      resolutionEntryId: hold.resolutionEntryId,
      voidReason: hold.voidReason,
      resolvedAt: hold.resolvedAt === null ? null : new Date(hold.resolvedAt.getTime()),
    });
    const wasPending = this.pendingHolds.has(hold.id);
    if (hold.status === "pending") this.pendingHolds.add(hold.id);
    else this.pendingHolds.delete(hold.id);
    this.undo.push(() => {
      this.holds.set(hold.id, previous);
      if (wasPending) this.pendingHolds.add(hold.id);
      else this.pendingHolds.delete(hold.id);
    });
  }

  async dueHoldIds(now: Date, limit: number | null): Promise<string[]> {
    const due = [...this.pendingHolds]
      .map((id) => this.holds.get(id) as Hold)
      .filter((hold) => hold.expiresAt.getTime() <= now.getTime())
      .sort((a, b) => Math.sign(a.expiresAt.getTime() - b.expiresAt.getTime()) || compare(a.id, b.id))
      .map((hold) => hold.id);
    return limit === null ? due : due.slice(0, limit);
  }

  async balanceAt(accountId: string, at: Date): Promise<bigint> {
    let total = 0n;
    for (const line of this.history.get(accountId) ?? []) {
      if (line.at <= at.getTime()) total += line.amount;
    }
    return total;
  }

  async listEntries(query: EntryQuery): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (let index = this.timeline.length - 1; index >= 0 && out.length < query.limit; index -= 1) {
      const entry = this.timeline[index] as JournalEntry;
      if (query.cursor && compareEntries(entry, query.cursor) >= 0) continue;
      if (matches(entry, query.filter)) out.push(structuredClone(entry));
    }
    return out;
  }

  async verify(checkedAt: Date): Promise<InvariantReport> {
    return this.exclusive(async () => {
      const violations: InvariantViolation[] = [];
      const journal = new Map<string, bigint>();
      const netByEntry = new Map<string, Map<string, bigint>>();
      let lines = 0;
      for (const entry of this.entriesById.values()) {
        lines += entry.lines.length;
        const totals = new Map<string, bigint>();
        const net = new Map<string, bigint>();
        for (const line of entry.lines) {
          totals.set(line.asset, (totals.get(line.asset) ?? 0n) + line.amount);
          net.set(line.ledgerAccountId, (net.get(line.ledgerAccountId) ?? 0n) + line.amount);
          journal.set(line.ledgerAccountId, (journal.get(line.ledgerAccountId) ?? 0n) + line.amount);
        }
        netByEntry.set(entry.id, net);
        for (const [asset, total] of totals) {
          if (total !== 0n) violations.push(violation.unbalanced(entry.id, asset, total));
        }
        const written = this.lineCounts.get(entry.id) ?? 0;
        if (entry.lines.length !== written || entry.lines.length < 2) {
          violations.push(violation.lineCount(entry.id, entry.lines.length, written));
        }
      }
      const pendingByReserve = new Map<string, bigint>();
      for (const hold of this.holds.values()) {
        const reservation = this.entriesById.get(hold.entryId);
        if (reservation?.kind !== "hold" || reservation.holdId !== hold.id) {
          violations.push(violation.reservation(hold.id, hold.entryId));
        }
        if (hold.status === "pending") {
          const reserved = pendingByReserve.get(hold.reserveAccountId) ?? 0n;
          pendingByReserve.set(hold.reserveAccountId, reserved + hold.amount);
          if (hold.resolutionEntryId !== null) {
            violations.push(violation.resolution(hold.id, hold.status, hold.resolutionEntryId));
          }
        } else {
          const resolution =
            hold.resolutionEntryId === null ? undefined : this.entriesById.get(hold.resolutionEntryId);
          if (resolution?.holdId !== hold.id || resolution.kind !== RESOLUTION_KINDS[hold.status]) {
            violations.push(violation.resolution(hold.id, hold.status, hold.resolutionEntryId));
          }
        }
      }
      for (const account of this.accounts.values()) {
        const total = journal.get(account.id) ?? 0n;
        if (account.balance !== total)
          violations.push(violation.cachedBalance(account.id, account.balance, total));
        if (!account.allowNegative && (account.balance < 0n || total < 0n)) {
          violations.push(violation.negative(account.id, account.balance, total));
        }
        const pending = pendingByReserve.get(account.id) ?? 0n;
        if (isReserveCode(account.code) && total !== pending) {
          violations.push(violation.reserve(account.id, total, pending));
        }
      }
      for (const entry of this.entriesById.values()) {
        if (entry.reversesEntryId === null) continue;
        const net = netByEntry.get(entry.id) as Map<string, bigint>;
        const original = netByEntry.get(entry.reversesEntryId) ?? new Map<string, bigint>();
        const ids = new Set([...net.keys(), ...original.keys()]);
        if ([...ids].some((id) => (net.get(id) ?? 0n) !== -(original.get(id) ?? 0n))) {
          violations.push(violation.reversal(entry.id, entry.reversesEntryId));
        }
      }
      const counts = {
        accounts: this.accounts.size,
        entries: this.entriesById.size,
        lines,
        holds: this.holds.size,
      };
      return buildReport(checkedAt, counts, violations);
    });
  }

  private cloneAccounts(ids: Iterable<string>): LedgerAccount[] {
    const out: LedgerAccount[] = [];
    for (const id of ids) {
      const account = this.accounts.get(id);
      if (account) out.push(structuredClone(account));
    }
    return out;
  }
}
