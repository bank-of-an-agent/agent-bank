import { DRIVERS, profitAndLoss } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import {
  amountError,
  formatBps,
  formatCents,
  formatCentsCompact,
  formatDecimal,
  formatMinor,
  formatMoney,
  groupDigits,
  ratioBps,
  roundMinor,
  sumDecimals,
  usdcMinorToCents,
} from "@/lib/money";
import { actuals, cents, modelColumns, stageReached, type RevenueReport } from "@/lib/revenue";

describe("money formatting (no floats)", () => {
  it("formats decimal strings exactly with grouping", () => {
    expect(formatDecimal("1234567.5")).toBe("1,234,567.50");
    expect(formatDecimal("0.000001")).toBe("0.000001");
    expect(formatMoney({ amount: "25", asset: "USDC" })).toBe("25.00 USDC");
    expect(formatMinor(-2_500_000n)).toBe("−2.50");
    expect(formatMinor(1_000_000n, "USDC", { signed: true })).toBe("+1.00");
    expect(groupDigits("-1000000.25")).toBe("-1,000,000.25");
  });

  it("returns unparseable input unchanged instead of throwing in a render", () => {
    expect(formatDecimal("12.3456789")).toBe("12.3456789");
    expect(formatDecimal("abc")).toBe("abc");
  });

  it("rounds half away from zero in integer arithmetic", () => {
    expect(roundMinor(1_005_000n, 6, 2)).toBe(1_010_000n);
    expect(roundMinor(1_004_999n, 6, 2)).toBe(1_000_000n);
    expect(roundMinor(-1_005_000n, 6, 2)).toBe(-1_010_000n);
    expect(formatMinor(123_456_789n, "USDC", { round: 2 })).toBe("123.46");
  });

  it("sums decimal strings as bigint minor units", () => {
    // 0.1 + 0.2 is exactly 0.3 here.
    expect(sumDecimals(["0.1", "0.2", null, "bad"])).toBe(300_000n);
  });

  it("computes ratios and percentages in basis points", () => {
    expect(ratioBps(1n, 3n)).toBe(3333n);
    expect(ratioBps(2n, 3n)).toBe(6667n);
    expect(ratioBps(5n, 0n)).toBeNull();
    expect(formatBps(9213n, 1)).toBe("92.1%");
    expect(formatBps(9213n, 2)).toBe("92.13%");
    expect(formatBps(-1100n, 0)).toBe("−11%");
    expect(formatBps(null)).toBe("—");
  });

  it("formats cents, compact and full", () => {
    expect(formatCents(1_640_000n)).toBe("$16,400.00");
    expect(formatCentsCompact(285_520_000n)).toBe("$2.86M");
    expect(formatCentsCompact(41_180_000n)).toBe("$411.8K");
    expect(formatCentsCompact(1_234n)).toBe("$12.34");
    expect(usdcMinorToCents(1_234_567n)).toBe(123n);
  });

  it("validates typed amounts like the API", () => {
    expect(amountError("25.00")).toBeNull();
    expect(amountError("")).toMatch(/Enter/);
    expect(amountError("1e3")).toMatch(/decimal/);
    expect(amountError("0")).toMatch(/greater than zero/);
    expect(amountError("0", { allowZero: true })).toBeNull();
    expect(amountError("1.1234567")).toMatch(/6 decimals/);
  });
});

const report: RevenueReport = {
  object: "revenue_report",
  period: "2026-10",
  revenue_by_stream: {
    subscriptions: "7400.00",
    outbound: "4000.00",
    x402Receive: "2500.00",
    escrow: "2000.00",
    streams: "500.00",
    treasurySweep: "0",
    partnerSavings: "0",
    gas: "12.345678",
  },
  total_revenue: "16400.00",
  variable_costs: "1200.00",
  gross_margin_bps: 9268,
  volume_by_kind: {
    transfer: "1500000.00",
    payout: "500000.00",
    x402: "500000.00",
    escrow: "200000.00",
    stream: "100000.00",
    refill: "999.00",
  },
  paying_orgs: { free: 12, pro: 50, business: 5, enterprise: 0 },
  volume_per_org: "50909.09",
};

describe("revenue dashboard maths", () => {
  it("reproduces the design doc's P&L from the drivers", () => {
    const models = modelColumns();
    expect(models.beta.pnl.totalRevenue).toBe(profitAndLoss(DRIVERS.beta).totalRevenue);
    expect(formatCentsCompact(models.scale.pnl.totalRevenue)).toBe("$2.86M");
    expect(models.beta.volume.total).toBe(280_000_000n); // $2.8M
    expect(models.beta.volumePerOrg).toBe(5_090_909n); // $50,909.09 per paying org
  });

  it("maps a revenue report onto the model's streams and drivers", () => {
    const a = actuals(report);
    expect(a.revenue.subscriptions).toBe(740_000n);
    expect(a.totalRevenue).toBe(1_640_000n);
    expect(a.otherRevenue).toEqual([{ key: "gas", cents: 1_235n }]);
    expect(a.volume.outbound).toBe(200_000_000n);
    expect(a.volume.total).toBe(280_000_000n);
    expect(a.orgs).toMatchObject({ pro: 50n, business: 5n, enterprise: 0n, free: 12n });
    expect(a.grossMarginBps).toBe(9268n);
    expect(cents(undefined)).toBe(0n);
  });

  it("places actual revenue on the Beta → Growth → Scale path", () => {
    const models = modelColumns();
    expect(stageReached(0n, models)).toMatch(/^Below the Beta case/);
    expect(stageReached(models.beta.pnl.totalRevenue, models)).toMatch(/^Between Beta and Growth/);
    expect(stageReached(models.scale.pnl.totalRevenue + 1n, models)).toBe("At or above the Scale case");
  });
});
