import type { Clock } from "@agentbank/core";

/**
 * Public types of the Agent Bank ledger.
 *
 * Conventions used throughout:
 * - Amounts are `bigint` minor units of their asset (USDC has 6 decimals). There are no floats.
 * - A line's amount is signed: a positive amount increases the ledger account's balance, a
 *   negative amount decreases it. Every entry's lines sum to zero per asset.
 * - Pocket balances (money a bank account holds) are never negative. System accounts may be:
 *   `sys:chain:<chainId>:<asset>` is the mirror of value entering and leaving Agent Bank, so its
 *   balance is the negative of everything deposited and not yet paid out.
 * - Optional text fields are `null` (never `undefined` or `""`) on everything the ledger returns;
 *   on input, an absent field, `null` and `""` are the same request.
 */

/** The standard pockets every bank account gets from {@link Ledger.openPockets}. */
export const STANDARD_POCKETS = [
  "operating",
  "reserved",
  "fees",
  "savings",
  "escrow",
  "stream",
  "spend",
  "spend_reserved",
] as const;

/** One of the {@link STANDARD_POCKETS}. */
export type StandardPocket = (typeof STANDARD_POCKETS)[number];

/** A goal or locked vault pocket, `vault:<vlt_id>`. Agents cannot spend from vaults. */
export type VaultPocket = `vault:${string}`;

/** Any pocket name (the part of a pocket's code after `pocket:`). */
export type Pocket = StandardPocket | VaultPocket;

/**
 * Where the funds behind a ledger account physically sit. Reconciliation compares the
 * on-chain balance of each location with the sum of the pockets located there.
 */
export const FUNDS_LOCATIONS = [
  "smart_account",
  "spend_key",
  "escrow_contract",
  "stream_contract",
  "vault_contract",
  "external",
  "revenue_address",
  "none",
] as const;

/** One of the {@link FUNDS_LOCATIONS}. */
export type FundsLocation = (typeof FUNDS_LOCATIONS)[number];

/** `owner_ref` of system accounts (`sys:*` codes). */
export const SYSTEM_OWNER = "system";

/**
 * Natural key of a ledger account: who owns it, which pocket or system account it is, and its
 * asset. Build refs with {@link pocketRef}, {@link vaultRef}, {@link chainRef},
 * {@link revenueRef} and {@link suspenseRef} rather than by hand. A {@link LedgerAccount} is
 * itself a valid ref.
 */
export interface LedgerAccountRef {
  /** Bank account id (`acct_…`) for pockets, {@link SYSTEM_OWNER} for `sys:*` accounts. */
  ownerRef: string;
  /**
   * `pocket:<pocket>` (e.g. `pocket:operating`, `pocket:vault:vlt_…`) or a system code:
   * `sys:chain:<chainId>:<asset>`, `sys:revenue`, `sys:suspense`.
   */
  code: string;
  /** Asset code, e.g. `USDC`. */
  asset: string;
}

/** A ledger account: a pocket of a bank account or a system account. */
export interface LedgerAccount extends LedgerAccountRef {
  /** `lac_…` */
  id: string;
  /** Chain of the funds (pockets inherit their bank account's chain), or `null`. */
  chainId: number | null;
  location: FundsLocation;
  /** Only system accounts may go negative. */
  allowNegative: boolean;
  /** Cached balance: a projection of the sum of the account's journal lines. */
  balance: bigint;
  createdAt: Date;
}

/**
 * How an entry came about:
 * - `direct`: {@link Ledger.post};
 * - `hold`: the reservation made by {@link Ledger.hold};
 * - `hold_post` / `hold_void` / `hold_expire`: a hold's resolution;
 * - `reversal`: {@link Ledger.reverse}.
 */
export type EntryKind = "direct" | "hold" | "hold_post" | "hold_void" | "hold_expire" | "reversal";

/** One signed amount of an entry. */
export interface JournalLine extends LedgerAccountRef {
  ledgerAccountId: string;
  /** Signed minor units; positive increases the account's balance. Never zero. */
  amount: bigint;
}

/** Why money moved. Every entry carries these fields. */
export interface EntryContext {
  /** Kind of business object that caused the movement, e.g. `payment`, `deposit`, `fee`. */
  refType: string;
  /** Id of that object, e.g. `pay_…` or `cev_…`. */
  refId: string | null;
  memo: string | null;
  /** `agt_…` */
  agentId: string | null;
  /** `pay_…` */
  paymentId: string | null;
  /** `mdt_…` */
  mandateId: string | null;
  /** `dec_…` (policy decision) */
  decisionId: string | null;
  /** `cev_…` (the chain event that evidences the movement) */
  chainEventId: string | null;
  /** Free-form string pairs, e.g. a transaction hash. */
  metadata: Record<string, string>;
}

