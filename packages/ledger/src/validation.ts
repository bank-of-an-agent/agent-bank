import {
  AgentBankError,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalSha256,
  isId,
  MAX_MINOR_UNITS,
  utf8,
  type IdKind,
} from "@agentbank/core";
import { assertAccountId, assertAsset, isReserveCode, resolveRef, type ResolvedRef } from "./accounts";
import {
  SYSTEM_OWNER,
  type EntryContext,
  type EntryFilter,
  type EntryKind,
  type HoldSource,
  type PageOptions,
} from "./types";

/**
 * Validation and normalisation of every ledger input, shared by both implementations so they
 * accept, reject and hash requests identically. Nothing here depends on ledger state.
 */

export const MAX_LINES = 100;
export const MAX_DESTINATIONS = 50;
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;
/** Idempotency keys the ledger generates itself (hold expiry) use this prefix. */
export const RESERVED_KEY_PREFIX = "ledger:";

const ENTRY_KINDS: readonly EntryKind[] = [
  "direct",
  "hold",
  "hold_post",
  "hold_void",
  "hold_expire",
  "reversal",
];
const HOLD_SOURCES: readonly HoldSource[] = ["operating", "spend"];
const CONTEXT_IDS = {
  agentId: "agent",
  paymentId: "payment",
  mandateId: "mandate",
  decisionId: "decision",
  chainEventId: "chainEvent",
} as const satisfies Partial<Record<keyof EntryContext, IdKind>>;
const MAX_METADATA_KEYS = 32;

/** A validated line or destination. */
export interface NormalizedLine {
  resolved: ResolvedRef;
  amount: bigint;
}

export interface PostRequest {
  key: string;
  hash: string;
  lines: NormalizedLine[];
  context: EntryContext;
}

export interface HoldRequest {
  key: string;
  hash: string;
  accountId: string;
  asset: string;
  amount: bigint;
  from: HoldSource;
  expiresAt: Date;
  context: EntryContext;
}

export interface PostHoldRequest {
  key: string;
  hash: string;
  holdId: string;
  amount: bigint | null;
  destinations: NormalizedLine[];
  overrides: Partial<EntryContext>;
}

export interface VoidRequest {
  key: string;
  hash: string;
  holdId: string;
  reason: string;
  overrides: Partial<EntryContext>;
}

export interface ReverseRequest {
  key: string;
  hash: string;
  entryId: string;
  overrides: Partial<EntryContext>;
}

export interface EntryCursor {
  createdAt: Date;
  id: string;
}

export interface EntryQuery {
  filter: EntryFilter;
  cursor: EntryCursor | null;
  limit: number;
}

function invalid(detail: string): AgentBankError {
  return new AgentBankError("invalid_request", detail);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** An idempotency key: 1–255 characters, not in the reserved `ledger:` namespace. */
export function normalizeKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw invalid("idempotencyKey must be a string of 1 to 255 characters");
  }
  if (value.startsWith(RESERVED_KEY_PREFIX)) {
    throw invalid(`Idempotency keys starting with "${RESERVED_KEY_PREFIX}" are reserved`);
  }
  return value;
}

/** A bigint amount within the bigint column range, non-zero (or positive when `positive`). */
export function normalizeAmount(value: unknown, what: string, positive: boolean): bigint {
  if (typeof value !== "bigint") {
    throw new AgentBankError("invalid_amount", `${what} must be a bigint of minor units`);
  }
  if (positive ? value <= 0n : value === 0n) {
    throw new AgentBankError(
      "invalid_amount",
      `${what} must be ${positive ? "greater than" : "different from"} zero`,
    );
  }
  if (value > MAX_MINOR_UNITS || value < -MAX_MINOR_UNITS) {
    throw new AgentBankError("invalid_amount", `${what} exceeds the supported range`);
  }
  return value;
}

/** Optional text: absent, `null` and `""` all mean "none" (and hash the same). */
function normalizeText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) {
    throw invalid(`${field} must be a string of at most ${max} characters`);
  }
  return value;
}

function requireText(value: unknown, field: string, max: number): string {
  const text = normalizeText(value, field, max);
  if (text === null) throw invalid(`${field} is required`);
  return text;
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const input = record(value, "metadata");
  const keys = Object.keys(input).sort();
  if (keys.length > MAX_METADATA_KEYS) throw invalid(`metadata has more than ${MAX_METADATA_KEYS} keys`);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const item = input[key];
    if (key.length > 64 || typeof item !== "string" || item.length > 1024) {
      throw invalid("metadata keys must be at most 64 characters and values strings of at most 1,024");
    }
    out[key] = item;
  }
  return out;
}

