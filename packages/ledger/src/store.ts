import type { EntryQuery } from "./validation";
import type {
  EntryKind,
  Hold,
  InvariantReport,
  JournalEntry,
  LedgerAccount,
  LedgerAccountRef,
} from "./types";

/**
 * Storage behind {@link LedgerEngine}. The engine owns every business rule (validation,
 * idempotency, balance checks, hold lifecycle); a store only persists and queries. Both
 * implementations must behave identically for the same calls, which the shared behavioural
 * suite and the differential property tests check.
 *
 * @internal
 */
export interface StoreTx {
  /** The entry written with this idempotency key, if any. */
  entryByKey(key: string): Promise<EntryKeyRecord | null>;
  /** Existing accounts among `refs`, in any order. */
  accountsByRefs(refs: readonly LedgerAccountRef[]): Promise<LedgerAccount[]>;
  /** An owner's accounts, optionally of one asset, ordered by code then asset (bytewise). */
  accountsByOwner(ownerRef: string, asset: string | null): Promise<LedgerAccount[]>;
  /** Insert accounts, silently skipping any whose (ownerRef, code, asset) already exists. */
  insertAccounts(accounts: readonly LedgerAccount[]): Promise<void>;
  /** Lock accounts for update in id order and return their current state. */
  lockAccounts(ids: readonly string[]): Promise<Map<string, LedgerAccount>>;
  /** Append an entry with its lines and apply them to the cached balances. */
  insertEntry(entry: JournalEntry): Promise<void>;
  /** Entries with these ids, in any order. */
  entries(ids: readonly string[]): Promise<JournalEntry[]>;
  /** Id of the entry reversing `entryId`, if any. */
  reversalOf(entryId: string): Promise<string | null>;
  /** A hold, optionally locked for update. */
  hold(id: string, lock: boolean): Promise<Hold | null>;
  insertHold(hold: Hold): Promise<void>;
  /** Persist a hold's status, posted amount, resolution entry, void reason and resolution time. */
  updateHold(hold: Hold): Promise<void>;
  /** Ids of pending holds with `expiresAt <= now`, oldest expiry first. */
  dueHoldIds(now: Date, limit: number | null): Promise<string[]>;
  /** Sum of an account's lines created at or before `at`. */
  balanceAt(accountId: string, at: Date): Promise<bigint>;
  /** Up to `query.limit` entries matching the query, newest first. */
  listEntries(query: EntryQuery): Promise<JournalEntry[]>;
}

/** @internal */
export interface EntryKeyRecord {
  id: string;
  kind: EntryKind;
  requestHash: string;
  holdId: string | null;
}

/** @internal */
export interface LedgerStore {
  /** Run `fn` atomically and in isolation (serializable); on error nothing is written. */
  write<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** Run read-only `fn` against committed state. */
  read<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** Recompute every invariant from the journal. */
  verify(checkedAt: Date): Promise<InvariantReport>;
}
