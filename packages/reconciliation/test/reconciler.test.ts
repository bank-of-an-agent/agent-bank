import { transferCall } from "@agentbank/chain";
import { pocketRef, revenueRef, suspenseRef } from "@agentbank/ledger";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { SimBank, SIM_REVENUE, outboundFee, usd, type SimAccount } from "./support/sim-bank";

const EXTERNAL: Address = "0x000000000000000000000000000000000000dEaD";

async function expectReconciled(bank: SimBank): Promise<void> {
  const balances = await bank.compareBalances();
  expect(balances.filter((b) => b.onchain !== b.expected)).toEqual([]);
  expect((await bank.ledger.verifyInvariants()).violations).toEqual([]);
  expect((await bank.reconciler.verify()).violations).toEqual([]);
  expect(await bank.suspense()).toBe(0n);
}

async function eventsOf(bank: SimBank, type: string): Promise<Record<string, unknown>[]> {
  const { rows } = await bank.db.query<{ payload: { data: Record<string, unknown> } }>(
    "SELECT payload FROM event WHERE type = $1 ORDER BY created_at, id",
    [type],
  );
  return rows.map((r) => r.payload.data);
}

const operating = (a: SimAccount) => pocketRef(a.id, "operating", "USDC");

describe.each(["memory", "postgres"] as const)("movements (%s ledger)", (ledger) => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("deposits post on inclusion, large ones at finality, and replays are duplicates", async () => {
    bank = await SimBank.create({ ledger });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org, { spendKey: true });
    bank.faucet(a.address, usd(40));
    bank.faucet(a.spendKey!.address, usd(3));
    bank.faucet(a.address, usd(150)); // >= $100: waits for finality
    const [tick] = (await bank.sync()) as { deferred: number }[];
    expect(tick?.deferred).toBe(1);
    expect(await bank.ledger.balance(operating(a))).toBe(usd(40));
    expect(await bank.ledger.balance(pocketRef(a.id, "spend", "USDC"))).toBe(usd(3));
    bank.chain.mine(12);
    await bank.sync();
    expect(await bank.ledger.balance(operating(a))).toBe(usd(190));
    const deposits = await eventsOf(bank, "deposit.received");
    expect(deposits.map((d) => d.account_id)).toEqual([a.id, a.id, a.id]);
    expect(deposits.map((d) => (d.amount as { amount: string }).amount).sort()).toEqual([
      "150.00",
      "3.00",
      "40.00",
    ]);

    // The indexer resends what it already pushed (e.g. after a crash): nothing posts twice.
    const { rows } = await bank.db.query<{ n: bigint }>("SELECT count(*) AS n FROM chain_event");
    const entries = (await bank.ledger.verifyInvariants()).entries;
    const head = bank.chain.head.number;
    const logs = await bank.chain.gateway.getLogs({ fromBlock: 0n, toBlock: head, events: ["Transfer"] });
    const replay = logs.map((l) => ({
      id: `${bank.chain.chainId}:${l.blockHash}:${l.txHash}:${l.logIndex}`,
      chain_id: bank.chain.chainId,
      block_number: l.blockNumber.toString(),
      block_hash: l.blockHash,
      block_timestamp: bank.chain.block(l.blockNumber)!.timestamp,
      tx_hash: l.txHash,
      log_index: l.logIndex,
      finality: "finalized" as const,
      contract: l.address,
      event_name: l.eventName,
      args: Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)])),
      user_op_hash: null,
    }));
    const res = await bank.reconciler.ingest({
      chain_id: bank.chain.chainId,
      head_block: head.toString(),
      finalized_block: head.toString(),
      events: replay,
    });
    expect(new Set(res.results.map((r) => r.status))).toEqual(new Set(["duplicate"]));
    expect((await bank.ledger.verifyInvariants()).entries).toBe(entries);
    expect((await bank.db.query<{ n: bigint }>("SELECT count(*) AS n FROM chain_event")).rows[0]?.n).toBe(
      rows[0]?.n,
    );
    await expectReconciled(bank);
  });

  it("settles payments by user operation: to an account, out, x402 and refill", async () => {
    bank = await SimBank.create({ ledger });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org, { spendKey: true });
    const b = await bank.createAccount(org);
    await bank.installSession(a);
    bank.faucet(a.address, usd(90));
    bank.faucet(a.spendKey!.address, usd(10));
    await bank.sync();

    const toB = await bank.pay(a, b.address, usd(20), { toAccount: b, path: "session" });
    const out = await bank.pay(a, EXTERNAL, usd(30), { path: "owner" });
    const x402 = await bank.x402(a, EXTERNAL, 1_250_000n);
    const x402ToB = await bank.x402(a, b.address, 750_000n);
    const refill = await bank.refill(a, usd(5));
    await bank.sync();

    for (const p of [toB, out, x402, x402ToB, refill]) expect(await bank.paymentStatus(p.id)).toBe("settled");
    expect(await bank.ledger.balance(operating(b))).toBe(usd(20) + 750_000n);
    expect(await bank.ledger.balance(pocketRef(a.id, "spend", "USDC"))).toBe(usd(10) - 2_000_000n + usd(5));
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(outboundFee(usd(20)) + outboundFee(usd(30)));
    // The payee's credit is part of the settlement, not a second deposit.
    const deposits = await eventsOf(bank, "deposit.received");
    expect(
      deposits
        .filter((d) => d.account_id === b.id)
        .map((d) => d.payment_id)
        .sort(),
    ).toEqual([toB.id, x402ToB.id].sort());

    const { rows: payment } = await bank.db.query<{ status: string; tx_hash: string; settled_at: Date }>(
      "SELECT status, tx_hash, settled_at FROM payment WHERE id = $1",
      [toB.id],
    );
    expect(payment[0]?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payment[0]?.settled_at).toBeInstanceOf(Date);
    const { rows: fees } = await bank.db.query<{
      kind: string;
      source_ref: string;
      amount: bigint;
      ledger_entry_id: string;
    }>("SELECT kind, source_ref, amount, ledger_entry_id FROM fee_charge ORDER BY source_ref");
    expect(fees.map((f) => [f.kind, f.source_ref, f.amount])).toEqual(
      [
        ["outbound_payment", toB.id, outboundFee(usd(20))],
        ["outbound_payment", out.id, outboundFee(usd(30))],
      ].sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    );
    const entry = await bank.ledger.getEntry(fees[0]!.ledger_entry_id);
    expect(entry.kind).toBe("hold_post");
    expect((await eventsOf(bank, "payment.settled")).map((p) => p.id).sort()).toEqual(
      [toB.id, out.id, x402.id, x402ToB.id, refill.id].sort(),
    );
    await expectReconciled(bank);
  });
});

