import { DRIVERS, profitAndLoss, STAGES, type ProfitAndLoss, type Stage } from "@agentbank/core";
import type { ResponseOf } from "@agentbank/core/api";
import { ratioBps, tryMinor, usdcMinorToCents } from "./money";

/**
 * The staff revenue dashboard compares the API's monthly revenue report with
 * the design doc's business model (`DRIVERS`, `profitAndLoss` in core). All
 * arithmetic is bigint cents; actual USDC amounts are converted 1:1 to USD.
 */

export type RevenueReport = ResponseOf<"getRevenueReport">;
export type StreamKey = keyof ProfitAndLoss["revenue"];

export const STREAMS: { key: StreamKey; label: string }[] = [
  { key: "subscriptions", label: "Subscriptions" },
  { key: "outbound", label: "Outbound payment fees" },
  { key: "x402Receive", label: "x402 receive fees" },
  { key: "escrow", label: "Escrow fees" },
  { key: "streams", label: "Stream fees" },
  { key: "treasurySweep", label: "Treasury sweep fees" },
  { key: "partnerSavings", label: "Partner savings share" },
];

export const STAGE_LABELS: Record<Stage, string> = { beta: "Beta", growth: "Growth", scale: "Scale" };

export interface ModelColumn {
  stage: Stage;
  pnl: ProfitAndLoss;
  orgs: { pro: bigint; business: bigint; enterprise: bigint };
  volume: { outbound: bigint; x402: bigint; escrow: bigint; streams: bigint; total: bigint };
  /** Monthly volume per paying org, cents. */
  volumePerOrg: bigint;
}

export function modelColumns(): Record<Stage, ModelColumn> {
  const out = {} as Record<Stage, ModelColumn>;
  for (const stage of STAGES) {
    const d = DRIVERS[stage];
    const total = d.outboundVolume + d.x402Volume + d.escrowVolume + d.streamVolume;
    const orgCount = d.orgs.pro + d.orgs.business + d.orgs.enterprise;
    out[stage] = {
      stage,
      pnl: profitAndLoss(d),
      orgs: d.orgs,
      volume: {
        outbound: d.outboundVolume,
        x402: d.x402Volume,
        escrow: d.escrowVolume,
        streams: d.streamVolume,
        total,
      },
      volumePerOrg: orgCount === 0n ? 0n : total / orgCount,
    };
  }
  return out;
}

/** A report amount (USDC decimal string) in whole cents; 0 when missing or malformed. */
export function cents(value: string | undefined): bigint {
  const minor = tryMinor(value ?? "0");
  return minor === null ? 0n : usdcMinorToCents(minor);
}

export interface Actuals {
  revenue: Record<StreamKey, bigint>;
  /** Streams the report has that the model does not know (e.g. added later). */
  otherRevenue: { key: string; cents: bigint }[];
  totalRevenue: bigint;
  variableCosts: bigint;
  grossMarginBps: bigint | null;
  volume: { outbound: bigint; x402: bigint; escrow: bigint; streams: bigint; total: bigint };
  orgs: { pro: bigint; business: bigint; enterprise: bigint; free: bigint };
  volumePerOrg: bigint;
}

/** Payment kinds that count as outbound volume in the model (transfers and payouts). */
const OUTBOUND_KINDS = ["transfer", "payout"];

export function actuals(report: RevenueReport): Actuals {
  const known = new Set<string>(STREAMS.map((s) => s.key));
  const revenue = Object.fromEntries(
    STREAMS.map((s) => [s.key, cents(report.revenue_by_stream[s.key])]),
  ) as Record<StreamKey, bigint>;
  const otherRevenue = Object.entries(report.revenue_by_stream)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => ({ key, cents: cents(value) }));
  const kind = (k: string) => cents(report.volume_by_kind[k]);
  const outbound = OUTBOUND_KINDS.reduce((sum, k) => sum + kind(k), 0n);
  const volume = {
    outbound,
    x402: kind("x402"),
    escrow: kind("escrow"),
    streams: kind("stream"),
    total: 0n,
  };
  volume.total = volume.outbound + volume.x402 + volume.escrow + volume.streams;
  const paying = report.paying_orgs as Partial<Record<"free" | "pro" | "business" | "enterprise", number>>;
  return {
    revenue,
    otherRevenue,
    totalRevenue: cents(report.total_revenue),
    variableCosts: cents(report.variable_costs),
    grossMarginBps: cents(report.total_revenue) === 0n ? null : BigInt(report.gross_margin_bps),
    volume,
    orgs: {
      pro: BigInt(paying.pro ?? 0),
      business: BigInt(paying.business ?? 0),
      enterprise: BigInt(paying.enterprise ?? 0),
      free: BigInt(paying.free ?? 0),
    },
    volumePerOrg: cents(report.volume_per_org),
  };
}

/** Where monthly revenue sits on the Beta → Growth → Scale path. */
export function stageReached(totalCents: bigint, models: Record<Stage, ModelColumn>): string {
  const beta = models.beta.pnl.totalRevenue;
  const growth = models.growth.pnl.totalRevenue;
  const scale = models.scale.pnl.totalRevenue;
  const pct = (of: bigint) => {
    const bps = ratioBps(totalCents, of);
    return bps === null ? "—" : `${(bps / 100n).toString()}%`;
  };
  if (totalCents >= scale) return "At or above the Scale case";
  if (totalCents >= growth) return `Between Growth and Scale (${pct(scale)} of Scale)`;
  if (totalCents >= beta) return `Between Beta and Growth (${pct(growth)} of Growth)`;
  return `Below the Beta case (${pct(beta)} of Beta)`;
}
