/**
 * The business model from the design doc ("Business model"), as code.
 *
 * All figures are whole US cents (bigint) so the arithmetic is exact. The
 * revenue dashboard compares actual revenue by stream with these drivers,
 * and a unit test proves the design doc's P&L table follows from them.
 * Every number here is a planning assumption, not a forecast.
 */

export type Stage = "beta" | "growth" | "scale";
export const STAGES: readonly Stage[] = ["beta", "growth", "scale"];

const DOLLAR = 100n; // cents

/** Monthly prices and fee rates (basis points; sweep and partner rates are per year). */
export const PRICING = {
  proMonthly: 99n * DOLLAR,
  businessMonthly: 499n * DOLLAR,
  enterpriseMonthly: 4_000n * DOLLAR,
  outboundBps: 20n, // 0.20%
  x402ReceiveBps: 50n, // 0.50%
  escrowBps: 100n, // 1%
  streamBps: 50n, // 0.50%
  sweepBpsPerYear: 15n, // 0.15% a year
  partnerSavingsBpsPerYear: 50n, // ~0.5% a year revenue share
} as const;

/** Variable and fixed cost assumptions. */
export const COSTS = {
  kybPerOrgMonthly: 3n * DOLLAR,
  screeningBps: 2n, // 0.02% of volume
  gasPerX402SettlementMilliCents: 200n, // $0.002 = 0.2 cents = 200 milli-cents
  averageX402Settlement: 2n * DOLLAR,
  costPerPersonMonthly: 18_000n * DOLLAR,
} as const;

export interface Drivers {
  orgs: { pro: bigint; business: bigint; enterprise: bigint };
  /** Monthly volumes in cents. */
  outboundVolume: bigint;
  x402Volume: bigint;
  escrowVolume: bigint;
  streamVolume: bigint;
  sweepBalances: bigint;
  partnerSavingsBalances: bigint;
  teamSize: bigint;
  fixed: { infrastructure: bigint; security: bigint; legal: bigint; goToMarket: bigint };
}

const M = 1_000_000n * DOLLAR;
const K = 1_000n * DOLLAR;

/** Model drivers (monthly) from the design doc. */
export const DRIVERS: Record<Stage, Drivers> = {
  beta: {
    orgs: { pro: 50n, business: 5n, enterprise: 0n },
    outboundVolume: 2n * M,
    x402Volume: M / 2n,
    escrowVolume: M / 5n,
    streamVolume: M / 10n,
    sweepBalances: 0n,
    partnerSavingsBalances: 0n,
    teamSize: 6n,
    fixed: { infrastructure: 15n * K, security: 25n * K, legal: 20n * K, goToMarket: 10n * K },
  },
  growth: {
    orgs: { pro: 600n, business: 120n, enterprise: 10n },
    outboundVolume: 40n * M,
    x402Volume: 15n * M,
    escrowVolume: 8n * M,
    streamVolume: 3n * M,
    sweepBalances: 20n * M,
    partnerSavingsBalances: 0n,
    teamSize: 14n,
    fixed: { infrastructure: 40n * K, security: 40n * K, legal: 35n * K, goToMarket: 60n * K },
  },
  scale: {
    orgs: { pro: 3_000n, business: 600n, enterprise: 60n },
    outboundVolume: 300n * M,
    x402Volume: 120n * M,
    escrowVolume: 60n * M,
    streamVolume: 25n * M,
    sweepBalances: 250n * M,
    partnerSavingsBalances: 150n * M,
    teamSize: 30n,
    fixed: { infrastructure: 120n * K, security: 80n * K, legal: 70n * K, goToMarket: 200n * K },
  },
};

export interface ProfitAndLoss {
  revenue: {
    subscriptions: bigint;
    outbound: bigint;
    x402Receive: bigint;
    escrow: bigint;
    streams: bigint;
    treasurySweep: bigint;
    partnerSavings: bigint;
  };
  totalRevenue: bigint;
  variableCosts: bigint;
  fixedCosts: bigint;
  operatingProfit: bigint;
  /** Basis points; null when revenue is zero. */
  operatingMarginBps: bigint | null;
  grossMarginBps: bigint | null;
}

function bps(amount: bigint, rate: bigint): bigint {
  return (amount * rate) / 10_000n;
}

export interface Overrides {
  x402ReceiveBps?: bigint;
  outboundBps?: bigint;
}

/** Monthly P&L for a set of drivers (all cents). */
export function profitAndLoss(d: Drivers, overrides: Overrides = {}): ProfitAndLoss {
  const revenue = {
    subscriptions:
      d.orgs.pro * PRICING.proMonthly +
      d.orgs.business * PRICING.businessMonthly +
      d.orgs.enterprise * PRICING.enterpriseMonthly,
    outbound: bps(d.outboundVolume, overrides.outboundBps ?? PRICING.outboundBps),
    x402Receive: bps(d.x402Volume, overrides.x402ReceiveBps ?? PRICING.x402ReceiveBps),
    escrow: bps(d.escrowVolume, PRICING.escrowBps),
    streams: bps(d.streamVolume, PRICING.streamBps),
    treasurySweep: bps(d.sweepBalances, PRICING.sweepBpsPerYear) / 12n,
    partnerSavings: bps(d.partnerSavingsBalances, PRICING.partnerSavingsBpsPerYear) / 12n,
  };
  const totalRevenue = Object.values(revenue).reduce((a, b) => a + b, 0n);
  const orgCount = d.orgs.pro + d.orgs.business + d.orgs.enterprise;
  const volume = d.outboundVolume + d.x402Volume + d.escrowVolume + d.streamVolume;
  const x402Settlements = d.x402Volume / COSTS.averageX402Settlement;
  const variableCosts =
    orgCount * COSTS.kybPerOrgMonthly +
    bps(volume, COSTS.screeningBps) +
    (x402Settlements * COSTS.gasPerX402SettlementMilliCents) / 1_000n;
  const fixedCosts =
    d.teamSize * COSTS.costPerPersonMonthly +
    d.fixed.infrastructure +
    d.fixed.security +
    d.fixed.legal +
    d.fixed.goToMarket;
  const operatingProfit = totalRevenue - variableCosts - fixedCosts;
  return {
    revenue,
    totalRevenue,
    variableCosts,
    fixedCosts,
    operatingProfit,
    operatingMarginBps: totalRevenue === 0n ? null : (operatingProfit * 10_000n) / totalRevenue,
    grossMarginBps: totalRevenue === 0n ? null : ((totalRevenue - variableCosts) * 10_000n) / totalRevenue,
  };
}

/** Revenue needed to break even on a stage's cost base at that stage's gross margin. */
export function breakEvenRevenue(d: Drivers): bigint {
  const pnl = profitAndLoss(d);
  if (pnl.grossMarginBps === null || pnl.grossMarginBps <= 0n) throw new Error("no gross margin");
  return (pnl.fixedCosts * pnl.totalRevenue) / (pnl.totalRevenue - pnl.variableCosts);
}
