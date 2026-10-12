import type { EntryKind, HoldStatus, InvariantReport, InvariantViolation } from "./types";

/** Violation constructors shared by both stores, so reports read the same everywhere. */
export const violation = {
  unbalanced: (entryId: string, asset: string, total: bigint | string): InvariantViolation => ({
    invariant: "entry_balanced",
    subject: entryId,
    detail: `${asset} lines sum to ${total}, not zero`,
  }),
  lineCount: (entryId: string, actual: number, expected: number): InvariantViolation => ({
    invariant: "entry_lines",
    subject: entryId,
    detail: `has ${actual} lines, expected ${expected}`,
  }),
  cachedBalance: (
    accountId: string,
    cached: bigint | string,
    journal: bigint | string,
  ): InvariantViolation => ({
    invariant: "cached_balance",
    subject: accountId,
    detail: `cached balance ${cached} but its lines sum to ${journal}`,
  }),
  negative: (accountId: string, cached: bigint | string, journal: bigint | string): InvariantViolation => ({
    invariant: "non_negative",
    subject: accountId,
    detail: `pocket is negative (cached ${cached}, journal ${journal})`,
  }),
  reservation: (holdId: string, entryId: string): InvariantViolation => ({
    invariant: "hold_entries",
    subject: holdId,
    detail: `reservation entry ${entryId} is missing or does not reserve this hold`,
  }),
  resolution: (holdId: string, status: HoldStatus, entryId: string | null): InvariantViolation => ({
    invariant: "hold_entries",
    subject: holdId,
    detail:
      status === "pending"
        ? `pending hold has resolution entry ${entryId}`
        : `${status} hold lacks a matching ${RESOLUTION_KINDS[status]} entry (has ${entryId ?? "none"})`,
  }),
  reserve: (accountId: string, journal: bigint | string, pending: bigint | string): InvariantViolation => ({
    invariant: "reserve_matches_holds",
    subject: accountId,
    detail: `reserve pocket holds ${journal} but its pending holds total ${pending}`,
  }),
  reversal: (entryId: string, originalId: string): InvariantViolation => ({
    invariant: "reversal_mirrors_original",
    subject: entryId,
    detail: `does not exactly negate ${originalId}`,
  }),
};

/** The entry kind that resolves a hold into each final status. */
export const RESOLUTION_KINDS: Readonly<Record<Exclude<HoldStatus, "pending">, EntryKind>> = {
  posted: "hold_post",
  voided: "hold_void",
  expired: "hold_expire",
};

/** Assemble a report with violations sorted by invariant, then subject, then detail. */
export function buildReport(
  checkedAt: Date,
  counts: { accounts: number; entries: number; lines: number; holds: number },
  violations: InvariantViolation[],
): InvariantReport {
  const sorted = [...violations].sort((a, b) =>
    a.invariant !== b.invariant
      ? compare(a.invariant, b.invariant)
      : a.subject !== b.subject
        ? compare(a.subject, b.subject)
        : compare(a.detail, b.detail),
  );
  return { ok: sorted.length === 0, checkedAt, ...counts, violations: sorted };
}

/** Bytewise (code unit) string order, matching `COLLATE "C"` for the ASCII ids the ledger uses. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
