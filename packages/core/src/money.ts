import { AgentBankError } from "./errors";

/**
 * Money is integer minor units end to end (USDC has 6 decimals), represented
 * as `bigint` in code and as a decimal string plus an asset code on the wire.
 * There are no floats anywhere in this module, and none may be introduced.
 */

const DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const SIGNED_DECIMAL_RE = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Largest amount the ledger accepts in one line: 2^63 - 1 (PostgreSQL bigint). */
export const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

export interface Money {
  /** Decimal string, e.g. "25.00". Never a JSON number. */
  amount: string;
  /** Asset code, e.g. "USDC". */
  asset: string;
}

/**
 * Parse a non-negative decimal string into minor units.
 * Rejects exponents, signs, whitespace, leading zeros and excess precision.
 */
export function parseAmount(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof value !== "string") {
    throw new AgentBankError("invalid_amount", "Amounts must be decimal strings");
  }
  const match = DECIMAL_RE.exec(value);
  if (!match) {
    throw new AgentBankError("invalid_amount", `"${value}" is not a valid decimal amount`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new AgentBankError("invalid_amount", `"${value}" has more than ${decimals} decimal places`);
  }
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (minor > MAX_MINOR_UNITS) {
    throw new AgentBankError("invalid_amount", `"${value}" exceeds the maximum supported amount`);
  }
  return minor;
}

/** Parse a decimal string that must be strictly greater than zero. */
export function parsePositiveAmount(value: string, decimals: number): bigint {
  const minor = parseAmount(value, decimals);
  if (minor <= 0n) throw new AgentBankError("invalid_amount", "Amount must be greater than zero");
  return minor;
}

/** Parse a decimal string that may carry a leading minus sign. */
export function parseSignedAmount(value: string, decimals: number): bigint {
  if (!SIGNED_DECIMAL_RE.test(value)) {
    throw new AgentBankError("invalid_amount", `"${value}" is not a valid signed decimal amount`);
  }
  return value.startsWith("-") ? -parseAmount(value.slice(1), decimals) : parseAmount(value, decimals);
}

export interface FormatOptions {
  /** Minimum fraction digits to keep (default 2, capped at `decimals`). */
  minFractionDigits?: number;
}

/**
 * Format minor units as a canonical decimal string: trailing zeros trimmed to
 * at least two fraction digits. `25_000_000n` (USDC) becomes `"25.00"` and
 * `1n` becomes `"0.000001"`. Negative values keep a leading minus sign.
 */
export function formatAmount(minor: bigint, decimals: number, options: FormatOptions = {}): string {
  assertDecimals(decimals);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = decimals === 0 ? "" : (abs % base).toString().padStart(decimals, "0");
  const minDigits = Math.min(options.minFractionDigits ?? 2, decimals);
  while (fraction.length > minDigits && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${body}` : body;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

/** Sum a list of bigint amounts. */
export function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Multiply an amount by a rate in basis points, rounding half up.
 * Used for fees (e.g. 20 bps outbound payment fee).
 */
export function applyBps(amount: bigint, bps: bigint | number): bigint {
  const rate = BigInt(bps);
  if (amount < 0n || rate < 0n)
    throw new AgentBankError("invalid_amount", "applyBps takes non-negative inputs");
  return (amount * rate + 5_000n) / 10_000n;
}

/** Divide rounding up (ceiling) for non-negative operands. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new AgentBankError("invalid_amount", "divCeil operands");
  return (numerator + denominator - 1n) / denominator;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AgentBankError("invalid_amount", `Unsupported decimals: ${decimals}`);
  }
}
