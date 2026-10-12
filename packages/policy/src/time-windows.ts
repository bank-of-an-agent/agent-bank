import { AgentBankError, WEEKDAYS } from "@agentbank/core";

/**
 * Time windows ("business hours only").
 *
 * Each window is expanded at compile time into a table of the allowed minutes
 * of the *local* week (Monday 00:00 = minute 0) in its IANA time zone. At
 * evaluation the instant is converted to local wall-clock time with
 * `Intl.DateTimeFormat`, which is deterministic for a given instant and tz
 * database, so DST is handled by the platform: local times skipped by a
 * spring-forward never occur, and repeated fall-back times are allowed iff
 * their wall-clock minute is.
 *
 * A window covers `[start, end)`. `end` may be `24:00`. A window whose `start`
 * is after its `end` runs overnight into the next day (`fri 22:00-02:00`
 * covers Friday 22:00 to Saturday 02:00). `start == end` is rejected as
 * ambiguous.
 */

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MS_PER_MINUTE = 60_000;

/** Allowed local minutes of one time zone. */
export interface ZoneWindows {
  /** `flags[m] === 1` when local minute-of-week `m` is allowed. Never mutate. */
  readonly flags: Uint8Array;
}

/** Compiled `time_windows`: allowed local minutes per canonical time zone. */
export interface CompiledTimeWindows {
  readonly zones: ReadonlyMap<string, ZoneWindows>;
}

/** Input shape of one window (the `TimeWindowSchema` of `@agentbank/core`). */
export interface TimeWindowInput {
  days: readonly (typeof WEEKDAYS)[number][];
  start: string;
  end: string;
  timezone?: string;
}

const CLOCK_RE = /^([0-9]{2}):([0-9]{2})$/;
const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

interface LocalTime {
  weekday: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localTime(zone: string, epochMs: number): LocalTime {
  const out: LocalTime = { weekday: -1, year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter(zone).formatToParts(epochMs)) {
    switch (part.type) {
      case "weekday":
        out.weekday = WEEKDAY_INDEX[part.value] ?? -1;
        break;
      case "year":
      case "month":
      case "day":
      case "minute":
      case "second":
        out[part.type] = Number.parseInt(part.value, 10);
        break;
      case "hour":
        out.hour = Number.parseInt(part.value, 10) % 24;
        break;
      default:
        break;
    }
  }
  if (out.weekday < 0) throw new Error(`could not resolve the local weekday in ${zone}`);
  return out;
}

/**
 * Canonical IANA name of a time zone (`utc` → `UTC`), or an
 * `invalid_request` error when the runtime does not know it.
 */
export function canonicalTimeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new AgentBankError("invalid_request", `Unknown time zone "${zone}"`);
  }
}

/** Local minute of the week (Monday 00:00 = 0) of an instant in a time zone. */
export function localMinuteOfWeek(zone: string, at: Date | number): number {
  const t = localTime(zone, typeof at === "number" ? at : at.getTime());
  return t.weekday * MINUTES_PER_DAY + t.hour * 60 + t.minute;
}

/** UTC offset of a time zone at an instant, in whole minutes (east positive). */
export function utcOffsetMinutes(zone: string, at: Date | number): number {
  const ms = typeof at === "number" ? at : at.getTime();
  const t = localTime(zone, ms);
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  return Math.round((wall - (ms - mod(ms, 1000))) / MS_PER_MINUTE);
}

function parseClock(value: string, path: string): number {
  const match = CLOCK_RE.exec(value);
  if (match === null) throw new AgentBankError("invalid_request", `${path} must be HH:MM`);
  const minutes = Number.parseInt(match[1] ?? "", 10) * 60 + Number.parseInt(match[2] ?? "", 10);
  if (minutes > MINUTES_PER_DAY) {
    throw new AgentBankError("invalid_request", `${path} must be at most 24:00`);
  }
  return minutes;
}

/**
 * Navigation tables of a minute table, computed on first use (only denials
 * need them) and cached per table:
 * - `next[m]`: minutes from `m` to the next allowed minute (0 if allowed, -1 if none);
 * - `back[m]`: minutes since the allowed run containing `m` began (-1 if not allowed).
 */
const navigation = new WeakMap<Uint8Array, { next: Int32Array; back: Int32Array }>();

function navigate(flags: Uint8Array): { next: Int32Array; back: Int32Array } {
  let tables = navigation.get(flags);
  if (tables === undefined) {
    tables = { next: nextAllowed(flags), back: runOffsets(flags) };
    navigation.set(flags, tables);
  }
  return tables;
}

function nextAllowed(flags: Uint8Array): Int32Array {
  const next = new Int32Array(MINUTES_PER_WEEK);
  let distance = -1;
  for (let k = 2 * MINUTES_PER_WEEK - 1; k >= 0; k--) {
    const m = k % MINUTES_PER_WEEK;
    if (flags[m] === 1) distance = 0;
    else if (distance >= 0) distance++;
    if (k < MINUTES_PER_WEEK) next[m] = distance;
  }
  return next;
}