/** An immutable, balanced journal entry. */
export interface JournalEntry extends EntryContext {
  /** `ent_…` */
  id: string;
  kind: EntryKind;
  idempotencyKey: string;
  /** Canonical SHA-256 of the request that created the entry (see {@link Ledger.post}). */
  requestHash: string;
  /** The hold this entry reserves, resolves, or (for reversals) re-opens. */
  holdId: string | null;
  /** For reversals, the entry being reversed. */
  reversesEntryId: string | null;
  /** In the order they were written. */
  lines: JournalLine[];
  createdAt: Date;
}

/** Optional context fields accepted by write operations. */
export interface EntryContextInput {
  refType: string;
  refId?: string | null;
  memo?: string | null;
  agentId?: string | null;
  paymentId?: string | null;
  mandateId?: string | null;
  decisionId?: string | null;
  chainEventId?: string | null;
  /** At most 32 pairs; keys up to 64 characters, values up to 1,024. */
  metadata?: Record<string, string>;
}

/** One line of {@link PostEntryInput}. */
export interface LineInput {
  account: LedgerAccountRef;
  /** Signed, non-zero minor units. */
  amount: bigint;
}

/** Input of {@link Ledger.post}. */
export interface PostEntryInput extends EntryContextInput {
  /** Global across the ledger; namespace it, e.g. `deposit:<cev_id>`. 1–255 characters. */
  idempotencyKey: string;
  /** 2–100 lines that sum to zero per asset. */
  lines: readonly LineInput[];
}

/** Pocket a hold reserves from: `operating` (into `reserved`) or `spend` (into `spend_reserved`). */
export type HoldSource = "operating" | "spend";

/** Lifecycle of a hold. Only `pending` holds can be posted, voided or expired. */
export type HoldStatus = "pending" | "posted" | "voided" | "expired";

/** Input of {@link Ledger.hold}. */
export interface HoldInput extends Omit<EntryContextInput, "chainEventId"> {
  idempotencyKey: string;
  /** Bank account (`acct_…`) whose pockets the hold uses. */
  accountId: string;
  asset: string;
  /** Positive minor units to reserve. */
  amount: bigint;
  from: HoldSource;
  /** When {@link Ledger.expireHolds} may release the hold. Must be in the future when placed. */
  expiresAt: Date;
}

