import { usdc } from "@agentbank/core";
import { keccak256, stringToHex, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pocket } from "../src/domain/ledger-refs";
import { expirePending } from "../src/jobs/expiry";
import { processSettled } from "../src/jobs/settlement";
import { agentCall, call, createHarness, type Harness } from "./support/harness";
import { fund, onboard, type World } from "./support/flows";

let h: Harness;
let buyer: World;
let seller: World;

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function requirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:1337",
    asset: h.chain.contracts.usdc,
    amount: "1500000",
    payTo: seller.account.address,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

async function pay(world: World, req: Record<string, unknown>, url = "https://api.example-data.com/report") {
  return agentCall(h, world.session, "POST", "/v1/x402/pay", {
    body: { account_id: world.account.id, resource: { url, description: "Daily report" }, requirements: req },
  });
}

beforeAll(async () => {
  h = await createHarness();
  buyer = await onboard(h, {
    name: "buyer",
    policy: {
      limits: { per_tx: "100.00" },
      counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"] },
      approvals: [{ above: "50.00", approvers: 1 }],
    },
  });
  await fund(h, buyer.account, usdc("10"), "spend");
  seller = await onboard(h, { name: "seller" });
});
afterAll(async () => h.close());

describe("x402 pay", () => {
  it("returns an EIP-3009 authorization for the spend key and holds the float", async () => {
    const res = await pay(buyer, requirements());
    expect(res.status).toBe(200);
    const { payment, authorization, eip712_domain } = res.body;
    expect(res.body.object).toBe("x402_authorization");
    expect(payment).toMatchObject({
      kind: "x402",
      status: "requires_signature",
      fee: { amount: "0.00", asset: "USDC" },
    });
    expect(payment.counterparty).toMatchObject({
      type: "x402",
      x402_domain: "api.example-data.com",
      agent_id: seller.agent.id,
    });
    expect(authorization).toEqual({
      from: buyer.spendKey.address,
      to: seller.account.address,
      value: "1500000",
      validAfter: String(Math.floor(h.clock.now().getTime() / 1000) - 600),
      validBefore: String(Math.floor(h.clock.now().getTime() / 1000) + 60),
      nonce: keccak256(stringToHex(payment.id)),
    });
    expect(eip712_domain).toEqual({
      name: "USDC",
      version: "2",
      chainId: 1337,
      verifyingContract: h.chain.contracts.usdc,
    });
    expect(await h.ledger.balance(pocket(buyer.account.id, "spend_reserved"))).toBe(usdc("1.5"));
    expect(h.cosigner.callsTo("authorizeX402")).toHaveLength(1);

    // The seller's facilitator settles the signed authorization on-chain.
    const signature = await buyer.spendKey.signTypedData({
      domain: { ...eip712_domain, verifyingContract: eip712_domain.verifyingContract as Hex },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    await h.chain.settleAuthorization({
      token: h.chain.contracts.usdc,
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
      signature,
    });
    expect(h.sim.balanceOf(seller.account.address)).toBe(usdc("1.5"));

    // Past its deadline, a used authorization keeps its hold for the reconciler to post.
    h.clock.advanceSeconds(60 + 601);
    await expirePending(h.deps);
    const after = await agentCall(h, buyer.session, "GET", `/v1/payments/${payment.id}`);
    expect(after.body.status).toBe("requires_signature");
  });

  it("charges the seller's x402 receive fee once the settlement is final", async () => {
    // Settle and finish what earlier tests left on-chain first.
    await h.indexer.sync();
    await processSettled(h.deps);
    await call(h.app, "POST", "/v1/x402/payees", {
      token: seller.apiKey,
      body: { account_id: seller.account.id, domains: ["api.example-data.com"] },
    });
    const res = await pay(buyer, requirements({ amount: "2000000" }));
    const { payment, authorization, eip712_domain } = res.body;
    const message = {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    };
    const signature = await buyer.spendKey.signTypedData({
      domain: { ...eip712_domain, verifyingContract: eip712_domain.verifyingContract as Hex },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: "TransferWithAuthorization",
      message,
    });
    await h.chain.settleAuthorization({ token: h.chain.contracts.usdc, ...message, signature });
    // The reconciler settles it at once (below the finality threshold), but the post-settlement
    // effects wait until the block is final: a reorg cannot undo them.
    await h.indexer.sync({ finalize: false });
    const settled = await agentCall(h, buyer.session, "GET", `/v1/payments/${payment.id}`);
    expect(settled.body.status).toBe("settled");
    expect(await processSettled(h.deps)).toBe(0);
    expect(await h.ledger.balance(pocket(seller.account.id, "fees"))).toBe(0n);

    await h.indexer.sync();
    expect(await processSettled(h.deps)).toBe(1);
    expect(await h.ledger.balance(pocket(seller.account.id, "fees"))).toBe(usdc("0.01"));
    const fees = await call(h.app, "GET", "/v1/billing/fees?period=2026-10", { token: seller.apiKey });
    expect(fees.body.by_kind.x402_receive).toBe("0.01");
    expect(h.cosigner.callsTo("reportSettlement")).toContainEqual({
      payment_id: payment.id,
      status: "settled",
      amount: "2000000",
    });
    // Done once: a rerun changes nothing.
    expect(await processSettled(h.deps)).toBe(0);
    expect(await h.ledger.balance(pocket(seller.account.id, "fees"))).toBe(usdc("0.01"));
    expect(
      h.cosigner
        .callsTo("reportSettlement")
        .filter((r) => (r as { payment_id: string }).payment_id === payment.id),
    ).toHaveLength(1);
  });

  it("releases the float when an authorization is never used", async () => {
    const res = await pay(buyer, requirements({ amount: "1000000" }));
    const before = await h.ledger.balance(pocket(buyer.account.id, "spend_reserved"));
    h.clock.advanceSeconds(60 + 601);
    await expirePending(h.deps);
    const after = await agentCall(h, buyer.session, "GET", `/v1/payments/${res.body.payment.id}`);
    expect(after.body.status).toBe("expired");
    expect(await h.ledger.balance(pocket(buyer.account.id, "spend_reserved"))).toBe(before - usdc("1"));
    expect(h.cosigner.callsTo("reportSettlement")).toContainEqual({
      payment_id: res.body.payment.id,
      status: "failed",
    });
  });

  it("denies domains outside the allowlist with policy_denied", async () => {
    const res = await pay(buyer, requirements(), "https://other.example.org/data");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("policy_denied");
    expect(res.body.decision.outcome).toBe("deny");
    expect(res.body.payment_id).toMatch(/^pay_/);
  });

  it("refuses payments that would need a human", async () => {
    await fund(h, buyer.account, usdc("100"), "spend");
    const res = await pay(buyer, requirements({ amount: "60000000" }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("policy_denied");
    expect(res.body.decision.rule_hits.some((r: { rule: string }) => r.rule === "x402.human_required")).toBe(
      true,
    );
    const approvals = await call(h.app, "GET", "/v1/approvals?status=pending", { token: buyer.apiKey });
    expect(approvals.body.data).toHaveLength(0);
  });

  it("validates the challenge", async () => {
    expect((await pay(buyer, requirements({ network: "eip155:84532" }))).body.code).toBe("unsupported_chain");
    expect(
      (await pay(buyer, requirements({ asset: "0x1111111111111111111111111111111111111111" }))).body.code,
    ).toBe("unsupported_asset");
    expect((await pay(buyer, requirements({ scheme: "upto" }))).status).toBe(400);
    expect((await pay(buyer, requirements({ maxTimeoutSeconds: 1 }))).status).toBe(400);
    expect((await pay(buyer, requirements(), "https://127.0.0.1/x")).status).toBe(400);
  });

  it("refuses when the spend float cannot cover the payment", async () => {
    const thin = await onboard(h, { name: "thin" });
    await fund(h, thin.account, usdc("5"), "spend");
    const res = await pay(thin, requirements({ amount: "10000000" }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("insufficient_funds");
  });

  it("registers an x402 payee", async () => {
    const res = await call(h.app, "POST", "/v1/x402/payees", {
      token: seller.apiKey,
      body: { account_id: seller.account.id, domains: ["api.seller.example", "api.seller.example"] },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "x402_payee",
      pay_to: seller.account.address,
      domains: ["api.seller.example"],
      fee_bps: 50,
      facilitator_url: "http://localhost:8083/v1/x402",
    });
  });
});
