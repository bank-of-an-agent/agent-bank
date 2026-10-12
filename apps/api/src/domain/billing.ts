import { AgentBankError, COSTS, isAgentBankError, newId, PRICING } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { FeeKind, PlanRow, SubscriptionRow } from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import { monthWindow, periodOf, type Window } from "../util/time";
import { pocket } from "./ledger-refs";

/**
 * Plans, subscriptions and fees.
 *
 * Fee rates come from the business model in core (`PRICING`, basis points) with the API's own
 * rules from docs/architecture.md on top: outbound payments are capped at $5.00 per payment,
 * escrow has a $1.00 minimum. Every fee is recorded as a `fee_charge` row next to its ledger
 * entry, so revenue reconciles like every other movement.
 */

const ONE_DOLLAR = 1_000_000n; // USDC minor units

/** US cents (business model unit) → USDC minor units. */
export function centsToMinor(cents: bigint): bigint {
  return cents * 10_000n;
}

function bpsOf(amount: bigint, bps: bigint): bigint {
  // Round half up, like core's applyBps.
  return (amount * bps + 5_000n) / 10_000n;
}

/** Outbound payment fee: 0.20%, capped at $5.00. */
export function outboundFee(amount: bigint): bigint {
  const fee = bpsOf(amount, PRICING.outboundBps);
  const cap = 5n * ONE_DOLLAR;
  return fee > cap ? cap : fee;
}

/** Escrow fee: 1% of the escrowed amount, $1.00 minimum. */
export function escrowFee(amount: bigint): bigint {
  const fee = bpsOf(amount, PRICING.escrowBps);
  return fee < ONE_DOLLAR ? ONE_DOLLAR : fee;
}

/** Stream fee: 0.50% of the deposit, charged at creation. */
export function streamFee(deposit: bigint): bigint {
  return bpsOf(deposit, PRICING.streamBps);
}

/** x402 receive fee charged to the seller: 0.50% of the settled amount. */
export function x402ReceiveFee(amount: bigint): bigint {
  return bpsOf(amount, PRICING.x402ReceiveBps);
}

export const X402_RECEIVE_FEE_BPS = Number(PRICING.x402ReceiveBps);

export async function recordFeeCharge(
  tx: SqlClient,
  now: Date,
  input: {
    accountId: string;
    orgId: string;
    kind: FeeKind;
    sourceRef: string;
    amount: bigint;
    ledgerEntryId: string | null;
  },
): Promise<void> {
  if (input.amount <= 0n) return;
  await tx.query(
    `INSERT INTO fee_charge (id, account_id, org_id, kind, source_ref, amount, ledger_entry_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (kind, source_ref) DO NOTHING`,
    [
      newId("feeCharge", now.getTime()),
      input.accountId,
      input.orgId,
      input.kind,
      input.sourceRef,
      input.amount,
      input.ledgerEntryId,
      now,
    ],
  );
}

// ---------------------------------------------------------------- subscriptions

interface SubscriptionWithPlan extends SubscriptionRow {
  monthly_price: bigint;
  treasury_account_id: string | null;
}

/**
 * Accrue the monthly subscription fee for one org if it has not been accrued for the current
 * period: `operating −p, fees +p` on the org treasury account plus a `fee_charge` row. The
 * fees pocket is swept to the revenue address with the treasury's next outgoing operation.
 * No treasury account or not enough funds → `past_due` (retried by the worker).
 * Returns true when a charge was recorded.
 */