/** Funds reserved for a pending payment. */
export interface Hold {
  /** `hld_…` */
  id: string;
  idempotencyKey: string;
  requestHash: string;
  /** Bank account (`acct_…`). */
  accountId: string;
  asset: string;
  from: HoldSource;
  fromAccountId: string;
  reserveAccountId: string;
  amount: bigint;
  /** Amount that left the reserve when the hold was posted; the rest was released. */
  postedAmount: bigint | null;
  status: HoldStatus;
  expiresAt: Date;
  /** The reservation entry. */
  entryId: string;
  /** The post, void or expiry entry; `null` while pending. */
  resolutionEntryId: string | null;
  refType: string;
  refId: string | null;
  memo: string | null;
  agentId: string | null;
  paymentId: string | null;
  mandateId: string | null;
  decisionId: string | null;
  metadata: Record<string, string>;
  voidReason: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** Where posted hold funds go. */
export interface HoldDestination {
  to: LedgerAccountRef;
  /** Positive minor units. */
  amount: bigint;
}

/**
 * Context overrides for entries derived from a hold or an existing entry. Omitted fields
 * inherit the hold's (or the original entry's) values, except `chainEventId` and `metadata`.
 */
export type DerivedContextInput = Partial<EntryContextInput>;

/** Input of {@link Ledger.postHold}. */
export interface PostHoldInput extends DerivedContextInput {
  idempotencyKey: string;
  holdId: string;
  /** Amount to post, at most the held amount (default: all of it). The rest is released. */
  amount?: bigint;
  /** 1–50 destinations in the hold's asset, summing exactly to the posted amount. */
  destinations: readonly HoldDestination[];
}

/** Input of {@link Ledger.voidHold}. */
export interface VoidHoldInput extends DerivedContextInput {
  idempotencyKey: string;
  holdId: string;
  /** Why the hold was voided (deny, failure …); also the entry memo unless `memo` is given. */
  reason: string;
}

/** Input of {@link Ledger.reverse}. */
export interface ReverseInput extends Omit<DerivedContextInput, "memo"> {
  idempotencyKey: string;
  entryId: string;
  /** Why the entry is being reversed. */
  memo: string;
}

/** Input of {@link Ledger.ensureAccount}. */
export interface EnsureAccountInput extends LedgerAccountRef {
  /**
   * Chain of the funds. For `sys:chain` accounts it must match the code; revenue and suspense
   * accounts have none. Pockets inherit their bank account's chain when omitted.
   */
  chainId?: number | null;
  /** Only vault pockets choose: `smart_account` (goal vault, default) or `vault_contract` (locked). */
  location?: FundsLocation;
}

/** Options of {@link Ledger.expireHolds}. */
export interface ExpireHoldsOptions {
  /** Expire at most this many holds (oldest expiry first). Default: all due holds. */
  limit?: number;
}

/**
 * Filter of {@link Ledger.listEntries}. All fields are optional and combine with AND. The line
 * filters (`ownerRef`, `ledgerAccountId`, `asset`) must all match the same line.
 */
export interface EntryFilter {
  /** Entries with a line on a ledger account owned by this bank account (`acct_…`) or `system`. */
  ownerRef?: string;
  /** Entries with a line on this ledger account (`lac_…`). */
  ledgerAccountId?: string;
  /** Entries with a line in this asset. */
  asset?: string;
  kind?: EntryKind;
  refType?: string;
  refId?: string;
  agentId?: string;
  paymentId?: string;
  holdId?: string;
  chainEventId?: string;
  /** Created at or after this instant. */
  since?: Date;
  /** Created strictly before this instant. */
  until?: Date;
}

/** Keyset pagination of {@link Ledger.listEntries}. */
export interface PageOptions {
  /** `nextCursor` of the previous page. */
  cursor?: string | null;
  /** 1–500, default 50. */
  limit?: number;
}

/** A page of entries, newest first. */
export interface EntryPage {
  entries: JournalEntry[];
  /** Pass to the next call to continue; `null` on the last page. */
  nextCursor: string | null;
}

/** Balances of a bank account's pockets in one asset, including `vault:<vlt_id>` pockets. */
export type PocketBalances = Record<StandardPocket, bigint> & Record<VaultPocket, bigint>;

/** Sum of a bank account's pockets per funds location. Locations without pockets are absent. */
export type LocationBalances = Partial<Record<FundsLocation, bigint>>;

/** The invariants {@link Ledger.verifyInvariants} checks. */
export type InvariantName =
  /** Every entry's lines sum to zero per asset. */
  | "entry_balanced"
  /** Every entry has exactly the lines it was written with (at least two). */
  | "entry_lines"
  /** Every cached balance equals the sum of the account's lines. */
  | "cached_balance"
  /** No pocket has a negative balance. */
  | "non_negative"
  /** Every hold has its reservation entry, and every resolved hold its matching resolution entry. */
  | "hold_entries"
  /** Every reserve pocket holds exactly the sum of its pending holds. */
  | "reserve_matches_holds"
  /** Every reversal exactly negates the entry it reverses. */
  | "reversal_mirrors_original";

/** One broken invariant. */
export interface InvariantViolation {
  invariant: InvariantName;
  /** Id of the offending entry, ledger account or hold. */
  subject: string;
  detail: string;
}

/** Result of {@link Ledger.verifyInvariants}. */
export interface InvariantReport {
  /** `true` when there are no violations. */
  ok: boolean;
  checkedAt: Date;
  accounts: number;
  entries: number;
  lines: number;
  holds: number;
  /** Sorted by invariant, then subject. */
  violations: InvariantViolation[];
}

/** Options shared by both ledger implementations. */
export interface LedgerOptions {
  /** Source of `createdAt`, `resolvedAt` and id timestamps. Default: the system clock. */
  clock?: Clock;
  /** Asset codes the ledger accepts. Default: `ASSET_CODES` from `@agentbank/core`. */
  assets?: readonly string[];
}

/**
 * The Agent Bank ledger: an append-only, double-entry journal of why money moved, with
 * pockets, two-phase holds, reversals and idempotent writes.
 *
 * Every write takes an idempotency key. Keys are global across the ledger (callers should
 * namespace them, e.g. `payment:<pay_id>:hold`) and keys starting with `ledger:` are reserved.
 * Retrying a write with the same key and the same request returns the original result; the
 * same key with a different request fails with `idempotency_conflict`. Validation that depends
 * on mutable state (balances, hold status, expiry in the future) runs after the replay check,
 * so a retry still returns the original result after the world has moved on.
 *
 * Errors are `AgentBankError`s: `invalid_request`, `invalid_amount`, `unsupported_asset`,
 * `unsupported_chain` / `mainnet_locked`, `not_found`, `insufficient_funds`, `invalid_state`,
 * `idempotency_conflict` and `conflict`. A failed write changes nothing.
 */
export interface Ledger {
  /**
   * Create a ledger account if it does not exist and return it (idempotent). System accounts
   * are also created on first use by any write. Fails with `conflict` when the account exists
   * with a different explicitly requested `chainId` or `location`.
   */
  ensureAccount(input: EnsureAccountInput): Promise<LedgerAccount>;

