import { ASSET_DECIMALS, formatAmount, parseAmount, parseSignedAmount, type Money } from "@agentbank/core";

/**
 * Money in the console is decimal strings on the wire and `bigint` minor
 * units in arithmetic, formatted with the core helpers. No floats, ever:
 * percentages are basis points, rounding is integer half-up.
 */

const DECIMAL = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;

export function decimalsOf(asset: string): number {
  return (ASSET_DECIMALS as Record<string, number>)[asset] ?? 6;
}

/** Same rule as the API's `DecimalString`: non-negative, at most 6 decimals. */
export function isDecimalAmount(value: string): boolean {
  return DECIMAL.test(value);
}

export function toMinor(value: string, asset = "USDC"): bigint {
  return parseSignedAmount(value, decimalsOf(asset));
}

/** Like `toMinor`, but `null` instead of throwing on invalid input. */
export function tryMinor(value: string | null | undefined, asset = "USDC"): bigint | null {
  if (value === null || value === undefined || !SIGNED_DECIMAL.test(value)) return null;
  try {
    return toMinor(value, asset);
  } catch {
    return null;
  }
}

export function fromMinor(minor: bigint, asset = "USDC"): string {
  return formatAmount(minor, decimalsOf(asset));
}

/** Insert thousands separators into the integer part of a plain decimal string. */
export function groupDigits(decimal: string): string {
  const negative = decimal.startsWith("-");
  const body = negative ? decimal.slice(1) : decimal;
  const [whole = "0", fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

/** Round minor units to `digits` decimals, half away from zero. */
export function roundMinor(minor: bigint, decimals: number, digits: number): bigint {
  if (digits >= decimals) return minor;
  const step = 10n ** BigInt(decimals - digits);
  const half = step / 2n;
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rounded = ((abs + half) / step) * step;
  return negative ? -rounded : rounded;
}

export interface FormatOptions {
  /** Round to this many decimals (display only). Default: exact. */
  round?: number;
  /** Prefix "+" for positive values. */
  signed?: boolean;
}

/** `"1234.5"` → `"1,234.50"`. Invalid input is returned unchanged rather than throwing in a render. */
export function formatDecimal(value: string, asset = "USDC", options: FormatOptions = {}): string {
  const minor = tryMinor(value, asset);
  if (minor === null) return value;
  return formatMinor(minor, asset, options);
}

export function formatMinor(minor: bigint, asset = "USDC", options: FormatOptions = {}): string {
  const decimals = decimalsOf(asset);
  const value = options.round === undefined ? minor : roundMinor(minor, decimals, options.round);
  const text = groupDigits(formatAmount(value, decimals));
  const trimmed = options.round === undefined ? text : trimFraction(text, options.round);
  if (options.signed && value > 0n) return `+${trimmed}`;
  return trimmed.startsWith("-") ? `−${trimmed.slice(1)}` : trimmed;
}

function trimFraction(text: string, digits: number): string {
  const [whole, fraction = ""] = text.split(".");
  if (digits === 0) return whole ?? text;
  return `${whole}.${fraction.padEnd(digits, "0").slice(0, digits)}`;
}

/** `{amount: "25", asset: "USDC"}` → `"25.00 USDC"`. */
export function formatMoney(money: Money | null | undefined, options: FormatOptions = {}): string {
  if (!money) return "—";
  return `${formatDecimal(money.amount, money.asset, options)} ${money.asset}`;
}

export function sumDecimals(values: readonly (string | null | undefined)[], asset = "USDC"): bigint {
  let total = 0n;
  for (const value of values) total += tryMinor(value, asset) ?? 0n;
  return total;
}

export function compareDecimal(a: string, b: string, asset = "USDC"): -1 | 0 | 1 {
  const x = toMinor(a, asset);
  const y = toMinor(b, asset);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `numerator / denominator` in basis points, rounded half up; `null` when the denominator is 0. */
export function ratioBps(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const bps = (n * 10_000n * 2n + d) / (2n * d);
  return negative ? -bps : bps;
}

/** Basis points as a percentage string: `9213n` → `"92.13%"`, with `digits` decimals. */
export function formatBps(bps: bigint | number | null | undefined, digits = 1): string {
  if (bps === null || bps === undefined) return "—";
  const value = BigInt(bps);
  // bps has 2 implied decimals of a percent.
  const rounded = roundMinor(value, 2, Math.min(digits, 2));
  const text = formatAmount(rounded, 2, { minFractionDigits: Math.min(digits, 2) });
  const out = digits === 0 ? (text.split(".")[0] ?? text) : trimFraction(text, Math.min(digits, 2));
  return `${out.startsWith("-") ? `−${out.slice(1)}` : out}%`;
}

/** Whole US cents → `"$1,234.56"`. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const text = groupDigits(formatAmount(negative ? -cents : cents, 2));
  return `${negative ? "−" : ""}$${text}`;
}

/** Whole US cents → compact `"$2.86M"`, `"$411.8K"`, `"$16.40"`. */
export function formatCentsCompact(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const sign = negative ? "−" : "";
  const units: [bigint, string, number][] = [
    [100_000_000_000n, "B", 2],
    [100_000_000n, "M", 2],
    [100_000n, "K", 1],
  ];
  for (const [size, suffix, digits] of units) {
    if (abs >= size) {
      // abs / size with `digits` decimals, rounded half up.
      const scale = 10n ** BigInt(digits);
      const scaled = (abs * scale * 2n + size) / (2n * size);
      return `${sign}$${groupDigits(formatAmount(scaled, digits, { minFractionDigits: digits }))}${suffix}`;
    }
  }
  return `${sign}$${groupDigits(formatAmount(abs, 2))}`;
}

/** USDC (6 decimals) minor units → whole cents, rounded half up. USDC and USD are 1:1. */
export function usdcMinorToCents(minor: bigint): bigint {
  return roundMinor(minor, 6, 2) / 10_000n;
}

/** Whole cents → USDC minor units. */
export function centsToUsdcMinor(cents: bigint): bigint {
  return cents * 10_000n;
}

/** Parse a user-typed amount; returns an error message or `null` when valid. */
export function amountError(
  value: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): string | null {
  if (value.trim() === "") return "Enter an amount";
  if (!isDecimalAmount(value)) return 'Use a decimal like "25.00" (at most 6 decimals)';
  try {
    const minor = parseAmount(value, 6);
    if (!allowZero && minor === 0n) return "Amount must be greater than zero";
  } catch {
    return "Invalid amount";
  }
  return null;
}