describe("unexplained outflows", () => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("wait for the 20-block window, then post to suspense, raise a mismatch and pause the agent", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(60));
    await bank.sync();
    // The owner moves funds without Agent Bank (exit tool): no payment explains it.
    bank.chain.sendTransaction({
      from: a.address,
      to: bank.chain.contracts.usdc,
      data: transferCall({ token: bank.chain.contracts.usdc, to: EXTERNAL, amount: usd(25) }).data,
    });
    const [first] = (await bank.sync()) as { deferred: number }[];
    expect(first?.deferred).toBe(1);
    expect(await bank.suspense()).toBe(0n);
    bank.chain.mine(10);
    await bank.sync();
    expect(await bank.suspense()).toBe(0n); // still inside the window
    bank.chain.mine(10);
    await bank.sync();
    expect(await bank.suspense()).toBe(usd(25));
    expect(await bank.ledger.balance(operating(a))).toBe(usd(35));
    const [mismatch] = await eventsOf(bank, "reconciliation.mismatch");
    expect(mismatch).toMatchObject({
      kind: "unmatched_outflow",
      account_id: a.id,
      agent_id: a.agentId,
      agent_paused: true,
    });
    expect(bank.freezes).toEqual([{ scope: "agent", id: a.agentId, reason: "reconciliation" }]);
    const { rows: agent } = await bank.db.query<{ status: string; frozen_reason: string }>(
      "SELECT status, frozen_reason FROM agent WHERE id = $1",
      [a.agentId],
    );
    expect(agent[0]).toEqual({ status: "frozen", frozen_reason: "reconciliation" });
    expect((await eventsOf(bank, "agent.frozen")).map((e) => e.id)).toEqual([a.agentId]);
    const { rows: outbox } = await bank.db.query<{ status: string }>("SELECT status FROM cosigner_outbox");
    expect(outbox.map((o) => o.status)).toEqual(["done"]);
    // The ledger still matches the chain: the outflow sits in suspense for review.
    const balances = await bank.compareBalances();
    expect(balances.filter((b) => b.onchain !== b.expected)).toEqual([]);
    expect(bank.reconciler.stats().suspense).toBe(1);
  });

  it("are fail-safe: a co-signer outage still records suspense and leaves the pause queued", async () => {
    bank = await SimBank.create({
      freeze: async () => {
        throw new Error("co-signer unavailable");
      },
    });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org, { spendKey: true });
    bank.faucet(a.spendKey!.address, usd(8));
    await bank.sync();
    // The spend key signs an EIP-3009 transfer no x402 payment asked for.
    await bank.authorizedTransfer(a.spendKey!, EXTERNAL, usd(2), `0x${"ab".repeat(32)}` as Hex);
    bank.chain.mine(21);
    await bank.sync();
    expect(await bank.suspense()).toBe(usd(2));
    expect(await bank.ledger.balance(pocketRef(a.id, "spend", "USDC"))).toBe(usd(6));
    const { rows } = await bank.db.query<{ status: string; attempts: number; last_error: string }>(
      "SELECT status, attempts, last_error FROM cosigner_outbox",
    );
    expect(rows).toEqual([{ status: "pending", attempts: 1, last_error: "co-signer unavailable" }]);
    expect(bank.reconciler.stats().freezeFailures).toBe(1);
    expect((await eventsOf(bank, "reconciliation.mismatch")).length).toBe(1);
  });

  it("never settle a payment without an allow decision, or whose transfers differ", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(80));
    await bank.sync();
    const unauthorized = await bank.pay(a, EXTERNAL, usd(10), { decision: "none" });
    const fee = outboundFee(usd(5));
    const tampered = await bank.pay(a, EXTERNAL, usd(5), {
      tamper: (calls) => [
        calls[0]!,
        transferCall({ token: bank.chain.contracts.usdc, to: SIM_REVENUE, amount: fee - 1n }),
      ],
    });
    bank.chain.mine(21);
    await bank.sync();
    expect(await bank.paymentStatus(unauthorized.id)).toBe("submitted");
    expect(await bank.paymentStatus(tampered.id)).toBe("submitted");
    expect(await bank.suspense()).toBe(usd(10) + outboundFee(usd(10)) + usd(5) + fee - 1n);
    expect(bank.freezes.length).toBe(1);
    const report = await bank.reconciler.verify();
    expect(report.violations).toEqual([]);
  });

  it("match on resend when the payment row lands after its transaction (window race)", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(30));
    await bank.sync();
    const p = await bank.pay(a, EXTERNAL, usd(10));
    // The indexer sees the operation before the API committed `submitted`.
    await bank.indexer.catchUp();
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(0n);
    await bank.flushRows();
    expect(await bank.paymentStatus(p.id)).toBe("submitted");
    bank.chain.mine(5);
    await bank.sync();
    expect(await bank.paymentStatus(p.id)).toBe("settled");
    await expectReconciled(bank);
  });
});