export async function accrueSubscription(deps: AppDeps, orgId: string, now: Date): Promise<boolean> {
  const period = monthWindow(now);
  const sub = await one<SubscriptionWithPlan>(
    deps.db,
    `SELECT s.*, p.monthly_price, o.treasury_account_id
       FROM subscription s JOIN plan p ON p.code = s.plan_code JOIN org o ON o.id = s.org_id
      WHERE s.org_id = $1`,
    [orgId],
  );
  if (!sub || sub.status === "canceled") return false;
  if (
    sub.current_period_end.getTime() <= now.getTime() ||
    sub.current_period_start.getTime() > now.getTime()
  ) {
    await deps.db.query(
      "UPDATE subscription SET current_period_start = $2, current_period_end = $3 WHERE org_id = $1",
      [orgId, period.start, period.end],
    );
  }
  if (sub.monthly_price <= 0n) {
    if (sub.status === "past_due") {
      await deps.db.query("UPDATE subscription SET status = 'active' WHERE org_id = $1", [orgId]);
    }
    return false;
  }
  const sourceRef = `subscription:${orgId}:${periodOf(now)}`;
  const existing = await one(
    deps.db,
    "SELECT 1 AS x FROM fee_charge WHERE kind = 'subscription' AND source_ref = $1",
    [sourceRef],
  );
  if (existing) return false;
  if (!sub.treasury_account_id) {
    await deps.db.query("UPDATE subscription SET status = 'past_due' WHERE org_id = $1", [orgId]);
    return false;
  }
  const treasuryId = sub.treasury_account_id;
  let entryId: string;
  try {
    const entry = await deps.ledger.post({
      idempotencyKey: `subscription:${orgId}:${periodOf(now)}`,
      lines: [
        { account: pocket(treasuryId, "operating"), amount: -sub.monthly_price },
        { account: pocket(treasuryId, "fees"), amount: sub.monthly_price },
      ],
      refType: "subscription",
      refId: orgId,
      memo: `Subscription ${sub.plan_code} ${periodOf(now)}`,
    });
    entryId = entry.id;
  } catch (error) {
    if (isAgentBankError(error) && (error.code === "insufficient_funds" || error.code === "not_found")) {
      await deps.db.query("UPDATE subscription SET status = 'past_due' WHERE org_id = $1", [orgId]);
      return false;
    }
    throw error;
  }
  await deps.db.transaction(async (tx) => {
    await recordFeeCharge(tx, now, {
      accountId: treasuryId,
      orgId,
      kind: "subscription",
      sourceRef,
      amount: sub.monthly_price,
      ledgerEntryId: entryId,
    });
    await tx.query("UPDATE subscription SET status = 'active' WHERE org_id = $1", [orgId]);
  });
  return true;
}

/** Worker job: accrue subscriptions for every org with a paid plan or a rolled-over period. */
export async function accrueAllSubscriptions(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const rows = await all<{ org_id: string }>(
    deps.db,
    `SELECT s.org_id FROM subscription s JOIN plan p ON p.code = s.plan_code
      WHERE s.status <> 'canceled' AND (p.monthly_price > 0 OR s.current_period_end <= $1)`,
    [now],
  );
  let charged = 0;
  for (const row of rows) {
    try {
      if (await accrueSubscription(deps, row.org_id, now)) charged++;
    } catch (error) {
      deps.logger.error({ err: error, orgId: row.org_id }, "subscription accrual failed");
    }
  }
  return charged;
}

export async function getPlan(db: SqlClient, code: string): Promise<PlanRow> {
  const plan = await one<PlanRow>(db, "SELECT * FROM plan WHERE code = $1", [code]);
  if (!plan) throw new AgentBankError("not_found", "Plan not found");
  return plan;
}

// ---------------------------------------------------------------- revenue report

/** Revenue streams, named as in the business model (`profitAndLoss().revenue`). */
export const REVENUE_STREAMS = [
  "subscriptions",
  "outbound",
  "x402Receive",
  "escrow",
  "streams",
  "treasurySweep",
  "partnerSavings",
] as const;
export type RevenueStream = (typeof REVENUE_STREAMS)[number];

const FEE_KIND_STREAM: Partial<Record<FeeKind, RevenueStream>> = {
  subscription: "subscriptions",
  outbound_payment: "outbound",
  x402_receive: "x402Receive",
  escrow: "escrow",
  stream: "streams",
  treasury_sweep: "treasurySweep",
};

/** Payment kinds that move value to a third party (internal moves are not volume). */
export const EXTERNAL_VOLUME_KINDS = ["transfer", "payout", "x402", "escrow", "stream"] as const;