  /**
   * Create all {@link STANDARD_POCKETS} of a bank account for one asset on one (testnet) chain.
   * Idempotent; fails with `conflict` if a pocket exists on another chain. Vault pockets are
   * created separately with {@link Ledger.ensureAccount} and {@link vaultRef}.
   * @returns the standard pockets in {@link STANDARD_POCKETS} order.
   */
  openPockets(accountId: string, asset: string, chainId: number): Promise<LedgerAccount[]>;

  /** Look up a ledger account; `not_found` if it does not exist. */
  getAccount(ref: LedgerAccountRef): Promise<LedgerAccount>;

  /** All ledger accounts of an owner (`acct_…` or `system`), optionally of one asset, by code. */
  listAccounts(ownerRef: string, asset?: string): Promise<LedgerAccount[]>;

  /**
   * Post a balanced entry. Lines must be non-zero bigints that sum to zero per asset; the same
   * ledger account may appear more than once (only its net change matters for the balance
   * check). Pockets must exist (`not_found`); system accounts are created on first use.
   * Fails with `insufficient_funds` if a pocket would go negative. The hold-managed pockets
   * `reserved` and `spend_reserved` cannot be posted to directly (`invalid_request`).
   */
  post(input: PostEntryInput): Promise<JournalEntry>;

  /**
   * Reserve funds for a pending payment: moves `amount` from `operating` to `reserved` (or
   * from `spend` to `spend_reserved`). Fails with `insufficient_funds` when the source pocket
   * cannot cover it. A replay returns the hold in its current state.
   */
  hold(input: HoldInput): Promise<Hold>;

  /**
   * Post a pending hold, typically on chain confirmation: releases the whole reserve, sends
   * `amount` (default: all of it) to the destinations and returns any remainder to the source
   * pocket. Destinations must sum to the posted amount, so a payment and its fee are two
   * destinations. Pending holds can be posted even after `expiresAt` (chain evidence wins);
   * `invalid_state` if the hold is no longer pending.
   */
  postHold(input: PostHoldInput): Promise<JournalEntry>;

  /** Release a pending hold back to its source pocket; `invalid_state` if not pending. */
  voidHold(input: VoidHoldInput): Promise<JournalEntry>;

  /**
   * Release every pending hold whose `expiresAt` is at or before `now`, each in its own
   * transaction, oldest first.
   * @returns how many holds this call expired.
   */
  expireHolds(now: Date, options?: ExpireHoldsOptions): Promise<number>;

  /**
   * Post the exact negation of an entry, with `reversesEntryId` set. An entry can be reversed
   * at most once, a reversal cannot itself be reversed, and a hold's reservation cannot be
   * reversed (void the hold instead); all of these fail with `invalid_state`. Reversing a
   * hold's post, void or expiry entry re-opens the hold as pending, which is how a chain reorg
   * undoes a settlement. Context fields default to the original entry's.
   */
  reverse(input: ReverseInput): Promise<JournalEntry>;

  /**
   * Cached balance of a ledger account. A system account that has not been used yet has a
   * balance of zero; an unknown pocket is `not_found`.
   */
  balance(ref: LedgerAccountRef): Promise<bigint>;

  /** Balance from the journal as of `at` (entries created at or before it). Same lookup rules as {@link Ledger.balance}. */
  balanceAt(ref: LedgerAccountRef, at: Date): Promise<bigint>;

  /**
   * Balances of all pockets of a bank account in one asset, including vault pockets. Standard
   * pockets that were never opened read as zero; `not_found` if the account has no pockets.
   */
  pocketBalances(accountId: string, asset: string): Promise<PocketBalances>;

  /** Pocket balances summed by funds location, for reconciliation against chain balances. */
  locationBalances(accountId: string, asset: string): Promise<LocationBalances>;

  /** An entry with its lines; `not_found` if unknown. */
  getEntry(id: string): Promise<JournalEntry>;

  /** A hold in its current state; `not_found` if unknown. */
  getHold(id: string): Promise<Hold>;

  /**
   * Entries matching `filter`, newest first (`createdAt`, then id, descending), with keyset
   * pagination that is stable while new entries are written.
   */
  listEntries(filter?: EntryFilter, page?: PageOptions): Promise<EntryPage>;

  /**
   * Recompute every invariant from the journal and report violations. A clean report is the
   * evidence the nightly job and the test suites assert on.
   */
  verifyInvariants(): Promise<InvariantReport>;
}
