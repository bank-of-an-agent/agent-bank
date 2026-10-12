import { AgentBankError } from "@agentbank/core";
import type { FeeKind, PlanRow, SubscriptionRow } from "../db/rows";
import { all, one } from "../db/sql";
import { actorOf, audit } from "../domain/audit";
import { accrueSubscription, getPlan, REVENUE_STREAMS, revenueFigures } from "../domain/billing";
import { requirePrincipal } from "../http/auth";
import type { Handlers } from "../http/registry";
import { decimal, serializePlan, serializeSubscription } from "../serializers";
import { monthWindow, periodWindow } from "../util/time";

const FEE_KINDS: readonly FeeKind[] = [
  "outbound_payment",
  "x402_receive",
  "escrow",
  "stream",
  "treasury_sweep",
  "subscription",
  "gas",
];

export const billingHandlers: Pick<
  Handlers,
  "listPlans" | "getSubscription" | "changePlan" | "getFees" | "getRevenueReport"
> = {
  async listPlans(_input, { deps }) {
    const plans = await all<PlanRow>(deps.db, "SELECT * FROM plan ORDER BY monthly_price, code");
    return { data: plans.map(serializePlan) };
  },

  async getSubscription(_input, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    let sub = await one<SubscriptionRow>(deps.db, "SELECT * FROM subscription WHERE org_id = $1", [
      principal.orgId,
    ]);
    if (!sub) {
      const period = monthWindow(now);
      sub = (await one<SubscriptionRow>(
        deps.db,
        `INSERT INTO subscription (org_id, plan_code, status, current_period_start, current_period_end, created_at)
         VALUES ($1, 'free', 'active', $2, $3, $4) ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
         RETURNING *`,
        [principal.orgId, period.start, period.end, now],
      )) as SubscriptionRow;
    }
    return serializeSubscription(sub, await getPlan(deps.db, sub.plan_code));
  },

  async changePlan({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const plan = await getPlan(deps.db, body.plan);
    const period = monthWindow(now);
    await deps.db.transaction(async (tx) => {
      if (plan.max_agents !== null) {
        const count = await one<{ n: bigint }>(
          tx,
          "SELECT count(*)::bigint AS n FROM agent WHERE org_id = $1",
          [principal.orgId],
        );
        if ((count?.n ?? 0n) > BigInt(plan.max_agents)) {
          throw new AgentBankError(
            "invalid_state",
            `The ${plan.name} plan allows at most ${plan.max_agents} agents; this org has ${count?.n ?? 0n}`,
          );
        }
      }
      await tx.query(
        `INSERT INTO subscription (org_id, plan_code, status, current_period_start, current_period_end, created_at)
         VALUES ($1, $2, 'active', $3, $4, $5)
         ON CONFLICT (org_id) DO UPDATE SET plan_code = EXCLUDED.plan_code`,
        [principal.orgId, plan.code, period.start, period.end, now],
      );
      await tx.query("UPDATE org SET tier = $2 WHERE id = $1", [principal.orgId, plan.code]);
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "billing.plan_changed",
        subject: principal.orgId,
        payload: { plan: plan.code },
      });
    });
    // A paid plan is billed for the current period right away (from the org treasury).
    await accrueSubscription(deps, principal.orgId, now);
    const sub = (await one<SubscriptionRow>(deps.db, "SELECT * FROM subscription WHERE org_id = $1", [
      principal.orgId,
    ])) as SubscriptionRow;
    return serializeSubscription(sub, plan);
  },

  async getFees({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const window = periodWindow(query.period);
    const rows = await all<{ kind: FeeKind; total: bigint }>(
      deps.db,
      `SELECT kind, sum(amount)::bigint AS total FROM fee_charge
        WHERE org_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY kind`,
      [principal.orgId, window.start, window.end],
    );
    const byKind: Record<string, string> = {};
    let total = 0n;
    for (const kind of FEE_KINDS) {
      const amount = rows.find((r) => r.kind === kind)?.total ?? 0n;
      byKind[kind] = decimal(amount);
      total += amount;
    }
    return {
      object: "fee_summary",
      org_id: principal.orgId,
      period: query.period,
      by_kind: byKind,
      total: decimal(total),
    };
  },

  async getRevenueReport({ query }, { deps }) {
    const figures = await revenueFigures(deps.db, periodWindow(query.period));
    const revenueByStream: Record<string, string> = {};
    for (const stream of REVENUE_STREAMS) revenueByStream[stream] = decimal(figures.revenueByStream[stream]);
    const volumeByKind: Record<string, string> = {};
    for (const [kind, amount] of Object.entries(figures.volumeByKind)) volumeByKind[kind] = decimal(amount);
    return {
      object: "revenue_report",
      period: query.period,
      revenue_by_stream: revenueByStream,
      total_revenue: decimal(figures.totalRevenue),
      variable_costs: decimal(figures.variableCosts),
      gross_margin_bps: figures.grossMarginBps,
      volume_by_kind: volumeByKind,
      paying_orgs: figures.payingOrgs,
      volume_per_org: decimal(figures.volumePerOrg),
    };
  },
};