describe("fees", () => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("accrue the x402 receive fee when an outside buyer pays a registered seller", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const seller = await bank.createAccount(org, { x402Payee: true });
    const plain = await bank.createAccount(org);
    const buyer = bank.externalWallet();
    await bank.authorizedTransfer(buyer, seller.address, usd(10), `0x${"01".repeat(32)}` as Hex, {
      payeeAccountId: seller.id,
    });
    await bank.authorizedTransfer(buyer, plain.address, usd(10), `0x${"02".repeat(32)}` as Hex, {
      payeeAccountId: null,
    });
    // Settled by another facilitator, or not an x402 settlement at all: no fee.
    await bank.authorizedTransfer(buyer, seller.address, usd(4), `0x${"04".repeat(32)}` as Hex);
    bank.externalTransfer(buyer, seller.address, usd(1));
    await bank.sync();
    const fee = 50_000n; // 0.5% of $10
    expect(await bank.ledger.balance(operating(seller))).toBe(usd(15) - fee);
    expect(await bank.ledger.balance(pocketRef(seller.id, "fees", "USDC"))).toBe(fee);
    expect(await bank.ledger.balance(operating(plain))).toBe(usd(10));
    const { rows } = await bank.db.query<{
      kind: string;
      account_id: string;
      amount: bigint;
      source_ref: string;
      ledger_entry_id: string;
    }>("SELECT kind, account_id, amount, source_ref, ledger_entry_id FROM fee_charge");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "x402_receive", account_id: seller.id, amount: fee });
    expect(rows[0]!.source_ref).toMatch(/^1337:0x[0-9a-f]{64}:0x[0-9a-f]{64}:\d+$/);
    expect((await bank.ledger.getEntry(rows[0]!.ledger_entry_id)).refType).toBe("fee");
    await expectReconciled(bank);
  });

  it("post an accrued-fee sweep batched into an outgoing payment", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const seller = await bank.createAccount(org, { x402Payee: true });
    await bank.authorizedTransfer(
      bank.externalWallet(),
      seller.address,
      usd(100) - 1n,
      `0x${"03".repeat(32)}` as Hex,
      { payeeAccountId: seller.id },
    );
    bank.chain.mine(12);
    await bank.sync();
    const owed = await bank.ledger.balance(pocketRef(seller.id, "fees", "USDC"));
    expect(owed).toBe(500_000n);
    const p = await bank.pay(seller, EXTERNAL, usd(10), {
      tamper: (calls) => [
        ...calls,
        transferCall({ token: bank.chain.contracts.usdc, to: SIM_REVENUE, amount: owed }),
      ],
    });
    await bank.sync();
    expect(await bank.paymentStatus(p.id)).toBe("settled");
    expect(await bank.ledger.balance(pocketRef(seller.id, "fees", "USDC"))).toBe(0n);
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(outboundFee(usd(10)) + owed);
    await expectReconciled(bank);
  });
});

