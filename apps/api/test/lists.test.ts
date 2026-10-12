import { ownerPayloads, usdc } from "@agentbank/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentCall,
  call,
  createHarness,
  ownerAuth,
  signupOrg,
  type Harness,
  type Json,
} from "./support/harness";
import { createSession, onboard, payAndSign, signOwnerOperation, type World } from "./support/flows";

let h: Harness;
let payer: World;
let payee: World;
let other: World;
const money = (amount: string) => ({ amount, asset: "USDC" });
const inDays = (days: number) => new Date(h.clock.now().getTime() + days * 86_400_000).toISOString();

let contracts: string[];

beforeAll(async () => {
  h = await createHarness();
  contracts = [h.chain.contracts.escrow as string, h.chain.contracts.streams as string];
  payer = await onboard(h, {
    name: "lister",
    fund: usdc("1000"),
    policy: { limits: { per_tx: "500.00" }, approvals: [{ above: "300.00", approvers: 1 }] },
    scope: { allowed_contracts: contracts },
  });
  payee = await onboard(h, { name: "listee", scope: { allowed_contracts: contracts } });
  other = await onboard(h, { name: "outsider" });
});
afterAll(async () => h.close());

const ids = (res: Json) => (res.body.data as Array<{ id: string }>).map((r) => r.id);

describe("sessions and owner operations", () => {
  it("lists sessions by account, agent and status, with the revoke operation", async () => {
    const extra = await createSession(h, payer, payer.account.id);
    const pending = await call(
      h.app,
      "GET",
      `/v1/sessions?account_id=${payer.account.id}&status=pending_install`,
      {
        token: payer.apiKey,
      },
    );
    expect(ids(pending)).toEqual([extra.session.id]);
    const active = await call(h.app, "GET", `/v1/sessions?agent_id=${payer.agent.id}&status=active`, {
      token: payer.apiKey,
    });
    expect(ids(active)).toEqual([payer.session.id]);

    const revoked = await call(h.app, "DELETE", `/v1/sessions/${payer.session.id}`, { token: payer.apiKey });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      status: "revoked",
      revoke_operation_id: expect.stringMatching(/^oop_/),
    });
    const listed = await call(h.app, "GET", "/v1/sessions?status=revoked", { token: payer.apiKey });
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        id: payer.session.id,
        revoke_operation_id: revoked.body.revoke_operation_id,
      }),
    ]);
    // Other orgs see none of it.
    const outsider = await call(h.app, "GET", `/v1/sessions?account_id=${payer.account.id}`, {
      token: other.apiKey,
    });
    expect(outsider.body.data).toEqual([]);

    const ops = await call(h.app, "GET", `/v1/owner-operations?account_id=${payer.account.id}`, {
      token: payer.apiKey,
    });
    const purposes = (ops.body.data as Array<{ purpose: string; status: string }>).map((o) => [
      o.purpose,
      o.status,
    ]);
    expect(purposes).toContainEqual(["session.install", "succeeded"]);
    expect(purposes).toContainEqual(["session.revoke", "requires_signature"]);
    const unsigned = await call(h.app, "GET", "/v1/owner-operations?status=requires_signature", {
      token: payer.apiKey,
    });
    expect(ids(unsigned)).toContain(revoked.body.revoke_operation_id);
    // The revocation is signed by the owner: the session is removed on-chain too.
    const signed = await signOwnerOperation(h, payer, revoked.body.revoke_operation_id);
    expect(signed.body.status).toBe("succeeded");
    const session = await call(h.app, "GET", `/v1/sessions/${payer.session.id}`, { token: payer.apiKey });
    expect(session.body.onchain_tx).toMatch(/^0x/);

    // A fresh session for the rest of the file.
    const next = await createSession(h, payer, payer.account.id, { allowed_contracts: contracts });
    const install = await call(h.app, "POST", `/v1/sessions/${next.session.id}/install`, {
      token: payer.apiKey,
    });
    await signOwnerOperation(h, payer, install.body.install_operation_id);
    payer.session = { id: next.session.id, key: next.key };
  });

  it("lists mandates by agent and status", async () => {
    const iat = Math.floor(h.clock.now().getTime() / 1000);
    const mandate = {
      vct: "mandate.payment.open.1",
      agent_id: payer.agent.id,
      iat,
      exp: iat + 86_400,
      description: "Data purchases",
      constraints: [{ type: "payment.amount_range", currency: "USDC", max: 5_000_000 }],
    };
    const created = await call(h.app, "POST", "/v1/mandates", {
      token: payer.apiKey,
      body: {
        agent_id: payer.agent.id,
        mandate,
        owner_authorization: await ownerAuth(payer.owner, h.clock, "mandate.issue", payer.agent.id, mandate),
      },
    });
    expect(created.status).toBe(201);
    const active = await call(h.app, "GET", `/v1/mandates?agent_id=${payer.agent.id}&status=active`, {
      token: payer.apiKey,
    });
    expect(ids(active)).toEqual([created.body.id]);
    await call(h.app, "DELETE", `/v1/mandates/${created.body.id}`, { token: payer.apiKey });
    const revoked = await call(h.app, "GET", "/v1/mandates?status=revoked", { token: payer.apiKey });
    expect(ids(revoked)).toEqual([created.body.id]);
    expect(
      (await call(h.app, "GET", "/v1/mandates?status=active", { token: payer.apiKey })).body.data,
    ).toEqual([]);
  });
});

