import { erc20Abi } from "@agentbank/chain";
import { newId, usdc } from "@agentbank/core";
import { encodeFunctionData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainMirror, pocket } from "../src/domain/ledger-refs";
import { pollReceipts } from "../src/domain/receipts";
import { expirePending } from "../src/jobs/expiry";
import { processSettled } from "../src/jobs/settlement";
import { apiKeyDisplayPrefix, newApiKeySecret, sha256Hex } from "../src/util/crypto";
import { agentCall, call, createHarness, type Harness } from "./support/harness";
import { fund, onboard, payAndSign, signHash, signOwnerOperation, type World } from "./support/flows";

let h: Harness;
let alice: World;
let bob: World;

const money = (amount: string) => ({ amount, asset: "USDC" });

beforeAll(async () => {
  h = await createHarness();
  alice = await onboard(h, { name: "alice", fund: usdc("1000") });
  bob = await onboard(h, { name: "bob" });
});
afterAll(async () => h.close());

async function balances(world: World) {
  const res = await call(h.app, "GET", `/v1/accounts/${world.account.id}/balances`, { token: world.apiKey });
  return res.body;
}

/** A key for a specific member (members create their own keys in the console). */
async function keyForMember(orgId: string, memberId: string, scopes: string[]): Promise<string> {
  const secret = newApiKeySecret();
  await h.db.query(
    `INSERT INTO api_key (id, org_id, name, prefix, secret_hash, scopes, created_at, member_id)
     VALUES ($1, $2, 'member key', $3, $4, $5, $6, $7)`,
    [newId("apiKey"), orgId, apiKeyDisplayPrefix(secret), sha256Hex(secret), scopes, h.clock.now(), memberId],
  );
  return secret;
}

