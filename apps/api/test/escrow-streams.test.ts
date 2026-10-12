import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pocket } from "../src/domain/ledger-refs";
import { pollReceipts } from "../src/domain/receipts";
import { settleStreams } from "../src/jobs/keepers";
import { agentCall, call, createHarness, type Harness } from "./support/harness";
import { onboard, signHash, type World } from "./support/flows";

let h: Harness;
let payer: World;
let payee: World;
const ARBITER = "0x00000000000000000000000000000000000a4b17";
const money = (amount: string) => ({ amount, asset: "USDC" });

beforeAll(async () => {
  h = await createHarness();
  const contracts = [h.chain.contracts.escrow, h.chain.contracts.streams, h.chain.contracts.vaults].filter(
    Boolean,
  );
  payer = await onboard(h, { name: "payer", fund: usdc("1000"), scope: { allowed_contracts: contracts } });
  payee = await onboard(h, { name: "payee", scope: { allowed_contracts: contracts } });
});
afterAll(async () => h.close());

const inDays = (days: number) => new Date(h.clock.now().getTime() + days * 86_400_000).toISOString();

async function lockedEscrow(amount: string, extra: Record<string, unknown> = {}) {
  const created = await agentCall(h, payer.session, "POST", "/v1/escrows", {
    body: {
      account_id: payer.account.id,
      payee: { agent_id: payee.agent.id },
      amount: money(amount),
      expires_at: inDays(2),
      arbiter: ARBITER,
      ...extra,
    },
  });
  expect(created.status).toBe(201);
  const signed = await agentCall(h, payer.session, "POST", `/v1/escrows/${created.body.id}/signature`, {
    body: {
      session_id: payer.session.id,
      signature: await signHash(payer.session.key, created.body.signing_request.user_op_hash),
    },
  });
  expect(signed.body.status).toBe("locking");
  await h.indexer.sync();
  return created.body.id as string;
}

