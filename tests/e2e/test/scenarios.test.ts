import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundAddress, onboardAgent, randomAccount, waitFor, type AgentWorld } from "../src/actors";
import { assertGlobalInvariants } from "../src/invariants";
import { WebhookReceiver } from "../src/webhooks";
import { startStack, type Stack } from "../src/stack";

/**
 * Phase 3 scenarios (simulated chain): principal onboarding, a faucet deposit, agent-to-agent
 * and external payments with balances by pocket, ledger entries, a statement CSV and webhooks
 * delivered with a valid HMAC, payment requests, and the owner-operations inbox. Global
 * invariants are asserted after each scenario.
 */

let stack: Stack;
let hooks: WebhookReceiver;

beforeAll(async () => {
  stack = await startStack();
  hooks = await WebhookReceiver.start();
}, 120_000);

afterAll(async () => {
  await hooks.close();
  await stack.stopStack();
});

async function withWebhooks(world: AgentWorld, path: string): Promise<string> {
  const endpoint = await world.principal.webhooks.createEndpoint({
    url: hooks.url(path),
    events: [
      "deposit.received",
      "payment.created",
      "payment.submitted",
      "payment.settled",
      "payment.denied",
      "approval.requested",
    ],
  });
  return endpoint.secret;
}

describe("onboarding and the owner-operations inbox", () => {
  it("sets up org → agent → account → spend key + permit → policy → session, deploying the account", async () => {
    const world = await onboardAgent(stack, { name: "onboard" });
    const account = await world.principal.accounts.retrieve(world.accountId);
    expect(account.deployed).toBe(true);
    expect(account.role).toBe("agent");
    expect(account.spend_key_address?.toLowerCase()).toBe(world.spendKeyAddress.toLowerCase());
    // ADR 0001: the float-recovery permit executed in the setup owner operation.
    expect(account.spend_key_permit).toBe("executed");

    const session = await world.principal.sessions.retrieve(world.sessionId);
    expect(session.status).toBe("active");
    expect(session.onchain_tx).toMatch(/^0x/);

    // The owner-operations inbox shows the setup operation (session install), succeeded.
    const ops = await world.principal.ownerOperations.list({ account_id: world.accountId });
    const install = ops.data.find((o) => o.subject_id === world.sessionId);
    expect(install?.status).toBe("succeeded");
    expect(install?.tx_hash).toMatch(/^0x/);

    await assertGlobalInvariants(stack, "onboarding");
  });
});

describe("deposits and payments", () => {
  it("posts a faucet deposit and emits deposit.received", async () => {
    const world = await onboardAgent(stack, { name: "deposit" });
    const secret = await withWebhooks(world, "/deposit");

    await fundAddress(stack, world.accountAddress, usdc("250"));
    const balances = await world.agent.balance();
    expect(balances.available).toBe("250.00");
    expect(balances.total).toBe("250.00");

    const deposit = await waitFor(
      stack,
      async () => hooks.received("/deposit", "deposit.received")[0],
      "deposit.received webhook",
    );
    expect(WebhookReceiver.verifies(deposit, secret)).toBe(true);
    expect(deposit.body.data.amount).toMatchObject({ amount: "250.00", asset: "USDC" });

    await assertGlobalInvariants(stack, "deposit");
  });

  it("pays an external address and another agent, moving funds by pocket with a 0.20% fee", async () => {
    const payer = await onboardAgent(stack, { name: "payer", fund: usdc("500") });
    const secret = await withWebhooks(payer, "/pay");
    const payee = await onboardAgent(stack, { name: "payee" });
    const external = randomAccount();

    // External payment.
    const ext = await payer.agent.pay(
      { to: external.address, amount: "40.00", memo: "external" },
      { waitForSettlement: true },
    );
    expect(ext.status).toBe("settled");
    expect(ext.fee.amount).toBe("0.08"); // 0.20% of 40.00
    expect(ext.counterparty.type).toBe("address");
    await waitFor(stack, async () => stack.sim.balanceOf(external.address) === usdc("40"), "external paid");

    // Agent-to-agent payment (resolved to the payee's account).
    const a2a = await payer.agent.pay(
      { to: { agentId: payee.agentId }, amount: "25.00", memo: "a2a" },
      { waitForSettlement: true },
    );
    expect(a2a.status).toBe("settled");
    expect(a2a.counterparty.agent_id).toBe(payee.agentId);
    await waitFor(stack, async () => Number((await payee.agent.balance()).available) >= 25, "payee credited");

    // Balances by pocket: payer spent 40 + 25 + fees; payee received 25.
    const payerBalances = await payer.agent.balance();
    expect(payerBalances.reserved).toBe("0.00");
    expect(Number(payerBalances.available)).toBeCloseTo(500 - 40 - 25 - 0.08 - 0.05, 2);
    const payeeBalances = await payee.agent.balance();
    expect(payeeBalances.available).toBe("25.00");

    // Ledger entries for the payer's account include both payments.
    const entries = await payer.agent.listEntries({ limit: 50 });
    expect(entries.data.length).toBeGreaterThanOrEqual(2);

    // Webhooks: created → submitted → settled, each with a valid HMAC.
    await waitFor(
      stack,
      async () => hooks.received("/pay", "payment.settled").length >= 2,
      "two payment.settled webhooks",
    );
    for (const d of hooks.received("/pay")) expect(WebhookReceiver.verifies(d, secret)).toBe(true);
    expect(hooks.received("/pay", "payment.created").length).toBeGreaterThanOrEqual(2);
    expect(hooks.received("/pay", "payment.submitted").length).toBeGreaterThanOrEqual(2);

    await assertGlobalInvariants(stack, "payments");
  });

  it("produces a monthly statement as JSON and CSV", async () => {
    const world = await onboardAgent(stack, { name: "statement", fund: usdc("100") });
    await world.agent.pay({ to: randomAccount().address, amount: "10.00" }, { waitForSettlement: true });
    const period = new Date(stack.clock.nowMs()).toISOString().slice(0, 7);

    const statement = await world.principal.ledger.statement({ account_id: world.accountId, period });
    expect(statement.object).toBe("statement");
    expect(Number(statement.total_out)).toBeGreaterThan(0);
    expect(statement.lines.length).toBeGreaterThan(0);

    const csv = await world.principal.ledger.statementCsv({ account_id: world.accountId, period });
    expect(csv).toContain("balance");
    expect(csv.split("\r\n").length).toBeGreaterThan(2);

    await assertGlobalInvariants(stack, "statement");
  });
});

describe("payment requests", () => {
  it("creates a request another agent pays, and marks it paid", async () => {
    const seller = await onboardAgent(stack, { name: "req-seller" });
    const buyer = await onboardAgent(stack, { name: "req-buyer", fund: usdc("100") });

    const request = await seller.agent.requestPayment({
      amount: "15.00",
      memo: "invoice 7",
      reference: "INV-7",
    });
    expect(request.status).toBe("open");
    expect(request.pay_to.toLowerCase()).toBe(seller.accountAddress.toLowerCase());
    expect(request.pay_link).toContain(request.id);

    const payment = await buyer.agent.pay(
      { to: { address: request.pay_to }, amount: "15.00", paymentRequestId: request.id },
      { waitForSettlement: true },
    );
    expect(payment.status).toBe("settled");

    const fulfilled = await waitFor(
      stack,
      async () => {
        const r = await buyer.principal.paymentRequests.retrieve(request.id);
        return r.status === "paid" ? r : undefined;
      },
      "payment request paid",
    );
    expect(fulfilled.paid_by_payment_id).toBe(payment.id);

    await assertGlobalInvariants(stack, "payment request");
  });
});