describe("onboarding", () => {
  it("creates a counterfactual account and installs the session with an owner operation", async () => {
    expect(alice.account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const session = await call(h.app, "GET", `/v1/sessions/${alice.session.id}`, { token: alice.apiKey });
    expect(session.body.status).toBe("active");
    expect(session.body.onchain_tx).toMatch(/^0x/);
    const op = await call(h.app, "GET", `/v1/owner-operations/${session.body.install_operation_id}`, {
      token: alice.apiKey,
    });
    expect(op.body).toMatchObject({ purpose: "session.install", status: "succeeded" });
    const account = await call(h.app, "GET", `/v1/accounts/${alice.account.id}`, { token: alice.apiKey });
    expect(account.body.deployed).toBe(true);
    // The setup operation installed AgentPolicyHook and turned the ERC-7484 registry off.
    const onchain = h.sim.account(alice.account.address);
    expect(onchain?.globalHook).toBe(h.chain.contracts.policyHook);
    expect(onchain?.sessions).toHaveLength(1);
    const agent = await call(h.app, "GET", `/v1/agents/${alice.agent.id}`, { token: alice.apiKey });
    expect(agent.body.did).toBe(`did:pkh:eip155:1337:${alice.account.address}`);
  });

  it("rejects an owner-operation signature from another key", async () => {
    const org = await onboard(h, { name: "carol", install: false });
    const installed = await call(h.app, "POST", `/v1/sessions/${org.session.id}/install`, {
      token: org.apiKey,
    });
    const opId = installed.body.install_operation_id as string;
    const op = await call(h.app, "GET", `/v1/owner-operations/${opId}`, { token: org.apiKey });
    const forged = await signHash(org.session.key, op.body.user_op_hash);
    const res = await call(h.app, "POST", `/v1/owner-operations/${opId}/signature`, {
      token: org.apiKey,
      body: { signature: forged },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("owner_signature_required");
  });

  it("shows balances from the ledger", async () => {
    const res = await agentCall(h, alice.session, "GET", `/v1/accounts/${alice.account.id}/balances`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: "1000.00",
      reserved: "0.00",
      total: "1000.00",
      asset: "USDC",
    });
  });
});

describe("allowed payment", () => {
  it("holds amount + fee, co-signs, submits, and settles from chain evidence", async () => {
    const res = await payAndSign(h, alice, {
      amount: money("100.00"),
      to: { agent_id: bob.agent.id },
      memo: "dataset",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "submitted",
      kind: "transfer",
      fee: money("0.20"),
      signing_request: null,
    });
    expect(res.body.counterparty).toMatchObject({
      type: "agent",
      agent_id: bob.agent.id,
      address: bob.account.address,
    });
    expect(res.body.decision.outcome).toBe("allow");
    expect(h.sim.balanceOf(bob.account.address)).toBe(usdc("100"));
    expect(await h.ledger.balance(pocket(alice.account.id, "reserved"))).toBe(usdc("100.2"));
    expect(h.cosigner.callsTo("cosign")).toHaveLength(1);

    await h.indexer.sync();
    expect(await processSettled(h.deps)).toBe(1);
    const settled = await call(h.app, "GET", `/v1/payments/${res.body.id}`, { token: alice.apiKey });
    expect(settled.body.status).toBe("settled");
    expect((await balances(alice)).available).toBe("899.80");
    expect((await balances(bob)).available).toBe("100.00");
    const fees = await call(h.app, "GET", "/v1/billing/fees?period=2026-10", { token: alice.apiKey });
    expect(fees.body.by_kind.outbound_payment).toBe("0.20");
  });

  it("caps the outbound fee at $5.00", async () => {
    const before = await h.ledger.balance(pocket(alice.account.id, "reserved"));
    const created = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body: {
        account_id: alice.account.id,
        amount: money("300.00"),
        to: { address: "0x2222222222222222222222222222222222222222" },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.fee).toEqual(money("0.60"));
    const cancel = await agentCall(h, alice.session, "POST", `/v1/payments/${created.body.id}/cancel`);
    expect(cancel.body.status).toBe("canceled");
    expect(await h.ledger.balance(pocket(alice.account.id, "reserved"))).toBe(before);
    const big = await onboard(h, {
      name: "whale",
      fund: usdc("5000"),
      policy: { limits: { per_tx: "5000.00" } },
    });
    const huge = await agentCall(h, big.session, "POST", "/v1/payments", {
      body: {
        account_id: big.account.id,
        amount: money("4000.00"),
        to: { address: "0x2222222222222222222222222222222222222222" },
      },
    });
    expect(huge.body.fee).toEqual(money("5.00"));
  });

  it("replays idempotent payment creation", async () => {
    const body = {
      account_id: alice.account.id,
      amount: money("1.00"),
      to: { address: "0x3333333333333333333333333333333333333333" },
    };
    const a = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body,
      idempotencyKey: "pay-idem-0001",
    });
    const b = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body,
      idempotencyKey: "pay-idem-0001",
    });
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await h.db.query("SELECT id FROM payment WHERE idempotency_key = 'pay-idem-0001'");
    expect(rows).toHaveLength(1);
  });

  it("refills the agent's own spend key without a fee", async () => {
    // The spend key was registered with the co-signer when it was attached (onboarding).
    const res = await payAndSign(h, alice, {
      amount: money("10.00"),
      to: { address: alice.spendKey.address },
    });
    expect(res.body).toMatchObject({ kind: "refill", fee: money("0.00"), status: "submitted" });
    await h.indexer.sync();
    expect(
      (await call(h.app, "GET", `/v1/payments/${res.body.id}`, { token: alice.apiKey })).body.status,
    ).toBe("settled");
    expect((await balances(alice)).spend_float).toBe("10.00");
  });
});