describe("payments, escrows and streams", () => {
  let escrowId: string;
  let streamId: string;

  it("links escrow and stream payments and filters payments by agent and kind", async () => {
    const escrow = await agentCall(h, payer.session, "POST", "/v1/escrows", {
      body: {
        account_id: payer.account.id,
        payee: { agent_id: payee.agent.id },
        amount: money("20.00"),
        expires_at: inDays(2),
      },
    });
    expect(escrow.status).toBe(201);
    escrowId = escrow.body.id;
    const stream = await agentCall(h, payer.session, "POST", "/v1/streams", {
      body: {
        account_id: payer.account.id,
        payee: { agent_id: payee.agent.id },
        kind: "recurring",
        amount_per_interval: money("5.00"),
        interval_seconds: 86_400,
        deposit: money("10.00"),
      },
    });
    expect(stream.status).toBe(201);
    streamId = stream.body.id;
    await payAndSign(h, payer, { amount: money("1.00"), to: { agent_id: payee.agent.id } });

    const escrows = await call(h.app, "GET", `/v1/payments?kind=escrow&agent_id=${payer.agent.id}`, {
      token: payer.apiKey,
    });
    expect(escrows.body.data).toEqual([
      expect.objectContaining({ kind: "escrow", escrow_id: escrowId, stream_id: null }),
    ]);
    const streams = await call(h.app, "GET", "/v1/payments?kind=stream", { token: payer.apiKey });
    expect(streams.body.data).toEqual([expect.objectContaining({ kind: "stream", stream_id: streamId })]);
    const transfers = await call(h.app, "GET", "/v1/payments?kind=transfer", { token: payer.apiKey });
    expect(transfers.body.data.length).toBeGreaterThanOrEqual(1);
    for (const p of transfers.body.data) expect(p.kind).toBe("transfer");
    const byAgent = await agentCall(h, payer.session, "GET", `/v1/payments?agent_id=${payee.agent.id}`);
    expect(byAgent.body.data).toEqual([]);
  });

  it("lists escrows and streams for the payer and the payee only", async () => {
    const all = await agentCall(h, payer.session, "GET", "/v1/escrows");
    expect(all.body.data).toEqual([expect.objectContaining({ id: escrowId, status: "requires_signature" })]);
    const mine = await agentCall(h, payer.session, "GET", "/v1/escrows?status=requires_signature");
    expect(ids(mine)).toEqual([escrowId]);
    const asPayee = await call(h.app, "GET", `/v1/escrows?account_id=${payee.account.id}`, {
      token: payee.apiKey,
    });
    expect(ids(asPayee)).toEqual([escrowId]);
    expect((await call(h.app, "GET", "/v1/escrows", { token: other.apiKey })).body.data).toEqual([]);
    const foreign = await call(h.app, "GET", `/v1/escrows?account_id=${payer.account.id}`, {
      token: other.apiKey,
    });
    expect(foreign.status).toBe(404);
    expect(ids(await call(h.app, "GET", "/v1/escrows?status=locked", { token: payer.apiKey }))).toEqual([]);

    const streams = await call(h.app, "GET", `/v1/streams?account_id=${payer.account.id}`, {
      token: payer.apiKey,
    });
    expect(ids(streams)).toEqual([streamId]);
    const payeeStreams = await agentCall(h, payee.session, "GET", "/v1/streams");
    expect(ids(payeeStreams)).toEqual([streamId]);
    expect((await agentCall(h, other.session, "GET", "/v1/streams")).body.data).toEqual([]);
  });

  it("filters ledger entries by payment", async () => {
    const payment = (await call(h.app, "GET", "/v1/payments?kind=escrow", { token: payer.apiKey })).body
      .data[0];
    const entries = await call(
      h.app,
      "GET",
      `/v1/accounts/${payer.account.id}/entries?payment_id=${payment.id}`,
      {
        token: payer.apiKey,
      },
    );
    expect(entries.status).toBe(200);
    expect(entries.body.data.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries.body.data) expect(entry.payment_id).toBe(payment.id);
  });
});