describe.each(["memory", "postgres"] as const)("reorgs (%s ledger)", (ledger) => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("rebind re-included transactions and reverse dropped ones", async () => {
    bank = await SimBank.create({ ledger });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    const b = await bank.createAccount(org);
    bank.faucet(a.address, usd(50));
    await bank.sync();
    const p = await bank.pay(a, b.address, usd(20), { toAccount: b });
    await bank.sync();
    const before = await bank.db.query<{ id: string }>("SELECT id FROM chain_tx WHERE status = 'processed'");

    bank.chain.injectReorg(2); // same transactions, new blocks
    await bank.sync();
    expect(bank.reconciler.stats().rebound).toBe(2);
    expect(bank.reconciler.stats().reversedEntries).toBe(0);
    const { rows: rebound } = await bank.db.query<{ superseded_by: string; reversal: string }>(
      "SELECT superseded_by, reversal FROM chain_tx WHERE id = ANY($1::text[])",
      [before.rows.slice(-2).map((r) => r.id)],
    );
    expect(rebound.every((r) => r.reversal === "rebound" && r.superseded_by)).toBe(true);
    expect(await bank.paymentStatus(p.id)).toBe("settled");
    await expectReconciled(bank);

    bank.chain.injectReorg(1, { drop: "all" }); // the payment disappears for good
    await bank.sync();
    expect(bank.reconciler.stats().reversedEntries).toBe(1);
    expect(await bank.paymentStatus(p.id)).toBe("submitted");
    expect((await bank.ledger.getHold(p.holdId)).status).toBe("pending");
    expect(await bank.ledger.balance(operating(b))).toBe(0n);
    const { rows: fees } = await bank.db.query("SELECT 1 FROM fee_charge WHERE source_ref = $1", [p.id]);
    expect(fees).toHaveLength(0);
    await bank.apiWorker(); // the API fails the dropped operation and voids the hold
    expect(await bank.paymentStatus(p.id)).toBe("failed");
    await expectReconciled(bank);
    expect(await bank.ledger.balance(operating(a))).toBe(usd(50));
  });

  it("wait to reverse a deposit whose funds are held, then complete once the hold is released", async () => {
    bank = await SimBank.create({ ledger });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    const depositTx = bank.faucet(a.address, usd(30));
    await bank.sync();
    const p = await bank.pay(a, EXTERNAL, usd(25)); // funded by the deposit
    await bank.sync();
    expect(await bank.paymentStatus(p.id)).toBe("settled");
    // Drop only the deposit: the payment is re-executed without funds and reverts.
    bank.chain.injectReorg(2, { drop: [depositTx] });
    await bank.sync();
    expect(await bank.paymentStatus(p.id)).toBe("submitted"); // its settlement was reversed
    const { rows: pending } = await bank.db.query<{ reversal: string }>(
      "SELECT reversal FROM chain_tx WHERE tx_hash = $1 AND status = 'reorged'",
      [depositTx.toLowerCase()],
    );
    expect(pending.map((r) => r.reversal)).toEqual(["pending"]);
    expect(bank.reconciler.stats().pendingReversals).toBe(1);
    await bank.apiWorker(); // receipt: reverted → payment failed, hold voided
    expect(await bank.paymentStatus(p.id)).toBe("failed");
    expect(await bank.reconciler.retryPendingReversals()).toBe(1);
    await expectReconciled(bank);
    expect(await bank.ledger.balance(operating(a))).toBe(0n);
  });

  it("rebind a deposit whose reversal was blocked once it is re-included", async () => {
    bank = await SimBank.create({ ledger });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(30));
    await bank.sync();
    await bank.seedPayment(a, { to: EXTERNAL, amount: usd(25) }); // holds the deposit's funds
    bank.chain.injectReorg(1, { drop: "all", requeue: true }); // back to the mempool
    await bank.sync();
    const pending = await bank.db.query<{ reversal: string }>("SELECT reversal FROM chain_tx");
    expect(pending.rows.map((r) => r.reversal)).toEqual(["pending"]);
    bank.chain.mine(); // re-included in a new block
    await bank.sync();
    const after = await bank.db.query<{ reversal: string; status: string }>(
      "SELECT reversal, status FROM chain_tx ORDER BY created_at, id",
    );
    expect(after.rows.map((r) => `${r.status}/${r.reversal}`).sort()).toEqual([
      "processed/none",
      "reorged/rebound",
    ]);
    expect(bank.reconciler.stats().rebound).toBe(1);
    expect(await bank.ledger.balance(pocketRef(a.id, "reserved", "USDC"))).toBe(usd(25));
    expect((await bank.reconciler.verify()).violations).toEqual([]);
  });

  it("reverse and re-post when the reorg is reported before the replacement blocks", async () => {
    bank = await SimBank.create({ ledger });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(40));
    await bank.sync();
    const { rows } = await bank.db.query<{ block_hash: string }>(
      "SELECT block_hash FROM chain_tx WHERE status = 'processed'",
    );
    // An indexer that reports orphaned blocks first (the other legal order).
    const reorg = await bank.reconciler.reorg({
      chain_id: bank.chain.chainId,
      orphaned_block_hashes: rows.map((r) => r.block_hash),
    });
    expect(reorg.reversed_entries).toBe(1);
    expect(await bank.ledger.balance(operating(a))).toBe(0n);
    bank.chain.injectReorg(1);
    await bank.sync(); // the replacement block: posted fresh (next generation)
    expect(await bank.ledger.balance(operating(a))).toBe(usd(40));
    await expectReconciled(bank);
  });
});