export interface RevenueFigures {
  revenueByStream: Record<RevenueStream, bigint>;
  totalRevenue: bigint;
  variableCosts: bigint;
  grossMarginBps: number;
  volumeByKind: Record<string, bigint>;
  payingOrgs: Record<"free" | "pro" | "business" | "enterprise", number>;
  volumePerOrg: bigint;
}

/**
 * Actual revenue by stream for a month, with variable costs estimated with the model's cost
 * assumptions (KYB per org, screening on volume, gas per x402 settlement) so the console can
 * compare actuals with `profitAndLoss(DRIVERS[stage])`.
 */
export async function revenueFigures(db: SqlClient, window: Window): Promise<RevenueFigures> {
  const revenueByStream = Object.fromEntries(REVENUE_STREAMS.map((s) => [s, 0n])) as Record<
    RevenueStream,
    bigint
  >;
  const fees = await all<{ kind: FeeKind; total: bigint }>(
    db,
    `SELECT kind, sum(amount)::bigint AS total FROM fee_charge
      WHERE created_at >= $1 AND created_at < $2 GROUP BY kind`,
    [window.start, window.end],
  );
  for (const f of fees) {
    const stream = FEE_KIND_STREAM[f.kind];
    if (stream) revenueByStream[stream] += f.total;
  }
  const totalRevenue = REVENUE_STREAMS.reduce((sum, s) => sum + revenueByStream[s], 0n);

  const volumes = await all<{ kind: string; total: bigint; orgs: bigint }>(
    db,
    `SELECT kind, sum(amount)::bigint AS total, count(DISTINCT org_id)::bigint AS orgs FROM payment
      WHERE status = 'settled' AND settled_at >= $1 AND settled_at < $2 GROUP BY kind`,
    [window.start, window.end],
  );
  const volumeByKind: Record<string, bigint> = {};
  let externalVolume = 0n;
  for (const v of volumes) {
    volumeByKind[v.kind] = v.total;
    if ((EXTERNAL_VOLUME_KINDS as readonly string[]).includes(v.kind)) externalVolume += v.total;
  }
  const orgsWithVolume = await one<{ n: bigint }>(
    db,
    `SELECT count(DISTINCT org_id)::bigint AS n FROM payment
      WHERE status = 'settled' AND settled_at >= $1 AND settled_at < $2 AND kind = ANY($3)`,
    [window.start, window.end, [...EXTERNAL_VOLUME_KINDS]],
  );
  const x402Settlements = await one<{ n: bigint }>(
    db,
    `SELECT count(*)::bigint AS n FROM payment
      WHERE status = 'settled' AND kind = 'x402' AND settled_at >= $1 AND settled_at < $2`,
    [window.start, window.end],
  );
  const orgCount = await one<{ n: bigint }>(
    db,
    "SELECT count(*)::bigint AS n FROM org WHERE created_at < $1",
    [window.end],
  );
  const subs = await all<{ plan_code: "free" | "pro" | "business" | "enterprise"; n: bigint }>(
    db,
    "SELECT plan_code, count(*)::bigint AS n FROM subscription WHERE status <> 'canceled' GROUP BY plan_code",
  );
  const payingOrgs = { free: 0, pro: 0, business: 0, enterprise: 0 };
  for (const s of subs) payingOrgs[s.plan_code] = Number(s.n);

  const variableCosts =
    (orgCount?.n ?? 0n) * centsToMinor(COSTS.kybPerOrgMonthly) +
    (externalVolume * COSTS.screeningBps) / 10_000n +
    (x402Settlements?.n ?? 0n) * COSTS.gasPerX402SettlementMilliCents * 10n;
  const grossMarginBps =
    totalRevenue > 0n ? Number(((totalRevenue - variableCosts) * 10_000n) / totalRevenue) : 0;
  const withVolume = orgsWithVolume?.n ?? 0n;
  return {
    revenueByStream,
    totalRevenue,
    variableCosts,
    grossMarginBps,
    volumeByKind,
    payingOrgs,
    volumePerOrg: withVolume > 0n ? externalVolume / withVolume : 0n,
  };
}