describe("denials and failures", () => {
  it("denies over-limit payments without a hold", async () => {
    const before = await h.ledger.balance(pocket(alice.account.id, "reserved"));
    const res = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body: { account_id: alice.account.id, amount: money("1500.00"), to: { agent_id: bob.agent.id } },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("denied");
    expect(res.body.decision.outcome).toBe("deny");
    expect(res.body.decision.rule_hits.some((r: { rule: string }) => r.rule === "limits.per_tx")).toBe(true);
    expect(res.body.failure_reason).toContain("limits.per_tx");
    expect(res.body.signing_request).toBeNull();
    expect(await h.ledger.balance(pocket(alice.account.id, "reserved"))).toBe(before);
    const events = await call(h.app, "GET", "/v1/events?type=payment.denied", { token: alice.apiKey });
    expect(events.body.data.some((e: { data: { id: string } }) => e.data.id === res.body.id)).toBe(true);
  });

  it("denies sanctioned counterparties (screening)", async () => {
    const res = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body: {
        account_id: alice.account.id,
        amount: money("1.00"),
        to: { address: "0x000000000000000000000000000000000000bad1" },
      },
    });
    expect(res.body.status).toBe("denied");
    expect(res.body.decision.rule_hits[0].rule).toBe("screening.sanctioned");
  });

  it("fails closed when screening is down", async () => {
    const down = await createHarness({
      screening: { screen: async () => Promise.reject(new Error("vendor down")) },
    });
    try {
      const w = await onboard(down, { name: "screened", fund: usdc("10") });
      const res = await agentCall(down, w.session, "POST", "/v1/payments", {
        body: {
          account_id: w.account.id,
          amount: money("1.00"),
          to: { address: "0x4444444444444444444444444444444444444444" },
        },
      });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("screening_unavailable");
    } finally {
      await down.close();
    }
  });

  it("fails closed when the co-signer is down", async () => {
    h.cosigner.available = false;
    try {
      const res = await agentCall(h, alice.session, "POST", "/v1/payments", {
        body: { account_id: alice.account.id, amount: money("1.00"), to: { agent_id: bob.agent.id } },
      });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("cosigner_unavailable");
    } finally {
      h.cosigner.available = true;
    }
  });

  it("refuses payments the balance cannot cover", async () => {
    const poor = await onboard(h, { name: "poor", fund: usdc("5") });
    const res = await agentCall(h, poor.session, "POST", "/v1/payments", {
      body: { account_id: poor.account.id, amount: money("5.00"), to: { agent_id: bob.agent.id } },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("insufficient_funds");
    const { rows } = await h.db.query("SELECT id FROM payment WHERE account_id = $1", [poor.account.id]);
    expect(rows).toHaveLength(0);
  });

  it("fails a payment whose operation cannot be prepared (simulation reverts)", async () => {
    // Ledger says 50 but the chain holds nothing: the bundler's gas simulation reverts.
    const ghost = await onboard(h, { name: "ghost" });
    await h.ledger.post({
      idempotencyKey: `ghost-deposit:${ghost.account.id}`,
      lines: [
        { account: chainMirror(1337), amount: -usdc("50") },
        { account: pocket(ghost.account.id, "operating"), amount: usdc("50") },
      ],
      refType: "deposit",
    });
    const res = await agentCall(h, ghost.session, "POST", "/v1/payments", {
      body: { account_id: ghost.account.id, amount: money("10.00"), to: { agent_id: bob.agent.id } },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("failed");
    expect(res.body.failure_reason).toMatch(/revert/i);
    expect(await h.ledger.balance(pocket(ghost.account.id, "reserved"))).toBe(0n);
  });

  it("fails a co-signed payment whose nonce went stale (the agent creates it again)", async () => {
    const tight = await onboard(h, { name: "tight", fund: usdc("50") });
    const pending = await agentCall(h, tight.session, "POST", "/v1/payments", {
      body: { account_id: tight.account.id, amount: money("20.00"), to: { agent_id: bob.agent.id } },
    });
    expect(pending.body.status).toBe("requires_signature");
    // Another payment of the same account lands first and consumes the session nonce.
    const other = await payAndSign(h, tight, {
      amount: money("25.00"),
      to: { address: "0x5555555555555555555555555555555555555555" },
    });
    expect(other.body.status).toBe("submitted");
    const stale = await agentCall(h, tight.session, "POST", `/v1/payments/${pending.body.id}/signature`, {
      body: {
        session_id: tight.session.id,
        signature: await signHash(tight.session.key, pending.body.signing_request.user_op_hash),
      },
    });
    // The co-signer signs a payment id once, so the payment fails and its hold is released.
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("invalid_state");
    const after = await agentCall(h, tight.session, "GET", `/v1/payments/${pending.body.id}`);
    expect(after.body.status).toBe("failed");
    expect(h.cosigner.callsTo("reportSettlement")).toContainEqual(
      expect.objectContaining({ payment_id: pending.body.id, status: "failed" }),
    );
    expect(await h.ledger.balance(pocket(tight.account.id, "reserved"))).toBe(usdc("25.05"));
    const again = await payAndSign(h, tight, { amount: money("20.00"), to: { agent_id: bob.agent.id } });
    expect(again.body.status).toBe("submitted");
  });

  it("fails an operation that reverts on-chain after submission", async () => {
    const twin = await onboard(h, { name: "twin", fund: usdc("50") });
    const created = await agentCall(h, twin.session, "POST", "/v1/payments", {
      body: { account_id: twin.account.id, amount: money("30.00"), to: { agent_id: bob.agent.id } },
    });
    h.sim.automine = false;
    try {
      // A transfer out of the account lands in the same block, before the payment executes.
      h.sim.sendTransaction({
        from: twin.account.address,
        to: h.chain.contracts.usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [bob.account.address, usdc("40")],
        }),
      });
      const signature = await signHash(twin.session.key, created.body.signing_request.user_op_hash);
      const submitted = await agentCall(
        h,
        twin.session,
        "POST",
        `/v1/payments/${created.body.id}/signature`,
        {
          body: { session_id: twin.session.id, signature },
        },
      );
      expect(submitted.body.status).toBe("submitted");
      h.sim.mine();
    } finally {
      h.sim.automine = true;
    }
    await pollReceipts(h.deps);
    const after = await call(h.app, "GET", `/v1/payments/${created.body.id}`, { token: twin.apiKey });
    expect(after.body.status).toBe("failed");
    expect(after.body.failure_reason).toMatch(/revert/i);
    expect(after.body.tx_hash).toMatch(/^0x/);
    expect(await h.ledger.balance(pocket(twin.account.id, "reserved"))).toBe(0n);
    expect(h.cosigner.callsTo("reportSettlement")).toContainEqual({
      payment_id: created.body.id,
      status: "failed",
    });
  });

  it("expires unsigned payments and voids the hold", async () => {
    const created = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body: { account_id: alice.account.id, amount: money("3.00"), to: { agent_id: bob.agent.id } },
    });
    expect(created.body.status).toBe("requires_signature");
    const holdId = (
      await h.db.query<{ hold_id: string }>("SELECT hold_id FROM payment WHERE id = $1", [created.body.id])
    ).rows[0]?.hold_id as string;
    expect((await h.ledger.getHold(holdId)).status).toBe("pending");
    h.clock.advanceSeconds(601);
    await expirePending(h.deps);
    const after = await call(h.app, "GET", `/v1/payments/${created.body.id}`, { token: alice.apiKey });
    expect(after.body.status).toBe("expired");
    expect((await h.ledger.getHold(holdId)).status).toBe("voided");
    const late = await agentCall(h, alice.session, "POST", `/v1/payments/${created.body.id}/signature`, {
      body: {
        session_id: alice.session.id,
        signature: await signHash(alice.session.key, created.body.signing_request.user_op_hash),
      },
    });
    expect(late.status).toBe(409);
  });

  it("blocks writes by a frozen agent", async () => {
    const frozen = await onboard(h, { name: "icy", fund: usdc("10") });
    await call(h.app, "POST", `/v1/agents/${frozen.agent.id}/freeze`, {
      token: frozen.apiKey,
      body: { reason: "test" },
    });
    const res = await agentCall(h, frozen.session, "POST", "/v1/payments", {
      body: { account_id: frozen.account.id, amount: money("1.00"), to: { agent_id: bob.agent.id } },
    });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe("agent_frozen");
    const read = await agentCall(h, frozen.session, "GET", `/v1/accounts/${frozen.account.id}/balances`);
    expect(read.status).toBe(200);
  });
});

