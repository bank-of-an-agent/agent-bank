import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, randomAccount, waitFor } from "../src/actors";
import { startStack, type Stack } from "../src/stack";

/**
 * A boot + happy-path check: onboard an agent with the real SDKs over HTTP, faucet a deposit the
 * reconciler posts, and make one agent-to-address payment that the co-signer co-signs and the
 * reconciler settles. If this passes, the stack is wired correctly.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 120_000);

afterAll(async () => {
  await stack.stopStack();
});

describe("stack smoke", () => {
  it("onboards an agent and settles a payment", async () => {
    const world = await onboardAgent(stack, { fund: usdc("100"), spendFloat: usdc("10") });
    const balances = await world.agent.balance();
    expect(Number(balances.available)).toBeGreaterThanOrEqual(100);
    expect(Number(balances.spend_float)).toBeGreaterThanOrEqual(10);

    const payee = randomAccount();
    const payment = await world.agent.pay(
      { to: payee.address, amount: "5.00", memo: "smoke" },
      { waitForSettlement: true, timeoutMs: 30_000 },
    );
    expect(payment.status).toBe("settled");
    expect(payment.fee.amount).toBe("0.01"); // 0.20% of 5.00, min rounding

    await waitFor(stack, async () => stack.sim.balanceOf(payee.address) === usdc("5"), "payee paid");
    expect(stack.sim.balanceOf(payee.address)).toBe(usdc("5"));

    // Global invariants.
    const ledger = await stack.ledger.verifyInvariants();
    expect(ledger.ok).toBe(true);
    const recon = await stack.reconciler.verify();
    expect(recon.ok).toBe(true);
    for (const row of await stack.expectedOnChain()) {
      expect(row.onchain, `on-chain == expected for ${row.address}`).toBe(row.expected);
    }
  });
});