/** Validate the context fields present in `input`; absent fields are left out. */
function normalizeOverrides(input: Record<string, unknown>): Partial<EntryContext> {
  const out: Partial<EntryContext> = {};
  if (input.refType !== undefined) out.refType = requireText(input.refType, "refType", 64);
  if (input.refId !== undefined) out.refId = normalizeText(input.refId, "refId", 255);
  if (input.memo !== undefined) out.memo = normalizeText(input.memo, "memo", 2000);
  for (const [field, kind] of Object.entries(CONTEXT_IDS) as [keyof typeof CONTEXT_IDS, IdKind][]) {
    const value = input[field];
    if (value === undefined) continue;
    if (value !== null && !isId(kind, value)) throw invalid(`${field} must be a ${kind} id`);
    out[field] = value;
  }
  if (input.metadata !== undefined) out.metadata = normalizeMetadata(input.metadata);
  return out;
}

/** A complete context: `refType` is required and absent fields become `null` / `{}`. */
export function normalizeContext(input: Record<string, unknown>): EntryContext {
  const overrides = normalizeOverrides(input);
  return {
    refType: requireText(overrides.refType, "refType", 64),
    refId: overrides.refId ?? null,
    memo: overrides.memo ?? null,
    agentId: overrides.agentId ?? null,
    paymentId: overrides.paymentId ?? null,
    mandateId: overrides.mandateId ?? null,
    decisionId: overrides.decisionId ?? null,
    chainEventId: overrides.chainEventId ?? null,
    metadata: overrides.metadata ?? {},
  };
}

function hashRequest(op: string, body: Record<string, unknown>): string {
  return canonicalSha256({ op, ...body });
}

function lineBody(line: NormalizedLine): Record<string, unknown> {
  return { ...line.resolved.ref, amount: line.amount };
}

function normalizeLines(
  value: unknown,
  what: string,
  limits: { min: number; max: number },
  assets: ReadonlySet<string>,
  read: (item: Record<string, unknown>) => { account: unknown; amount: unknown },
  positive: boolean,
): NormalizedLine[] {
  if (!Array.isArray(value) || value.length < limits.min || value.length > limits.max) {
    throw invalid(`${what} must be an array of ${limits.min} to ${limits.max} items`);
  }
  return value.map((item: unknown, index) => {
    const fields = read(record(item, `${what}[${index}]`));
    const resolved = resolveRef(fields.account, assets);
    if (isReserveCode(resolved.ref.code)) {
      throw invalid(`${resolved.ref.code} changes only through holds`);
    }
    return { resolved, amount: normalizeAmount(fields.amount, `${what}[${index}].amount`, positive) };
  });
}

/** Validate {@link Ledger.post} input. */
export function normalizePost(value: unknown, assets: ReadonlySet<string>): PostRequest {
  const input = record(value, "entry");
  const key = normalizeKey(input.idempotencyKey);
  const lines = normalizeLines(
    input.lines,
    "lines",
    { min: 2, max: MAX_LINES },
    assets,
    (line) => ({ account: line.account, amount: line.amount }),
    false,
  );
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    const asset = line.resolved.ref.asset;
    totals.set(asset, (totals.get(asset) ?? 0n) + line.amount);
  }
  for (const [asset, total] of totals) {
    if (total !== 0n) {
      throw new AgentBankError("invalid_amount", `Entry does not balance: ${asset} lines sum to ${total}`);
    }
  }
  const context = normalizeContext(input);
  return { key, hash: hashRequest("post", { lines: lines.map(lineBody), ...context }), lines, context };
}

/** Validate {@link Ledger.hold} input. */
export function normalizeHold(value: unknown, assets: ReadonlySet<string>): HoldRequest {
  const input = record(value, "hold");
  const key = normalizeKey(input.idempotencyKey);
  assertAccountId(input.accountId);
  assertAsset(input.asset, assets);
  const amount = normalizeAmount(input.amount, "amount", true);
  if (!HOLD_SOURCES.includes(input.from as HoldSource)) throw invalid('from must be "operating" or "spend"');
  const expiresAt = normalizeDate(input.expiresAt, "expiresAt");
  const context = normalizeContext({ ...input, chainEventId: undefined });
  const body = {
    accountId: input.accountId,
    asset: input.asset,
    amount,
    from: input.from,
    expiresAt,
    ...context,
  };
  return {
    key,
    hash: hashRequest("hold", body),
    accountId: input.accountId,
    asset: input.asset,
    amount,
    from: input.from as HoldSource,
    expiresAt,
    context,
  };
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw invalid(`${field} must be an id`);
  }
  return value;
}