function runOffsets(flags: Uint8Array): Int32Array {
  const back = new Int32Array(MINUTES_PER_WEEK).fill(-1);
  const firstClosed = flags.indexOf(0);
  if (firstClosed < 0) return back.fill(0);
  let run = -1;
  for (let k = 1; k <= MINUTES_PER_WEEK; k++) {
    const m = (firstClosed + k) % MINUTES_PER_WEEK;
    run = flags[m] === 1 ? run + 1 : -1;
    back[m] = run;
  }
  return back;
}

/**
 * Compile `time_windows` into per-zone minute tables. Throws
 * `invalid_request` for unknown time zones, `end` after 24:00, and windows
 * whose `start` equals their `end`.
 */
export function compileTimeWindows(windows: readonly TimeWindowInput[]): CompiledTimeWindows {
  const flagsByZone = new Map<string, Uint8Array>();
  windows.forEach((window, i) => {
    const path = `time_windows[${i}]`;
    const zone = canonicalTimeZone(window.timezone ?? "UTC");
    const start = parseClock(window.start, `${path}.start`);
    const end = parseClock(window.end, `${path}.end`);
    if (start >= MINUTES_PER_DAY) {
      throw new AgentBankError("invalid_request", `${path}.start must be before 24:00`);
    }
    if (start === end) {
      throw new AgentBankError("invalid_request", `${path} is ambiguous: start equals end`);
    }
    let flags = flagsByZone.get(zone);
    if (flags === undefined) {
      flags = new Uint8Array(MINUTES_PER_WEEK);
      flagsByZone.set(zone, flags);
    }
    for (const day of window.days) {
      const d = WEEKDAYS.indexOf(day);
      if (d < 0) throw new AgentBankError("invalid_request", `${path}.days has an unknown day "${day}"`);
      const base = d * MINUTES_PER_DAY;
      if (start < end) {
        flags.fill(1, base + start, base + end);
      } else {
        flags.fill(1, base + start, base + MINUTES_PER_DAY);
        const nextBase = ((d + 1) % 7) * MINUTES_PER_DAY;
        flags.fill(1, nextBase, nextBase + end);
      }
    }
  });
  const zones = new Map<string, ZoneWindows>();
  for (const zone of [...flagsByZone.keys()].sort()) {
    const flags = flagsByZone.get(zone) as Uint8Array;
    zones.set(zone, Object.freeze({ flags }));
  }
  return { zones };
}

/** Whether an instant falls inside any window. */
export function isWithinTimeWindows(windows: CompiledTimeWindows, at: Date): boolean {
  const ms = at.getTime();
  for (const [zone, table] of windows.zones) {
    if (table.flags[localMinuteOfWeek(zone, ms)] === 1) return true;
  }
  return false;
}

/**
 * The earliest instant at or after `from` that falls inside a window, or
 * `null` when the windows allow no time at all. Advisory: use it for
 * `retryAt`, never for authorization.
 *
 * It jumps to the next allowed local minute, re-checks in case a DST
 * transition moved the wall clock on the way, and steps back to the start of
 * the local run it landed in, so the result is exact except in the rare
 * combination of a run that itself spans a transition.
 */
export function nextTimeWindowOpening(windows: CompiledTimeWindows, from: Date): Date | null {
  const start = from.getTime();
  let t = start - mod(start, MS_PER_MINUTE);
  for (let iteration = 0; iteration < 16; iteration++) {
    let best = -1;
    let found: number | null = null;
    for (const [zone, table] of windows.zones) {
      const { next, back } = navigate(table.flags);
      const m = localMinuteOfWeek(zone, t);
      const distance = next[m] ?? -1;
      if (distance === 0) {
        let candidate = t;
        const earlier = t - (back[m] ?? 0) * MS_PER_MINUTE;
        if (earlier > start && table.flags[localMinuteOfWeek(zone, earlier)] === 1) candidate = earlier;
        found = found === null ? candidate : Math.min(found, candidate);
      } else if (distance > 0 && (best < 0 || distance < best)) {
        best = distance;
      }
    }
    if (found !== null) return new Date(Math.max(found, start));
    if (best < 0) return null;
    t += best * MS_PER_MINUTE;
  }
  return new Date(t);
}

// ------------------------------------------------------------------ comparison

/**
 * Offsets are sampled every 12 hours over 2025-2030 when windows in different
 * time zones are compared. Real-world offsets last weeks at least, so no
 * offset a zone takes in that span is missed.
 */
const REFERENCE_START_MS = Date.UTC(2025, 0, 1);
const REFERENCE_END_MS = Date.UTC(2031, 0, 1);
const REFERENCE_STEP_MS = 12 * 60 * MS_PER_MINUTE;
/** Above this many offset combinations a cross-zone change is classified as both tighter and looser. */
export const MAX_OFFSET_COMBINATIONS = 4096;

