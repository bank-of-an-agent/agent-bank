import { describe, expect, it } from "vitest";
import { breakEvenRevenue, DRIVERS, profitAndLoss } from "../src/business-model";

/** Reproduces the "Monthly P&L" table of docs/design.md to the cent. */
describe("business model", () => {
  it("matches the Beta column", () => {
    const p = profitAndLoss(DRIVERS.beta);
    expect(p.revenue.subscriptions).toBe(744_500n); // $7.4K
    expect(p.totalRevenue).toBe(1_644_500n); // $16.4K
    expect(p.variableCosts).toBe(122_500n); // $1.2K
    expect(p.fixedCosts).toBe(17_800_000n); // $178.0K
    expect(p.operatingProfit).toBe(-16_278_000n); // −$162.8K
  });

  it("matches the Growth column", () => {
    const p = profitAndLoss(DRIVERS.growth);
    expect(p.revenue).toEqual({
      subscriptions: 15_928_000n,
      outbound: 8_000_000n,
      x402Receive: 7_500_000n,
      escrow: 8_000_000n,
      streams: 1_500_000n,
      treasurySweep: 250_000n,
      partnerSavings: 0n,
    });
    expect(p.totalRevenue).toBe(41_178_000n); // $411.8K
    expect(p.variableCosts).toBe(3_039_000n); // $30.4K
    expect(p.fixedCosts).toBe(42_700_000n); // $427.0K
    expect(p.operatingProfit).toBe(-4_561_000n); // −$45.6K
    expect(p.operatingMarginBps).toBe(-1107n); // −11%
  });

  it("matches the Scale column", () => {
    const p = profitAndLoss(DRIVERS.scale);
    expect(p.totalRevenue).toBe(285_515_000n); // $2,855.2K
    expect(p.revenue.treasurySweep).toBe(3_125_000n); // $31.3K
    expect(p.revenue.partnerSavings).toBe(6_250_000n); // $62.5K
    expect(p.variableCosts).toBe(23_198_000n); // $232.0K
    expect(p.fixedCosts).toBe(101_000_000n); // $1,010.0K
    expect(p.operatingProfit).toBe(161_317_000n); // $1,613.2K
    expect(p.operatingMarginBps).toBe(5650n); // 56%
  });

  it("supports the profit-driver claims", () => {
    for (const stage of ["beta", "growth", "scale"] as const) {
      const gm = profitAndLoss(DRIVERS[stage]).grossMarginBps ?? 0n;
      expect(gm > 9_100n && gm < 9_300n).toBe(true); // about 92% at every stage
    }
    const breakEven = breakEvenRevenue(DRIVERS.growth);
    expect(breakEven / 100_000n).toBe(461n); // about $460K, ~12% above Growth revenue
    const noX402 = profitAndLoss(DRIVERS.scale, { x402ReceiveBps: 0n });
    expect(noX402.operatingProfit).toBe(101_317_000n); // about $1.0M
    expect(noX402.operatingMarginBps).toBe(4492n); // 45%
    const halvedPayments = profitAndLoss(DRIVERS.scale, { x402ReceiveBps: 0n, outboundBps: 10n });
    expect(noX402.operatingProfit - halvedPayments.operatingProfit).toBe(30_000_000n); // another $300K
  });
});