describe("approvals", () => {
  let carol: World;
  beforeAll(async () => {
    carol = await onboard(h, {
      name: "carol",
      fund: usdc("1000"),
      policy: {
        limits: { per_tx: "1000.00" },
        approvals: [
          { above: "50.00", approvers: 1 },
          { above: "200.00", approvers: 2 },
        ],
      },
    });
  });

  it("queues a payment for approval, then approves it", async () => {
    const created = await agentCall(h, carol.session, "POST", "/v1/payments", {
      body: { account_id: carol.account.id, amount: money("60.00"), to: { agent_id: bob.agent.id } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "requires_approval", signing_request: null });
    expect(await h.ledger.balance(pocket(carol.account.id, "reserved"))).toBe(usdc("60.12"));
    const list = await call(h.app, "GET", "/v1/approvals?status=pending", { token: carol.apiKey });
    const approval = list.body.data.find((a: { payment_id: string }) => a.payment_id === created.body.id);
    expect(approval).toMatchObject({ required_approvers: 1, status: "pending", amount: money("60.00") });

    const decided = await call(h.app, "POST", `/v1/approvals/${approval.id}/decide`, {
      token: carol.apiKey,
      body: { decision: "approve" },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("approved");
    const payment = await agentCall(h, carol.session, "GET", `/v1/payments/${created.body.id}`);
    expect(payment.body.status).toBe("requires_signature");
    const signature = await signHash(carol.session.key, payment.body.signing_request.user_op_hash);
    const submitted = await agentCall(h, carol.session, "POST", `/v1/payments/${created.body.id}/signature`, {
      body: { session_id: carol.session.id, signature },
    });
    expect(submitted.body.status).toBe("submitted");
    const cosign = h.cosigner.callsTo("cosign").at(-1) as {
      approval: { approval_id: string; approved_by: string[] };
    };
    expect(cosign.approval.approval_id).toBe(approval.id);
    expect(cosign.approval.approved_by).toHaveLength(1);
  });

  it("requires a quorum of distinct approvers", async () => {
    const created = await agentCall(h, carol.session, "POST", "/v1/payments", {
      body: { account_id: carol.account.id, amount: money("250.00"), to: { agent_id: bob.agent.id } },
    });
    const approval = (
      await call(h.app, "GET", `/v1/approvals/${created.body.approval_id}`, { token: carol.apiKey })
    ).body;
    expect(approval.required_approvers).toBe(2);
    const first = await call(h.app, "POST", `/v1/approvals/${approval.id}/decide`, {
      token: carol.apiKey,
      body: { decision: "approve" },
    });
    expect(first.body.status).toBe("pending");
    const again = await call(h.app, "POST", `/v1/approvals/${approval.id}/decide`, {
      token: carol.apiKey,
      body: { decision: "approve" },
    });
    expect(again.status).toBe(409);
    const member = await call(h.app, "POST", "/v1/members", {
      token: carol.apiKey,
      body: { email: "second@example.com", role: "approver" },
    });
    const approverKey = await keyForMember(carol.org.id, member.body.id, ["approvals:decide"]);
    const second = await call(h.app, "POST", `/v1/approvals/${approval.id}/decide`, {
      token: approverKey,
      body: { decision: "approve" },
    });
    expect(second.body.status).toBe("approved");
    expect(second.body.decisions).toHaveLength(2);
  });

  it("rejects deciders without the approver role or scope", async () => {
    const created = await agentCall(h, carol.session, "POST", "/v1/payments", {
      body: { account_id: carol.account.id, amount: money("70.00"), to: { agent_id: bob.agent.id } },
    });
    const viewer = await call(h.app, "POST", "/v1/members", {
      token: carol.apiKey,
      body: { email: "viewer@example.com", role: "viewer" },
    });
    const viewerKey = await keyForMember(carol.org.id, viewer.body.id, ["approvals:decide"]);
    const byViewer = await call(h.app, "POST", `/v1/approvals/${created.body.approval_id}/decide`, {
      token: viewerKey,
      body: { decision: "approve" },
    });
    expect(byViewer.status).toBe(403);
    const readOnly = await call(h.app, "POST", "/v1/api-keys", {
      token: carol.apiKey,
      body: { name: "ro", scopes: ["payments:read"] },
    });
    const byReader = await call(h.app, "POST", `/v1/approvals/${created.body.approval_id}/decide`, {
      token: readOnly.body.secret,
      body: { decision: "approve" },
    });
    expect(byReader.status).toBe(403);
    const byAgent = await agentCall(
      h,
      carol.session,
      "POST",
      `/v1/approvals/${created.body.approval_id}/decide`,
      { body: { decision: "approve" } },
    );
    expect(byAgent.status).toBe(403);
  });

  it("voids the hold when an approver denies", async () => {
    const before = await h.ledger.balance(pocket(carol.account.id, "reserved"));
    const created = await agentCall(h, carol.session, "POST", "/v1/payments", {
      body: { account_id: carol.account.id, amount: money("80.00"), to: { agent_id: bob.agent.id } },
    });
    const res = await call(h.app, "POST", `/v1/approvals/${created.body.approval_id}/decide`, {
      token: carol.apiKey,
      body: { decision: "deny" },
    });
    expect(res.body.status).toBe("denied");
    const payment = await call(h.app, "GET", `/v1/payments/${created.body.id}`, { token: carol.apiKey });
    expect(payment.body.status).toBe("denied");
    expect(await h.ledger.balance(pocket(carol.account.id, "reserved"))).toBe(before);
  });

  it("expires approvals after 15 minutes", async () => {
    const created = await agentCall(h, carol.session, "POST", "/v1/payments", {
      body: { account_id: carol.account.id, amount: money("90.00"), to: { agent_id: bob.agent.id } },
    });
    h.clock.advanceSeconds(15 * 60 + 1);
    const late = await call(h.app, "POST", `/v1/approvals/${created.body.approval_id}/decide`, {
      token: carol.apiKey,
      body: { decision: "approve" },
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("approval_expired");
    const payment = await call(h.app, "GET", `/v1/payments/${created.body.id}`, { token: carol.apiKey });
    expect(payment.body.status).toBe("expired");
  });
});

describe("owner-signed payments", () => {
  it("routes require_owner payments through an owner operation", async () => {
    const dave = await onboard(h, {
      name: "dave",
      fund: usdc("1000"),
      policy: { limits: { per_tx: "1000.00" }, require_owner_above: "300.00" },
    });
    const created = await agentCall(h, dave.session, "POST", "/v1/payments", {
      body: { account_id: dave.account.id, amount: money("400.00"), to: { agent_id: bob.agent.id } },
    });
    expect(created.body.status).toBe("requires_signature");
    expect(created.body.owner_operation_id).toMatch(/^oop_/);
    expect(created.body.signing_request).toMatchObject({ session_id: null });
    const agentTry = await agentCall(h, dave.session, "POST", `/v1/payments/${created.body.id}/signature`, {
      body: {
        session_id: dave.session.id,
        signature: await signHash(dave.session.key, created.body.signing_request.user_op_hash),
      },
    });
    expect(agentTry.status).toBe(409);
    const signed = await signOwnerOperation(h, dave, created.body.owner_operation_id);
    expect(signed.status).toBe(200);
    const payment = await call(h.app, "GET", `/v1/payments/${created.body.id}`, { token: dave.apiKey });
    expect(payment.body.status).toBe("submitted");
    expect(h.sim.balanceOf(bob.account.address) >= usdc("400")).toBe(true);
  });
});

describe("payment requests", () => {
  it("creates a pay link, and a payment against it marks it paid after settlement", async () => {
    const request = await agentCall(h, bob.session, "POST", "/v1/payment-requests", {
      body: { account_id: bob.account.id, amount: money("12.50"), memo: "invoice 7", reference: "inv-7" },
    });
    expect(request.status).toBe(201);
    expect(request.body.pay_link).toBe(`http://console.test/pay/${request.body.id}`);
    expect(request.body.pay_to).toBe(bob.account.address);
    const seen = await agentCall(h, alice.session, "GET", `/v1/payment-requests/${request.body.id}`);
    expect(seen.status).toBe(200);
    const wrong = await agentCall(h, alice.session, "POST", "/v1/payments", {
      body: {
        account_id: alice.account.id,
        amount: money("12.00"),
        to: { address: bob.account.address },
        payment_request_id: request.body.id,
      },
    });
    expect(wrong.status).toBe(400);
    const paid = await payAndSign(h, alice, {
      amount: money("12.50"),
      to: { address: bob.account.address },
      payment_request_id: request.body.id,
    });
    expect(paid.body.status).toBe("submitted");
    await h.indexer.sync();
    await processSettled(h.deps);
    const after = await agentCall(h, bob.session, "GET", `/v1/payment-requests/${request.body.id}`);
    expect(after.body).toMatchObject({ status: "paid", paid_by_payment_id: paid.body.id });
  });
});

describe("agent scoping", () => {
  it("keeps agents inside their own account", async () => {
    const read = await agentCall(h, bob.session, "GET", `/v1/accounts/${alice.account.id}/balances`);
    expect(read.status).toBe(404);
    const pay = await agentCall(h, bob.session, "POST", "/v1/payments", {
      body: { account_id: alice.account.id, amount: money("1.00"), to: { agent_id: bob.agent.id } },
    });
    expect(pay.status).toBe(404);
    const list = await agentCall(h, bob.session, "GET", "/v1/payments");
    expect(list.body.data.every((p: { account_id: string }) => p.account_id === bob.account.id)).toBe(true);
    const agent = await agentCall(h, bob.session, "GET", `/v1/agents/${alice.agent.id}`);
    expect(agent.status).toBe(404);
    const crossOrg = await call(h.app, "GET", `/v1/accounts/${alice.account.id}`, { token: bob.apiKey });
    expect(crossOrg.status).toBe(404);
  });

  it("lets only principals manage sessions", async () => {
    const res = await agentCall(h, alice.session, "DELETE", `/v1/sessions/${alice.session.id}`);
    expect(res.status).toBe(403);
  });

  it("funds accounts on-chain and in the ledger consistently", async () => {
    const w = await onboard(h, { name: "fresh" });
    await fund(h, w.account, usdc("7"));
    expect(h.sim.balanceOf(w.account.address)).toBe(usdc("7"));
    expect((await balances(w)).available).toBe("7.00");
  });
});