describe("expected balances, report and invariants", () => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("report persists the run, raises mismatches and pauses the agents", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const a = await bank.createAccount(org, { spendKey: true });
    bank.faucet(a.address, usd(12));
    bank.faucet(a.spendKey!.address, usd(2));
    await bank.sync();
    const { balances } = await bank.reconciler.expectedBalances({
      chain_id: bank.chain.chainId,
      addresses: [a.address, a.spendKey!.address, SIM_REVENUE, bank.chain.contracts.escrow!, EXTERNAL],
    });
    expect(balances.map((b) => b.expected)).toEqual(["12000000", "2000000", "0", "0", "0"]);

    const ok = await bank.reconciler.report({
      chain_id: bank.chain.chainId,
      block_number: "5",
      checked: 3,
      mismatches: [],
    });
    expect(ok).toMatchObject({ status: "ok", mismatches: 0, frozen_agents: [] });
    const bad = await bank.reconciler.report({
      chain_id: bank.chain.chainId,
      block_number: "6",
      checked: 3,
      mismatches: [{ address: a.address, onchain: "11000000", expected: "12000000" }],
    });
    expect(bad).toMatchObject({ status: "mismatch", mismatches: 1, frozen_agents: [a.agentId] });
    const { rows } = await bank.db.query<{ status: string; mismatch_count: number; frozen_agents: string[] }>(
      "SELECT status, mismatch_count, frozen_agents FROM reconciliation_run ORDER BY block_number",
    );
    expect(rows).toEqual([
      { status: "ok", mismatch_count: 0, frozen_agents: [] },
      { status: "mismatch", mismatch_count: 1, frozen_agents: [a.agentId] },
    ]);
    const [event] = await eventsOf(bank, "reconciliation.mismatch");
    expect(event).toMatchObject({ kind: "balance", account_id: a.id, address: a.address });
    expect(bank.freezes).toEqual([{ scope: "agent", id: a.agentId, reason: "reconciliation" }]);
  });

  it("verify catches a payment settled without authorization", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(12));
    await bank.sync();
    const p = await bank.pay(a, EXTERNAL, usd(1), { decision: "none" });
    await bank.flushRows();
    await bank.db.query("UPDATE payment SET status = 'settled' WHERE id = $1", [p.id]);
    const report = await bank.reconciler.verify();
    expect(report.violations.map((v) => [v.invariant, v.subject])).toEqual([
      ["settled_payment_authorized", p.id],
      ["settled_payment_posted", p.id],
    ]);
    expect(await bank.ledger.balance(suspenseRef("USDC"))).toBe(0n);
  });
});
