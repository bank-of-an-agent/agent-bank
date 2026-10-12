import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAutoSave } from "../src/domain/auto-save";
import { accrueAllSubscriptions } from "../src/domain/billing";
import { deliverCosignerOutbox } from "../src/domain/cosigner-outbox";
import { pocket } from "../src/domain/ledger-refs";
import { JOBS, runJob } from "../src/jobs";
import { prune } from "../src/jobs/expiry";
import { processSettled } from "../src/jobs/settlement";
import { notifyStatements } from "../src/jobs/statements";
import { agentCall, call, createHarness, TEST_STAFF_TOKEN, type Harness } from "./support/harness";
import { fund, onboard, payAndSign, type World } from "./support/flows";

let h: Harness;
let w: World;

beforeAll(async () => {
  h = await createHarness();
  w = await onboard(h, { name: "jobs", fund: usdc("1000") });
});
afterAll(async () => h.close());

describe("subscriptions", () => {
  it("accrues the monthly fee on the treasury's fees pocket, once per period", async () => {
    const treasury = await call(h.app, "POST", "/v1/orgs/me/treasury-accounts", {
      token: w.apiKey,
      body: { chain: "simulated" },
    });
    await fund(h, treasury.body, usdc("150"));
    const changed = await call(h.app, "PUT", "/v1/billing/subscription", {
      token: w.apiKey,
      body: { plan: "pro" },
    });
    expect(changed.body).toMatchObject({
      status: "active",
      plan: { code: "pro", monthly_price: { amount: "99.00", asset: "USDC" } },
    });
    expect(await h.ledger.balance(pocket(treasury.body.id, "fees"))).toBe(usdc("99"));
    expect(await accrueAllSubscriptions(h.deps)).toBe(0); // already charged this month
    h.clock.set("2026-11-01T00:05:00Z");
    expect(await accrueAllSubscriptions(h.deps)).toBe(0); // only 51 left: past due
    const sub = await call(h.app, "GET", "/v1/billing/subscription", { token: w.apiKey });
    expect(sub.body).toMatchObject({ status: "past_due", current_period_start: "2026-11-01T00:00:00.000Z" });
    await fund(h, treasury.body, usdc("100"));
    expect(await accrueAllSubscriptions(h.deps)).toBe(1);
    const fees = await call(h.app, "GET", "/v1/billing/fees?period=2026-11", { token: w.apiKey });
    expect(fees.body.by_kind.subscription).toBe("99.00");
  });
});

describe("statements", () => {
  it("emits statement.ready once per account after the month ends", async () => {
    const sent = await notifyStatements(h.deps);
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(await notifyStatements(h.deps)).toBe(0);
    const events = await call(h.app, "GET", "/v1/events?type=statement.ready", { token: w.apiKey });
    expect(events.body.data[0].data).toMatchObject({ period: "2026-10" });
  });
});

describe("auto-save", () => {
  it("runs scheduled saves and the excess sweep (ledger only)", async () => {
    const saver = await onboard(h, {
      name: "saver",
      fund: usdc("100"),
      policy: { limits: { per_tx: "100.00" }, max_balance: "60.00" },
    });
    const vault = await agentCall(h, saver.session, "POST", "/v1/vaults", {
      body: { account_id: saver.account.id, kind: "goal", name: "Jar" },
    });
    const { putPolicy } = await import("./support/flows");
    const signed = await putPolicy(h, saver, saver.agent.id, {
      limits: { per_tx: "100.00" },
      max_balance: "60.00",
      auto_save: { scheduled: [{ amount: "5.00", every: "day", to: `vault:${vault.body.id}` }] },
    });
    expect(signed.status).toBe(200);
    h.clock.advanceSeconds(3_601); // the signed change is a loosening-free auto-save change but give it time anyway
    expect(await runAutoSave(h.deps)).toBeGreaterThanOrEqual(1);
    const balances = await call(h.app, "GET", `/v1/accounts/${saver.account.id}/balances`, {
      token: saver.apiKey,
    });
    expect(balances.body.vaults[0].balance).toBe("5.00");
    expect(balances.body.available).toBe("60.00"); // 100 - 5 saved - 35 swept above max_balance
    expect(balances.body.savings).toBe("40.00");
  });

  it("splits income into savings when a payment to the agent settles", async () => {
    const earner = await onboard(h, {
      name: "earner",
      policy: { limits: { per_tx: "100.00" }, auto_save: { income_split: { bps: 1000, to: "treasury" } } },
    });
    const payer = await onboard(h, { name: "payer2", fund: usdc("100") });
    const paid = await payAndSign(h, payer, {
      amount: { amount: "50.00", asset: "USDC" },
      to: { agent_id: earner.agent.id },
    });
    expect(paid.body.status).toBe("submitted");
    await h.indexer.sync();
    await processSettled(h.deps);
    expect(await h.ledger.balance(pocket(earner.account.id, "savings"))).toBe(usdc("5"));
    expect(await h.ledger.balance(pocket(earner.account.id, "operating"))).toBe(usdc("45"));
  });
});

describe("co-signer outbox", () => {
  it("redelivers queued freezes once the co-signer is back", async () => {
    h.cosigner.available = false;
    await call(h.app, "POST", `/v1/agents/${w.agent.id}/freeze`, {
      token: w.apiKey,
      body: { reason: "outage test" },
    });
    h.cosigner.available = true;
    h.clock.advanceSeconds(10);
    expect(await deliverCosignerOutbox(h.deps)).toBe(1);
    expect(h.cosigner.callsTo("freeze").at(-1)).toMatchObject({ scope: "agent", id: w.agent.id });
    // The real co-signer now refuses anything for the agent.
    const decision = await h.cosigner.evaluate({
      org_id: w.org.id,
      agent_id: w.agent.id,
      account_id: w.account.id,
      account_address: w.account.address,
      chain_id: h.chain.chainId,
      intent: {
        kind: "transfer",
        amount: "1000000",
        asset: "USDC",
        counterparty: { address: "0x1111111111111111111111111111111111111111" },
      },
    });
    expect(decision.outcome).toBe("deny");
    expect(decision.rule_hits.some((r) => r.rule.includes("frozen"))).toBe(true);
  });
});

describe("maintenance and reports", () => {
  it("prunes spent nonces and old idempotency records", async () => {
    await agentCall(h, w.session, "GET", `/v1/accounts/${w.account.id}`).catch(() => undefined);
    h.clock.advanceSeconds(8 * 86_400);
    expect(await prune(h.deps)).toBeGreaterThan(0);
  });

  it("runs every registered job without throwing", async () => {
    for (const job of JOBS) expect(await runJob(h.deps, job)).toBeGreaterThanOrEqual(0);
  });

  it("reports revenue by business-model stream with gross margin", async () => {
    const res = await call(h.app, "GET", "/v1/admin/revenue?period=2026-11", { token: TEST_STAFF_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.revenue_by_stream.subscriptions).toBe("99.00");
    expect(res.body.revenue_by_stream.outbound).toBe("0.10"); // the income-split test payment settled in November
    expect(res.body.total_revenue).toBe("99.10");
    expect(res.body.volume_by_kind.transfer).toBe("50.00");
    expect(res.body.gross_margin_bps).toBeGreaterThan(0);
    expect(res.body.paying_orgs.pro).toBe(1);
    const october = await call(h.app, "GET", "/v1/admin/revenue?period=2026-10", { token: TEST_STAFF_TOKEN });
    expect(october.body.revenue_by_stream).toMatchObject({
      subscriptions: "99.00",
      outbound: "0.00",
      escrow: "0.00",
    });
  });
});
