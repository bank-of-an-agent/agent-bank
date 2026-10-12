/** Display helpers for dates, durations, identifiers and hex strings. */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = toDate(value);
  return date ? dateTime.format(date) : String(value);
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = toDate(value);
  return date ? dateOnly.format(date) : String(value);
}

export function formatTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = toDate(value);
  return date ? timeOnly.format(date) : String(value);
}

/** "in 12 minutes", "3 hours ago". */
export function formatRelative(value: string | number | Date, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return String(value);
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return relative.format(seconds, "second");
  if (abs < 45 * 60) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 22 * 3600) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 26 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  if (abs < 320 * 86_400) return relative.format(Math.round(seconds / (30 * 86_400)), "month");
  return relative.format(Math.round(seconds / (365 * 86_400)), "year");
}

/** Milliseconds as a countdown: `"14:05"`, or `"1:02:03"` above an hour. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Spoken form of a countdown for assistive technology: "14 minutes 5 seconds". */
export function describeDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** `0x1234567890abcdef…` → `0x1234…cdef`. */
export function shortHex(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** `pay_01J9Z…` → `pay_01J9…X7QK`. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  const underscore = value.indexOf("_");
  if (underscore < 0 || value.length < underscore + 14) return value;
  return `${value.slice(0, underscore + 5)}…${value.slice(-4)}`;
}

/** `"payment.settled"` / `"requires_approval"` → `"Payment settled"` / `"Requires approval"`. */
export function humanize(value: string): string {
  const text = value.replace(/[._]/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Current period as `YYYY-MM` (UTC), the format statements and fees use. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The `count` periods up to and including `period`, newest first. */
export function recentPeriods(count: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  for (let i = 0; i < count; i++) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
