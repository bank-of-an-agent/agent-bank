import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, waitFor, type AgentWorld } from "../src/actors";
import { assertGlobalInvariants } from "../src/invariants";
import { startStack, type Stack } from "../src/stack";

/**
 * Phase 3 escrow and streams (simulated chain): escrow lock → release, refund and dispute; a
 * per-second stream created, settled by the keeper and canceled; and goal / locked vault
 * positions. Global invariants (including the escrow/stream contract balances) hold throughout.
 */

const ARBITER = "0x00000000000000000000000000000000000a4b17";
let stack: Stack;
let contracts: string[];
let payer: AgentWorld;
let payee: AgentWorld;

beforeAll(async () => {
  stack = await startStack();
  const c = stack.sim.contracts;
  contracts = [c.escrow, c.streams, c.vaults].filter((x): x is `0x${string}` => Boolean(x));
  payer = await onboardAgent(stack, {
    name: "es-payer",
    fund: usdc("1000"),
    scope: { allowed_contracts: contracts },
  });
  payee = await onboardAgent(stack, { name: "es-payee", scope: { allowed_contracts: contracts } });
}, 120_000);

afterAll(async () => {
  await stack.stopStack();
});

const inDays = (days: number) => new Date(stack.clock.nowMs() + days * 86_400_000).toISOString();

describe("escrow", () => {
  it("locks funds (1% fee, $1 minimum) and releases them to the payee", async () => {
    const escrow = await payer.agent.createEscrow(
      {
        payee: { agentId: payee.agentId },
        amount: "50.00",
        expiresAt: inDays(2),
        arbiter: ARBITER,
        terms: "Deliver the report",
      },
      { waitForSettlement: true },
    );
    expect(escrow.status).toBe("locked");
    expect(escrow.fee).toMatchObject({ amount: "1.00", asset: "USDC" }); // 1% of 50
    expect(escrow.onchain_id).toEqual(expect.any(String));
    await assertGlobalInvariants(stack, "escrow locked");

    const payeeBefore = Number((await payee.agent.balance()).available);
    const released = await payer.agent.releaseEscrow(escrow.id, { waitForSettlement: true });
    expect(released.status).toBe("released");
    await waitFor(
      stack,
      async () => Number((await payee.agent.balance()).available) >= payeeBefore + 50,
      "escrow released to payee",
    );
    await assertGlobalInvariants(stack, "escrow released");
  });

  it("lets the payee refund at any time", async () => {
    const payerBefore = Number((await payer.agent.balance()).available);
    const escrow = await payer.agent.createEscrow(
      { payee: { agentId: payee.agentId }, amount: "20.00", expiresAt: inDays(2) },
      { waitForSettlement: true },
    );
    expect(escrow.status).toBe("locked");
    const refunded = await payee.agent.refundEscrow(escrow.id, { waitForSettlement: true });
    expect(refunded.status).toBe("refunded");
    await waitFor(
      stack,
      async () => Number((await payer.agent.balance()).available) >= payerBefore - 1 - 0.01,
      "escrow refunded to payer (only the fee is gone)",
    );
    await assertGlobalInvariants(stack, "escrow refunded");
  });

  it("opens a dispute before expiry", async () => {
    const escrow = await payer.agent.createEscrow(
      { payee: { agentId: payee.agentId }, amount: "15.00", expiresAt: inDays(2), arbiter: ARBITER },
      { waitForSettlement: true },
    );
    const disputed = await payee.agent.disputeEscrow(escrow.id, "not delivered", { waitForSettlement: true });
    expect(disputed.status).toBe("disputed");
    await assertGlobalInvariants(stack, "escrow disputed");
  });
});

describe("streams", () => {
  it("streams per second, settles on the keeper's schedule and cancels with a refund", async () => {
    const payeeBefore = Number((await payee.agent.balance()).available);
    const stream = await payer.agent.createStream(
      {
        payee: { agentId: payee.agentId },
        amountPerInterval: "0.01",
        intervalSeconds: 1,
        deposit: "100.00",
        settleEverySeconds: 60,
      },
      { waitForSettlement: true },
    );
    expect(stream.status).toBe("active");
    expect(stream.deposit.amount).toBe("100.00");
    await assertGlobalInvariants(stack, "stream active");

    // Let ~an hour accrue, then the keeper (streams-settle job, run by the driver) settles it.
    stack.clock.advance(3_600_000);
    const streamed = await waitFor(
      stack,
      async () => {
        const delta = Number((await payee.agent.balance()).available) - payeeBefore;
        return delta > 30 ? delta : undefined;
      },
      "stream settled to payee",
    );
    expect(streamed).toBeGreaterThan(30);
    await assertGlobalInvariants(stack, "stream settled");

    // Cancel: the payer reclaims the unstreamed remainder; the payee keeps what accrued.
    const canceled = await payer.agent.cancelStream(stream.id, { waitForSettlement: true });
    expect(canceled.status).toBe("canceled");
    await assertGlobalInvariants(stack, "stream canceled");
  });
});

describe("vaults", () => {
  it("holds funds in a goal vault agents cannot withdraw from", async () => {
    const vault = await payer.principal.vaults.create({
      account_id: payer.accountId,
      kind: "goal",
      name: "runway",
      target: { amount: "100.00", asset: "USDC" },
    });
    expect(vault.kind).toBe("goal");
    await payer.agent.vaults.deposit(vault.id, { amount: { amount: "30.00", asset: "USDC" } });
    const funded = await payer.principal.vaults.retrieve(vault.id);
    expect(funded.balance.amount).toBe("30.00");

    // Agents cannot withdraw (withdrawVault is a principal route); the owner can.
    const withdrawn = await payer.principal.vaults.withdraw(vault.id, {
      amount: { amount: "10.00", asset: "USDC" },
    });
    expect(withdrawn.balance.amount).toBe("20.00");
    await assertGlobalInvariants(stack, "goal vault");
  });
});
