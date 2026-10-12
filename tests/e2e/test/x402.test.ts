import { usdc } from "@agentbank/core";
import { readPaymentResponse } from "@agentbank/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, waitFor, type AgentWorld } from "../src/actors";
import { assertGlobalInvariants } from "../src/invariants";
import { resolvingFetch } from "../src/net";
import { startDemoSeller, type DemoSeller } from "../src/seller";
import { startStack, type Stack } from "../src/stack";

/**
 * Phase 3 x402 (simulated chain): refill the spend-key float from the account under policy, then
 * the buyer's `fetch` pays the seller's paywall through our facilitator — `/weather` ($0.01,
 * settled after serving) and `/report` ($2.00, settled before serving). Both sides reconcile and
 * a 0.5% receive fee accrues to the seller.
 */

const SELLER_HOST = "api.seller.test";
let stack: Stack;
let seller: AgentWorld;
let demoSeller: DemoSeller;

beforeAll(async () => {
  stack = await startStack();
  // The seller receives x402 payments to its Agent Bank account (registered for its domain).
  seller = await onboardAgent(stack, { name: "x402-seller", x402Domains: [SELLER_HOST] });
  demoSeller = await startDemoSeller({
    facilitatorUrl: stack.facilitatorUrl,
    payTo: seller.accountAddress,
    network: `eip155:${stack.chainId}`,
  });
}, 120_000);

afterAll(async () => {
  await demoSeller.close();
  await stack.stopStack();
});

/** A buyer whose x402 `fetch` resolves the seller's host name to the local demo server. */
async function makeBuyer(): Promise<AgentWorld> {
  const fetchImpl = resolvingFetch((host) =>
    host === SELLER_HOST ? `127.0.0.1:${demoSeller.port}` : undefined,
  );
  return onboardAgent(stack, {
    name: "x402-buyer",
    fund: usdc("200"),
    x402Fetch: fetchImpl,
    maxX402PerCall: "5.00",
  });
}

describe("x402 buyer and seller", () => {
  it("refills the spend-key float from the account under the full policy stack", async () => {
    const buyer = await makeBuyer();
    expect((await buyer.agent.balance()).spend_float).toBe("0.00");

    // A refill is a session + co-signer payment to the agent's own spend key (fee-free, ADR 0001).
    const refill = await buyer.agent.pay(
      { to: buyer.spendKeyAddress, amount: "10.00", memo: "float refill" },
      { waitForSettlement: true },
    );
    expect(refill.status).toBe("settled");
    expect(refill.kind).toBe("refill");
    expect(refill.fee.amount).toBe("0.00");

    await waitFor(stack, async () => (await buyer.agent.balance()).spend_float === "10.00", "float funded");
    await assertGlobalInvariants(stack, "spend-key refill");
  });

  it("pays a cheap resource (settle-after-serve) and reconciles both sides with a 0.5% fee", async () => {
    const buyer = await makeBuyer();
    await buyer.agent.pay(
      { to: buyer.spendKeyAddress, amount: "10.00" },
      { waitForSettlement: true, idempotencyKey: `${buyer.accountId}-refill` },
    );
    await waitFor(stack, async () => (await buyer.agent.balance()).spend_float === "10.00", "float funded");

    const sellerBefore = Number((await seller.agent.balance()).available);
    const result = await buyer.agent.fetchWithPayment(`https://${SELLER_HOST}/weather`);
    expect(result.response.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.amount).toBe("0.01");
    const payload = (await result.response.json()) as { city: string };
    expect(payload.city).toBe("San Francisco");
    const settlement = readPaymentResponse(result.response);
    expect(settlement?.success).toBe(true);
    expect(settlement?.transaction).toMatch(/^0x/);

    // The spend key paid $0.01 on-chain; the seller received it and owes a 0.5% fee (min rounding).
    await waitFor(
      stack,
      async () => Number((await buyer.agent.balance()).spend_float) <= 10 - 0.01,
      "float debited",
    );
    await waitFor(
      stack,
      async () => Number((await seller.agent.balance()).available) >= sellerBefore + 0.01 - 0.0001,
      "seller credited",
    );
    const sellerFees = await waitFor(
      stack,
      async () => {
        const f = Number((await seller.agent.balance()).fees);
        return f > 0 ? f : undefined;
      },
      "x402 receive fee accrued",
    );
    expect(sellerFees).toBeGreaterThan(0); // 0.5% of 0.01, rounded up

    await assertGlobalInvariants(stack, "x402 weather");
  });

  it("settles a $2.00 resource before serving (above the $1 threshold)", async () => {
    const buyer = await makeBuyer();
    await buyer.agent.pay(
      { to: buyer.spendKeyAddress, amount: "10.00" },
      { waitForSettlement: true, idempotencyKey: `${buyer.accountId}-refill` },
    );
    await waitFor(stack, async () => Number((await buyer.agent.balance()).spend_float) >= 10, "float funded");

    expect(demoSeller.reportPaywall.settleBeforeServe).toBe(true);
    const result = await buyer.agent.fetchWithPayment(`https://${SELLER_HOST}/report`);
    expect(result.response.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.amount).toBe("2.00");
    const body = (await result.response.json()) as { title: string };
    expect(body.title).toContain("report");
    // Settle-before-serve: the settlement is already on-chain when the body is served.
    const settlement = readPaymentResponse(result.response);
    expect(settlement?.success).toBe(true);

    await waitFor(
      stack,
      async () => Number((await buyer.agent.balance()).spend_float) <= 10 - 2,
      "float debited for report",
    );
    await assertGlobalInvariants(stack, "x402 report");
  });
});