const offsetCache = new Map<string, readonly number[]>();

/** Every distinct UTC offset (minutes) a zone takes over the reference span, ascending. */
export function zoneOffsets(zone: string): readonly number[] {
  let offsets = offsetCache.get(zone);
  if (offsets === undefined) {
    const seen = new Set<number>();
    for (let t = REFERENCE_START_MS; t < REFERENCE_END_MS; t += REFERENCE_STEP_MS) {
      seen.add(utcOffsetMinutes(zone, t));
    }
    offsets = [...seen].sort((a, b) => a - b);
    offsetCache.set(zone, offsets);
  }
  return offsets;
}

const FULL = new Uint8Array(MINUTES_PER_WEEK).fill(1);
const EMPTY = new Uint8Array(MINUTES_PER_WEEK);

/** Result of comparing two sets of time windows. */
export interface TimeWindowComparison {
  /** Some time allowed before is no longer allowed (a tightening). */
  narrower: boolean;
  /** Some time not allowed before is now allowed (a loosening). */
  wider: boolean;
}

/** 32-bit view of a minute table (10080 = 2520 × 4 bytes), for word-at-a-time comparisons. */
function words(table: Uint8Array): Uint32Array {
  const aligned = table.byteOffset % 4 === 0 ? table : new Uint8Array(table);
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >>> 2);
}

function diff(prev: Uint8Array, next: Uint8Array, into: TimeWindowComparison): void {
  const p = words(prev);
  const n = words(next);
  for (let i = 0; i < p.length; i++) {
    const a = p[i] ?? 0;
    const b = n[i] ?? 0;
    if ((a & ~b) !== 0) into.narrower = true;
    if ((b & ~a) !== 0) into.wider = true;
    if (into.narrower && into.wider) return;
  }
}

/** UTC minute table of one zone's local table: `utc[m] = local[(m + offset) mod week]`. */
function rotate(local: Uint8Array, offset: number): Uint8Array {
  const k = mod(offset, MINUTES_PER_WEEK);
  const out = new Uint8Array(MINUTES_PER_WEEK);
  out.set(local.subarray(k), 0);
  out.set(local.subarray(0, k), MINUTES_PER_WEEK - k);
  return out;
}

function utcTable(windows: CompiledTimeWindows | null, offsetOf: ReadonlyMap<string, number>): Uint8Array {
  if (windows === null) return FULL;
  let out: Uint8Array | null = null;
  for (const [zone, table] of windows.zones) {
    const rotated = rotate(table.flags, offsetOf.get(zone) ?? 0);
    if (out === null) {
      out = rotated;
    } else {
      const target = words(out);
      const source = words(rotated);
      for (let i = 0; i < target.length; i++) target[i] = (target[i] ?? 0) | (source[i] ?? 0);
    }
  }
  return out ?? EMPTY;
}

/**
 * Compare the allowed minutes of two sets of windows over a reference week
 * (`null` = unrestricted).
 *
 * When every window on both sides uses one time zone the local
 * minute-of-week tables are compared directly, which is exact for every week
 * of every year. Otherwise the tables are rotated into UTC and compared for
 * every combination of the UTC offsets the zones involved take (see
 * {@link zoneOffsets}); combinations that never occur together only make the
 * result more conservative.
 */
export function compareTimeWindows(
  prev: CompiledTimeWindows | null,
  next: CompiledTimeWindows | null,
): TimeWindowComparison {
  const result: TimeWindowComparison = { narrower: false, wider: false };
  if (prev === null && next === null) return result;
  const zones = [...new Set([...(prev?.zones.keys() ?? []), ...(next?.zones.keys() ?? [])])].sort();
  if (zones.length <= 1) {
    const local = (w: CompiledTimeWindows | null): Uint8Array =>
      w === null ? FULL : (w.zones.get(zones[0] ?? "")?.flags ?? EMPTY);
    diff(local(prev), local(next), result);
    return result;
  }
  const choices = zones.map((zone) => zoneOffsets(zone));
  let combinations = 1;
  for (const c of choices) combinations *= c.length;
  if (combinations > MAX_OFFSET_COMBINATIONS) return { narrower: true, wider: true };
  const index = zones.map(() => 0);
  for (let n = 0; n < combinations; n++) {
    const offsetOf = new Map(zones.map((zone, i) => [zone, choices[i]?.[index[i] ?? 0] ?? 0] as const));
    diff(utcTable(prev, offsetOf), utcTable(next, offsetOf), result);
    if (result.narrower && result.wider) return result;
    for (let i = 0; i < index.length; i++) {
      index[i] = (index[i] ?? 0) + 1;
      if ((index[i] ?? 0) < (choices[i]?.length ?? 0)) break;
      index[i] = 0;
    }
  }
  return result;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
