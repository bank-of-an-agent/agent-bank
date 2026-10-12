import { usdc } from "@agentbank/core";
import { PolicyDeniedError } from "@agentbank/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, randomAccount, waitFor } from "../src/actors";
import { assertGlobalInvariants } from "../src/invariants";
import { startStack, type Stack } from "../src/stack";

/**
 * Phase 3 human controls on the simulated chain, with the manual world clock: approvals
 * (approve, deny, 15-minute expiry), asymmetric policy changes (loosening needs the owner and a
 * 1-hour delay; tightening is immediate), freeze then delayed unfreeze, and AP2 mandate budget
 * exhaustion. Global invariants hold throughout.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 120_000);

afterAll(async () => {
  await stack.stopStack();
});

async function expectDenied(promise: Promise<unknown>, rule?: string): Promise<PolicyDeniedError> {
  try {
    await promise;
  } catch (error) {
    expect(error, "expected a PolicyDeniedError").toBeInstanceOf(PolicyDeniedError);
    const denied = error as PolicyDeniedError;
    if (rule) {
      const hits = denied.decision?.rule_hits?.map((h) => h.rule) ?? [];
      expect(hits, `rule ${rule} among ${JSON.stringify(hits)}`).toContain(rule);
    }
    return denied;
  }
  throw new Error("expected the payment to be denied");
}

describe("approvals", () => {
  it("queues a payment above the threshold, settles it on approval", async () => {
    const world = await onboardAgent(stack, {
      name: "approve",
      fund: usdc("200"),
      policy: { limits: { per_tx: "100.00" }, approvals: [{ above: "10.00", approvers: 1 }] },
    });
    const payee = randomAccount();
    const payment = await world.agent.pay({ to: payee.address, amount: "20.00" });
    expect(payment.status).toBe("requires_approval");
    expect(payment.approval_id).toMatch(/^apr_/);

    const pending = await world.principal.approvals.list({ status: "pending" });
    expect(pending.data.some((a) => a.id === payment.approval_id)).toBe(true);

    const decided = await world.principal.approvals.decide(payment.approval_id as string, {
      decision: "approve",
    });
    expect(decided.status).toBe("approved");

    const settled = await world.agent.completePayment(payment.id, { waitForSettlement: true });
    expect(settled.status).toBe("settled");
    await waitFor(
      stack,
      async () => stack.sim.balanceOf(payee.address) === usdc("20"),
      "approved payment paid",
    );

    await assertGlobalInvariants(stack, "approval approve");
  });

  it("denies a payment an approver rejects and voids its hold", async () => {
    const world = await onboardAgent(stack, {
      name: "deny",
      fund: usdc("100"),
      policy: { limits: { per_tx: "100.00" }, approvals: [{ above: "10.00", approvers: 1 }] },
    });
    const payment = await world.agent.pay({ to: randomAccount().address, amount: "30.00" });
    expect(payment.status).toBe("requires_approval");
    expect((await world.agent.balance()).reserved).toBe("30.06"); // amount + 0.20% fee held

    await world.principal.approvals.decide(payment.approval_id as string, { decision: "deny" });
    const denied = await waitFor(
      stack,
      async () => {
        const p = await world.principal.payments.retrieve(payment.id);
        return p.status === "denied" ? p : undefined;
      },
      "payment denied by approver",
    );
    expect(denied.status).toBe("denied");
    expect((await world.agent.balance()).reserved).toBe("0.00");
    expect((await world.agent.balance()).available).toBe("100.00");

    await assertGlobalInvariants(stack, "approval deny");
  });

  it("expires an approval after 15 minutes and voids the hold", async () => {
    const world = await onboardAgent(stack, {
      name: "expire",
      fund: usdc("100"),
      policy: { limits: { per_tx: "100.00" }, approvals: [{ above: "10.00", approvers: 1 }] },
    });
    const payment = await world.agent.pay({ to: randomAccount().address, amount: "40.00" });
    expect(payment.status).toBe("requires_approval");

    stack.clock.advance(16 * 60_000); // past the 15-minute approval window
    const expired = await waitFor(
      stack,
      async () => {
        const p = await world.principal.payments.retrieve(payment.id);
        return p.status === "expired" ? p : undefined;
      },
      "approval expiry",
    );
    expect(expired.status).toBe("expired");
    expect((await world.agent.balance()).available).toBe("100.00");

    await assertGlobalInvariants(stack, "approval expiry");
  });
});

describe("asymmetric policy changes", () => {
  it("loosening waits an hour behind the owner key; tightening is immediate", async () => {
    const world = await onboardAgent(stack, {
      name: "policy",
      fund: usdc("500"),
      policy: { limits: { per_tx: "10.00" }, counterparties: { mode: "open" } },
    });
    const payee = randomAccount();

    // Over the cap: denied.
    await expectDenied(world.agent.pay({ to: payee.address, amount: "50.00" }), "limits.per_tx");

    // Loosen per_tx to 100 (owner-signed). The co-signer keeps the old cap for an hour.
    await world.principal.setPolicy(world.agentId, {
      limits: { per_tx: "100.00" },
      counterparties: { mode: "open" },
    });
    const pending = await world.principal.policies.retrieve(world.agentId);
    expect(pending.pending?.rules.limits?.per_tx).toBe("100.00");
    await expectDenied(world.agent.pay({ to: payee.address, amount: "50.00" }), "limits.per_tx");

    // After the 1-hour delay the looser cap is in force.
    stack.clock.advance(61 * 60_000);
    const loosened = await waitFor(
      stack,
      async () => {
        try {
          return await world.agent.pay(
            { to: payee.address, amount: "50.00" },
            { waitForSettlement: true, idempotencyKey: `loosened-${payee.address}` },
          );
        } catch {
          return undefined;
        }
      },
      "loosened payment settles",
    );
    expect(loosened.status).toBe("settled");

    // Tighten to 5 (no owner signature needed): denied at once.
    await world.principal.setPolicy(
      world.agentId,
      { limits: { per_tx: "5.00" }, counterparties: { mode: "open" } },
      { authorize: false },
    );
    await expectDenied(world.agent.pay({ to: payee.address, amount: "50.00" }), "limits.per_tx");

    await assertGlobalInvariants(stack, "policy changes");
  });
});

describe("freeze and unfreeze", () => {
  it("freezes an agent immediately and unfreezes after the owner-signed delay", async () => {
    const world = await onboardAgent(stack, { name: "freeze", fund: usdc("100") });
    const payee = randomAccount();

    await world.principal.agents.freeze(world.agentId, { reason: "incident drill" });
    const frozen = await world.principal.agents.retrieve(world.agentId);
    expect(frozen.status).toBe("frozen");
    // A frozen agent cannot write.
    await expect(world.agent.pay({ to: payee.address, amount: "1.00" })).rejects.toMatchObject({
      code: "agent_frozen",
    });

    await world.principal.unfreezeAgent(world.agentId, "resolved");
    // Still frozen until the 1-hour delay elapses.
    await expect(world.agent.pay({ to: payee.address, amount: "1.00" })).rejects.toMatchObject({
      code: "agent_frozen",
    });

    stack.clock.advance(61 * 60_000);
    const paid = await waitFor(
      stack,
      async () => {
        try {
          return await world.agent.pay(
            { to: payee.address, amount: "1.00" },
            { waitForSettlement: true, idempotencyKey: `unfrozen-${payee.address}` },
          );
        } catch {
          return undefined;
        }
      },
      "payment after unfreeze",
    );
    expect(paid.status).toBe("settled");

    await assertGlobalInvariants(stack, "freeze");
  });
});

describe("mandates", () => {
  it("denies once the mandate budget is exhausted", async () => {
    const world = await onboardAgent(stack, { name: "mandate", fund: usdc("500") });
    const iat = stack.clock.nowSeconds() - 5;
    const mandate = await world.principal.issueMandate(world.agentId, {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.budget", currency: "USDC", max: "30000000" }, // $30 budget
        { type: "payment.amount_range", currency: "USDC", max: "25000000" },
      ],
      iat,
      exp: iat + 3600,
      agent_id: world.agentId,
    });
    expect(mandate.status).toBe("active");

    const payee = randomAccount();
    const first = await world.agent.pay(
      { to: payee.address, amount: "20.00", mandateId: mandate.id },
      { waitForSettlement: true },
    );
    expect(first.status).toBe("settled");

    // $20 + $15 would exceed the $30 mandate budget.
    await expectDenied(
      world.agent.pay({ to: payee.address, amount: "15.00", mandateId: mandate.id }),
      "mandate.budget",
    );

    await assertGlobalInvariants(stack, "mandate budget");
  });
});
