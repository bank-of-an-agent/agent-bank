import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyBps,
  divCeil,
  formatAmount,
  parseAmount,
  parsePositiveAmount,
  parseSignedAmount,
} from "../src/money";
import { money, toMinor, usdc } from "../src/assets";

describe("parseAmount", () => {
  it("parses decimal strings into minor units", () => {
    expect(parseAmount("25.00", 6)).toBe(25_000_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("0", 6)).toBe(0n);
    expect(parseAmount("1234567.5", 6)).toBe(1_234_567_500_000n);
  });

  it.each(["", "1e6", "-1", "+1", " 1", "1 ", "01", "1.", ".5", "1.0000001", "NaN", "0x10", "1,000"])(
    "rejects %j",
    (bad) => {
      expect(() => parseAmount(bad, 6)).toThrow(/amount|decimal/i);
    },
  );

  it("rejects amounts above the bigint column range", () => {
    expect(() => parseAmount("9223372036854.775808", 6)).toThrow(/maximum/);
    expect(parseAmount("9223372036854.775807", 6)).toBe(9_223_372_036_854_775_807n);
  });

  it("requires positive amounts where asked", () => {
    expect(() => parsePositiveAmount("0.00", 6)).toThrow(/greater than zero/);
    expect(parsePositiveAmount("0.01", 6)).toBe(10_000n);
  });

  it("parses signed amounts", () => {
    expect(parseSignedAmount("-1.5", 6)).toBe(-1_500_000n);
    expect(parseSignedAmount("2", 6)).toBe(2_000_000n);
    expect(() => parseSignedAmount("--1", 6)).toThrow();
  });

  it("rejects unsupported decimals", () => {
    expect(() => parseAmount("1", -1)).toThrow();
    expect(() => parseAmount("1", 1.5)).toThrow();
  });
});

describe("formatAmount", () => {
  it("formats canonically with at least two fraction digits", () => {
    expect(formatAmount(25_000_000n, 6)).toBe("25.00");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmount(1_500_000n, 6)).toBe("1.50");
    expect(formatAmount(-1_500_000n, 6)).toBe("-1.50");
    expect(formatAmount(7n, 0)).toBe("7");
    expect(formatAmount(123_456_789n, 6, { minFractionDigits: 6 })).toBe("123.456789");
  });

  it("round-trips every representable amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 9_223_372_036_854_775_807n }), (minor) => {
        expect(parseAmount(formatAmount(minor, 6), 6)).toBe(minor);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("helpers", () => {
  it("applies basis points with half-up rounding", () => {
    expect(applyBps(usdc("100.00"), 20)).toBe(usdc("0.20"));
    expect(applyBps(3n, 5000)).toBe(2n);
    expect(() => applyBps(-1n, 1)).toThrow();
  });

  it("divides with ceiling", () => {
    expect(divCeil(10n, 3n)).toBe(4n);
    expect(divCeil(9n, 3n)).toBe(3n);
    expect(() => divCeil(1n, 0n)).toThrow();
  });

  it("converts wire money", () => {
    expect(toMinor({ amount: "1.25", asset: "USDC" })).toBe(1_250_000n);
    expect(money(1_250_000n)).toEqual({ amount: "1.25", asset: "USDC" });
    expect(() => toMinor({ amount: "1", asset: "DAI" })).toThrow(/not supported/);
  });
});