describe("escrow", () => {
  it("locks funds (1% fee, $1 minimum) and releases them to the payee", async () => {
    const created = await agentCall(h, payer.session, "POST", "/v1/escrows", {
      body: {
        account_id: payer.account.id,
        payee: { agent_id: payee.agent.id },
        amount: money("50.00"),
        expires_at: inDays(2),
        arbiter: ARBITER,
        terms: "Deliver the report",
        memo: "task 1",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "requires_signature",
      pending_action: "lock",
      fee: money("1.00"),
      release: "payer",
      payee: { type: "agent", agent_id: payee.agent.id, address: payee.account.address },
    });
    expect(created.body.terms_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(created.body.signing_request.session_id).toBe(payer.session.id);
    expect(await h.ledger.balance(pocket(payer.account.id, "reserved"))).toBe(usdc("51"));

    const signed = await agentCall(h, payer.session, "POST", `/v1/escrows/${created.body.id}/signature`, {
      body: {
        session_id: payer.session.id,
        signature: await signHash(payer.session.key, created.body.signing_request.user_op_hash),
      },
    });
    expect(signed.body).toMatchObject({ status: "locking", pending_action: null, signing_request: null });
    await h.indexer.sync();
    const locked = await agentCall(h, payer.session, "GET", `/v1/escrows/${created.body.id}`);
    expect(locked.body.status).toBe("locked");
    expect(locked.body.onchain_id).toEqual(expect.any(String));
    expect(await h.ledger.balance(pocket(payer.account.id, "escrow"))).toBe(usdc("50"));

    const release = await agentCall(h, payer.session, "POST", `/v1/escrows/${created.body.id}/release`);
    expect(release.status).toBe(200);
    expect(release.body).toMatchObject({ pending_action: "release", status: "locked" });
    const submitted = await agentCall(h, payer.session, "POST", `/v1/escrows/${created.body.id}/signature`, {
      body: {
        session_id: payer.session.id,
        signature: await signHash(payer.session.key, release.body.signing_request.user_op_hash),
      },
    });
    expect(submitted.body).toMatchObject({ pending_action: null, signing_request: null });
    await pollReceipts(h.deps);
    expect(h.sim.balanceOf(payee.account.address)).toBe(usdc("50"));
    const row = (
      await h.db.query<{ pending_action: string | null; tx_hash: string | null }>(
        "SELECT pending_action, tx_hash FROM escrow WHERE id = $1",
        [created.body.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ pending_action: null });
    expect(row?.tx_hash).toMatch(/^0x/);
  });

  it("charges 1% above the minimum", async () => {
    const created = await agentCall(h, payer.session, "POST", "/v1/escrows", {
      body: {
        account_id: payer.account.id,
        payee: { agent_id: payee.agent.id },
        amount: money("250.00"),
        expires_at: inDays(1),
      },
    });
    expect(created.body.fee).toEqual(money("2.50"));
  });

  it("lets the payee refund at any time", async () => {
    const before = h.sim.balanceOf(payer.account.address);
    const first = await lockedEscrow("20.00");
    const refund = await agentCall(h, payee.session, "POST", `/v1/escrows/${first}/refund`);
    expect(refund.body.pending_action).toBe("refund");
    expect(refund.body.signing_request.session_id).toBe(payee.session.id);
    await agentCall(h, payee.session, "POST", `/v1/escrows/${first}/signature`, {
      body: {
        session_id: payee.session.id,
        signature: await signHash(payee.session.key, refund.body.signing_request.user_op_hash),
      },
    });
    await pollReceipts(h.deps);
    expect(h.sim.balanceOf(payer.account.address)).toBe(before - usdc("1")); // only the fee is gone
  });

  it("opens disputes before expiry", async () => {
    const id = await lockedEscrow("5.00");
    const dispute = await agentCall(h, payee.session, "POST", `/v1/escrows/${id}/dispute`, {
      body: { reason: "Not delivered" },
    });
    expect(dispute.status).toBe(200);
    expect(dispute.body.pending_action).toBe("dispute");
    const sent = await agentCall(h, payee.session, "POST", `/v1/escrows/${id}/signature`, {
      body: {
        session_id: payee.session.id,
        signature: await signHash(payee.session.key, dispute.body.signing_request.user_op_hash),
      },
    });
    expect(sent.status).toBe(200);
    await pollReceipts(h.deps);
    expect(h.sim.getEscrow(BigInt(dispute.body.onchain_id))?.status).toBeDefined();
  });

  it("hides escrows from unrelated callers and gates the feature", async () => {
    const id = await lockedEscrow("2.00");
    const stranger = await onboard(h, { name: "stranger" });
    expect((await agentCall(h, stranger.session, "GET", `/v1/escrows/${id}`)).status).toBe(404);
    expect((await call(h.app, "GET", `/v1/escrows/${id}`, { token: stranger.apiKey })).status).toBe(404);
    const gated = await createHarness({ config: { FEATURE_ESCROW: "false" } });
    try {
      const w = await onboard(gated, { name: "gated" });
      const res = await agentCall(gated, w.session, "POST", "/v1/escrows", {
        body: {
          account_id: w.account.id,
          payee: { address: "0x1111111111111111111111111111111111111111" },
          amount: money("1.00"),
          expires_at: inDays(1),
        },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("feature_gated");
    } finally {
      await gated.close();
    }
  });
});

describe("streams", () => {
  it("streams per second with a 0.5% fee, settles on schedule and cancels", async () => {
    const created = await agentCall(h, payer.session, "POST", "/v1/streams", {
      body: {
        account_id: payer.account.id,
        payee: { agent_id: payee.agent.id },
        amount_per_interval: money("0.01"),
        interval_seconds: 1,
        deposit: money("100.00"),
        settle_every_seconds: 3600,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "requires_signature",
      pending_action: "create",
      kind: "streaming",
    });
    const payment = (
      await h.db.query<{ payment_id: string; fee: bigint }>(
        "SELECT s.payment_id, p.fee FROM stream s JOIN payment p ON p.id = s.payment_id WHERE s.id = $1",
        [created.body.id],
      )
    ).rows[0];
    expect(payment?.fee).toBe(usdc("0.5"));
    const signed = await agentCall(h, payer.session, "POST", `/v1/streams/${created.body.id}/signature`, {
      body: {
        session_id: payer.session.id,
        signature: await signHash(payer.session.key, created.body.signing_request.user_op_hash),
      },
    });
    expect(signed.body).toMatchObject({ pending_action: null, signing_request: null });
    await h.indexer.sync();
    const active = await agentCall(h, payer.session, "GET", `/v1/streams/${created.body.id}`);
    expect(active.body.status).toBe("active");

    const payeeBefore = h.sim.balanceOf(payee.account.address);
    h.clock.advanceSeconds(3_600);
    expect(await settleStreams(h.deps)).toBe(1);
    // ~3600 s at $0.01/s since the creation block (the indexer's sync mined a few more blocks).
    const streamed = h.sim.balanceOf(payee.account.address) - payeeBefore;
    expect(streamed > usdc("35.5") && streamed <= usdc("36.1")).toBe(true);
    expect(await settleStreams(h.deps)).toBe(0); // not due again yet

    // Only the payer may cancel (PaymentStreams.cancel); the payee keeps what accrued.
    const byPayee = await agentCall(h, payee.session, "POST", `/v1/streams/${created.body.id}/cancel`);
    expect(byPayee.status).toBe(403);
    const cancel = await agentCall(h, payer.session, "POST", `/v1/streams/${created.body.id}/cancel`);
    expect(cancel.body).toMatchObject({ pending_action: "cancel", status: "active" });
    const canceled = await agentCall(h, payer.session, "POST", `/v1/streams/${created.body.id}/signature`, {
      body: {
        session_id: payer.session.id,
        signature: await signHash(payer.session.key, cancel.body.signing_request.user_op_hash),
      },
    });
    expect(canceled.status).toBe(200);
    expect(h.cosigner.callsTo("cosign")).toContainEqual(
      expect.objectContaining({ action: "stream.cancel", onchain_id: active.body.onchain_id }),
    );
    await pollReceipts(h.deps);
    expect(h.sim.getStream(BigInt(active.body.onchain_id))?.canceled).toBe(true);
    // The reconciler moves the stream to canceled from the StreamCanceled event.
    await h.indexer.sync();
    const final = await agentCall(h, payer.session, "GET", `/v1/streams/${created.body.id}`);
    expect(final.body).toMatchObject({ status: "canceled", pending_action: null });
  });

  it("cancels a stream before creation and voids its hold", async () => {
    const reserved = await h.ledger.balance(pocket(payer.account.id, "reserved"));
    const created = await agentCall(h, payer.session, "POST", "/v1/streams", {
      body: {
        account_id: payer.account.id,
        payee: { address: "0x1111111111111111111111111111111111111111" },
        kind: "recurring",
        amount_per_interval: money("10.00"),
        interval_seconds: 86_400,
        deposit: money("30.00"),
      },
    });
    const canceled = await call(h.app, "POST", `/v1/streams/${created.body.id}/cancel`, {
      token: payer.apiKey,
    });
    expect(canceled.body.status).toBe("canceled");
    expect(await h.ledger.balance(pocket(payer.account.id, "reserved"))).toBe(reserved);
  });

  it("gates streams by feature flag", async () => {
    const gated = await createHarness({ config: { FEATURE_STREAMS: "false" } });
    try {
      const w = await onboard(gated, { name: "gated" });
      const res = await agentCall(gated, w.session, "POST", "/v1/streams", {
        body: {
          account_id: w.account.id,
          payee: { address: "0x1111111111111111111111111111111111111111" },
          amount_per_interval: money("1.00"),
          interval_seconds: 60,
          deposit: money("10.00"),
        },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("feature_gated");
    } finally {
      await gated.close();
    }
  });
});

describe("escrow expiry (moves the clock: keep last)", () => {
  it("lets anyone refund after expiry through a keeper", async () => {
    const before = h.sim.balanceOf(payer.account.address);
    const id = await lockedEscrow("10.00");
    const early = await agentCall(h, payer.session, "POST", `/v1/escrows/${id}/refund`);
    expect(early.status).toBe(409);
    h.clock.advanceSeconds(2 * 86_400 + 60);
    const late = await call(h.app, "POST", `/v1/escrows/${id}/refund`, { token: payer.apiKey });
    expect(late.status).toBe(200);
    expect(late.body.pending_action).toBeNull();
    expect(h.sim.balanceOf(payer.account.address)).toBe(before - usdc("1"));
  });
});