describe("approvals", () => {
  it("carries the policy decision that required the approval", async () => {
    const created = await agentCall(h, payer.session, "POST", "/v1/payments", {
      body: { account_id: payer.account.id, amount: money("400.00"), to: { agent_id: payee.agent.id } },
    });
    expect(created.body.status).toBe("requires_approval");
    const approval = await call(h.app, "GET", `/v1/approvals/${created.body.approval_id}`, {
      token: payer.apiKey,
    });
    expect(approval.body.decision).toMatchObject({ outcome: "require_approval" });
    expect(approval.body.decision.rule_hits.length).toBeGreaterThan(0);
    const events = await call(h.app, "GET", "/v1/events?type=approval.requested", { token: payer.apiKey });
    expect(events.body.data[0].data).toMatchObject({
      object: "approval",
      id: created.body.approval_id,
      decision: { outcome: "require_approval" },
    });
  });
});

describe("treasury rules and orgs", () => {
  it("lists auto top-up rules and reads the (absent) sweep rule", async () => {
    expect((await call(h.app, "GET", "/v1/auto-topup-rules", { token: payer.apiKey })).body.data).toEqual([]);
    const sweep = await call(h.app, "GET", `/v1/accounts/${payer.account.id}/sweep-rule`, {
      token: payer.apiKey,
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body).toBeNull();

    const treasury = await call(h.app, "POST", "/v1/orgs/me/treasury-accounts", {
      token: payer.apiKey,
      body: { chain: "simulated" },
    });
    const rule = { refill_to: money("50.00"), when_below: money("10.00"), max_per_day: money("100.00") };
    const put = await call(h.app, "PUT", `/v1/agents/${payer.agent.id}/auto-topup`, {
      token: payer.apiKey,
      body: {
        ...rule,
        owner_authorization: await ownerAuth(
          payer.owner,
          h.clock,
          "topup.set",
          payer.agent.id,
          ownerPayloads.topUpSet(payer.agent.id, rule).payload,
        ),
      },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      status: "pending_install",
      install_operation_id: expect.stringMatching(/^oop_/),
    });
    const rules = await call(h.app, "GET", "/v1/auto-topup-rules", { token: payer.apiKey });
    expect(rules.body.data).toEqual([
      expect.objectContaining({ agent_id: payer.agent.id, treasury_account_id: treasury.body.id }),
    ]);
    expect((await call(h.app, "GET", "/v1/auto-topup-rules", { token: other.apiKey })).body.data).toEqual([]);
  });

  it("shows why an org is frozen", async () => {
    const org = await signupOrg(h.app, "Frozen Co");
    const res = await call(h.app, "POST", "/v1/orgs/me/freeze", {
      token: org.apiKey,
      body: { reason: "incident 42" },
    });
    expect(res.body).toMatchObject({
      status: "frozen",
      frozen_reason: "incident 42",
      pending_unfreeze_at: null,
    });
  });
});

describe("sandbox faucet", () => {
  it("mints test USDC to the org's accounts or any address, and the reconciler posts it", async () => {
    const before = h.sim.balanceOf(payee.account.address);
    const res = await call(h.app, "POST", "/v1/sandbox/faucet", {
      token: payee.apiKey,
      body: { account_id: payee.account.id, amount: money("25.00") },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "faucet_transfer",
      address: payee.account.address,
      amount: money("25.00"),
      tx_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(h.sim.balanceOf(payee.account.address) - before).toBe(usdc("25"));
    await h.indexer.sync();
    const balances = await call(h.app, "GET", `/v1/accounts/${payee.account.id}/balances`, {
      token: payee.apiKey,
    });
    expect(Number(balances.body.available)).toBeGreaterThanOrEqual(25);

    const anyone = privateKeyToAccount(generatePrivateKey()).address;
    const toAddress = await call(h.app, "POST", "/v1/sandbox/faucet", {
      token: payee.apiKey,
      body: { address: anyone, amount: money("1.00") },
    });
    expect(toAddress.status).toBe(200);
    expect(h.sim.balanceOf(anyone)).toBe(usdc("1"));
  });

  it("refuses other orgs' accounts, large amounts and replays nothing twice", async () => {
    const foreign = await call(h.app, "POST", "/v1/sandbox/faucet", {
      token: other.apiKey,
      body: { account_id: payee.account.id, amount: money("1.00") },
    });
    expect(foreign.status).toBe(404);
    const huge = await call(h.app, "POST", "/v1/sandbox/faucet", {
      token: other.apiKey,
      body: { account_id: other.account.id, amount: money("10000.01") },
    });
    expect(huge.status).toBe(400);
    expect(huge.body.code).toBe("invalid_amount");
    const before = h.sim.balanceOf(other.account.address);
    const first = await call(h.app, "POST", "/v1/sandbox/faucet", {
      token: other.apiKey,
      idempotencyKey: "faucet-once",
      body: { account_id: other.account.id, amount: money("3.00") },
    });
    const replay = await call(h.app, "POST", "/v1/sandbox/faucet", {
      token: other.apiKey,
      idempotencyKey: "faucet-once",
      body: { account_id: other.account.id, amount: money("3.00") },
    });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.tx_hash).toBe(first.body.tx_hash);
    expect(h.sim.balanceOf(other.account.address) - before).toBe(usdc("3"));
  });

  it("is unavailable on Base Sepolia", async () => {
    const sepolia = await createHarness({
      cosigner: "fake",
      config: {
        AGENTBANK_CHAIN: "base-sepolia",
        CHAIN_RPC_URL: "http://127.0.0.1:9",
        REVENUE_ADDRESS: "0x000000000000000000000000000000000000fee1",
      },
    });
    try {
      const org = await signupOrg(sepolia.app, "Sepolia Co");
      const res = await call(sepolia.app, "POST", "/v1/sandbox/faucet", {
        token: org.apiKey,
        body: { address: "0x1111111111111111111111111111111111111111", amount: money("1.00") },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("feature_gated");
    } finally {
      await sepolia.close();
    }
  });
});

describe("x402 facilitator URL", () => {
  it("points sellers at the facilitator's /v1/x402 endpoint", async () => {
    const meta = await call(h.app, "GET", "/v1/meta");
    expect(meta.body.facilitator_url).toBe("http://localhost:8083/v1/x402");
    const configured = await createHarness({
      cosigner: "fake",
      config: { FACILITATOR_PUBLIC_URL: "https://facilitator.sandbox.example/" },
    });
    try {
      const res = await call(configured.app, "GET", "/v1/meta");
      expect(res.body.facilitator_url).toBe("https://facilitator.sandbox.example/v1/x402");
    } finally {
      await configured.close();
    }
  });
});