/** Validate {@link Ledger.postHold} input. */
export function normalizePostHold(value: unknown, assets: ReadonlySet<string>): PostHoldRequest {
  const input = record(value, "postHold");
  const key = normalizeKey(input.idempotencyKey);
  const holdId = normalizeId(input.holdId, "holdId");
  const amount = input.amount === undefined ? null : normalizeAmount(input.amount, "amount", true);
  const destinations = normalizeLines(
    input.destinations,
    "destinations",
    { min: 1, max: MAX_DESTINATIONS },
    assets,
    (destination) => ({ account: destination.to, amount: destination.amount }),
    true,
  );
  if (amount !== null) assertDestinationsSum(destinations, amount);
  const overrides = normalizeOverrides(input);
  const body = { holdId, amount, destinations: destinations.map(lineBody), overrides };
  return { key, hash: hashRequest("post_hold", body), holdId, amount, destinations, overrides };
}

/** `invalid_amount` unless the destinations add up to exactly the posted amount. */
export function assertDestinationsSum(destinations: readonly NormalizedLine[], amount: bigint): void {
  let total = 0n;
  for (const destination of destinations) total += destination.amount;
  if (total !== amount) {
    throw new AgentBankError(
      "invalid_amount",
      `Destinations sum to ${total} but the posted amount is ${amount}`,
    );
  }
}

/** Validate {@link Ledger.voidHold} input. */
export function normalizeVoid(value: unknown): VoidRequest {
  const input = record(value, "voidHold");
  const key = normalizeKey(input.idempotencyKey);
  const holdId = normalizeId(input.holdId, "holdId");
  const reason = requireText(input.reason, "reason", 500);
  const overrides = normalizeOverrides(input);
  return { key, hash: hashRequest("void_hold", { holdId, reason, overrides }), holdId, reason, overrides };
}

/** Validate {@link Ledger.reverse} input. */
export function normalizeReverse(value: unknown): ReverseRequest {
  const input = record(value, "reverse");
  const key = normalizeKey(input.idempotencyKey);
  const entryId = normalizeId(input.entryId, "entryId");
  requireText(input.memo, "memo", 2000);
  const overrides = normalizeOverrides(input);
  return { key, hash: hashRequest("reverse", { entryId, overrides }), entryId, overrides };
}

/** A valid `Date`. */
export function normalizeDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw invalid(`${field} must be a valid Date`);
  return new Date(value.getTime());
}

/** `system` or a bank account id. */
export function normalizeOwner(value: unknown): string {
  if (value !== SYSTEM_OWNER) assertAccountId(value);
  return value as string;
}

/** A positive safe integer, or `null` when absent. */
export function normalizeLimit(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw invalid(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

const FILTER_TEXT_FIELDS = [
  "ownerRef",
  "ledgerAccountId",
  "asset",
  "refType",
  "refId",
  "agentId",
  "paymentId",
  "holdId",
  "chainEventId",
] as const;

/** Validate {@link Ledger.listEntries} arguments. */
export function normalizeQuery(filter: unknown, page: unknown): EntryQuery {
  const rawFilter = filter === undefined ? {} : record(filter, "filter");
  const rawPage = page === undefined ? {} : record(page, "page");
  const out: EntryFilter = {};
  for (const field of FILTER_TEXT_FIELDS) {
    const value = rawFilter[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 255) {
      throw invalid(`filter.${field} must be a non-empty string`);
    }
    out[field] = value;
  }
  if (rawFilter.kind !== undefined) {
    if (!ENTRY_KINDS.includes(rawFilter.kind as EntryKind)) throw invalid("filter.kind is not an entry kind");
    out.kind = rawFilter.kind as EntryKind;
  }
  if (rawFilter.since !== undefined) out.since = normalizeDate(rawFilter.since, "filter.since");
  if (rawFilter.until !== undefined) out.until = normalizeDate(rawFilter.until, "filter.until");
  const { cursor, limit } = rawPage as PageOptions;
  return {
    filter: out,
    cursor: cursor === undefined || cursor === null ? null : decodeCursor(cursor),
    limit: normalizeLimit(limit, "limit", MAX_PAGE_SIZE) ?? DEFAULT_PAGE_SIZE,
  };
}

/** Opaque keyset cursor for the entry after which a page continues. */
export function encodeCursor(entry: { createdAt: Date; id: string }): string {
  return bytesToBase64Url(utf8(JSON.stringify([entry.createdAt.toISOString(), entry.id])));
}

/** Inverse of {@link encodeCursor}; `invalid_request` for anything else. */
export function decodeCursor(value: unknown): EntryCursor {
  try {
    if (typeof value !== "string") throw new TypeError("not a string");
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [at, id] = parsed as unknown[];
      const createdAt = typeof at === "string" ? new Date(at) : null;
      if (typeof id === "string" && id.length > 0 && createdAt && !Number.isNaN(createdAt.getTime())) {
        return { createdAt, id };
      }
    }
  } catch {
    // fall through
  }
  throw invalid("cursor is not a cursor returned by listEntries");
}
