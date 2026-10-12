import { newId } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import {
  InMemoryLedger,
  pocketRef,
  PostgresLedger,
  revenueRef,
  suspenseRef,
  type Ledger,
} from "@agentbank/ledger";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { createReconciler } from "../src";
import { hashOf, request, transfer, txEvents, userOperation } from "./support/events";
import { SimBank, SIM_REVENUE, usd, type SimAccount } from "./support/sim-bank";

/** Rules exercised with hand-made evidence (what an indexer would push), against a real database. */

const EXTERNAL: Address = "0x000000000000000000000000000000000000dEaD";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

describe("reconciliation rules (hand-made evidence)", () => {
  let bank: SimBank;
  let chainId: number;
  let usdc: string;
  afterEach(async () => bank?.close());

  async function setup(): Promise<{ a: SimAccount; b: SimAccount }> {
    bank = await SimBank.create();
    chainId = bank.chain.chainId;
    usdc = bank.chain.contracts.usdc;
    const org = await bank.createOrg();
    const a = await bank.createAccount(org, { spendKey: true });
    const b = await bank.createAccount(org);
    // Fund `a` from outside: block 1.
    const funding = txEvents({
      chainId,
      blockNumber: 1n,
      txHash: hashOf("fund"),
      logs: [transfer(usdc, EXTERNAL, a.address, usd(90))],
    });
    const res = await bank.reconciler.ingest(request(chainId, funding, 1n, 0n));
    expect(res.results.map((r) => r.status)).toEqual(["deposit"]);
    return { a, b };
  }

  const operating = (x: SimAccount) => pocketRef(x.id, "operating", "USDC");

  it("matches each payment of a multi-operation bundle to its own user operation", async () => {
    const { a, b } = await setup();
    const opA = hashOf("op-a");
    const opB = hashOf("op-b");
    await bank.reconciler.ingest(
      request(
        chainId,
        txEvents({
          chainId,
          blockNumber: 2n,
          txHash: hashOf("fund-b"),
          logs: [transfer(usdc, EXTERNAL, b.address, usd(30))],
        }),
        2n,
        0n,
      ),
    );
    const pa = await bank.seedPayment(a, { to: EXTERNAL, amount: usd(10), fee: 20_000n, userOpHash: opA });
    const pb = await bank.seedPayment(b, { to: a.address, amount: usd(5), fee: 10_000n, userOpHash: opB });
    const bundle = txEvents({
      chainId,
      blockNumber: 3n,
      txHash: hashOf("bundle"),
      logs: [
        transfer(usdc, a.address, EXTERNAL, usd(10), opA),
        transfer(usdc, a.address, SIM_REVENUE, 20_000n, opA),
        userOperation(ENTRY_POINT, opA, a.address),
        transfer(usdc, b.address, a.address, usd(5), opB),
        transfer(usdc, b.address, SIM_REVENUE, 10_000n, opB),
        userOperation(ENTRY_POINT, opB, b.address),
      ],
    });
    const res = await bank.reconciler.ingest(request(chainId, bundle, 3n, 0n));
    expect(res.results.map((r) => r.status)).toEqual([
      "matched",
      "matched",
      "matched",
      "matched",
      "matched",
      "matched",
    ]);
    expect(res.results.map((r) => r.ref)).toEqual([pa.id, pa.id, pa.id, pb.id, pb.id, pb.id]);
    expect(await bank.paymentStatus(pa.id)).toBe("settled");
    expect(await bank.paymentStatus(pb.id)).toBe("settled");
    expect(await bank.ledger.balance(operating(a))).toBe(usd(90) - usd(10) - 20_000n + usd(5));
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(30_000n);
    // Each event matches at most one entry: the payee transfers are the evidence of the hold posts.
    const { rows } = await bank.db.query<{ matched_entry_id: string | null }>(
      "SELECT matched_entry_id FROM chain_event WHERE tx_hash = $1 ORDER BY log_index",
      [hashOf("bundle")],
    );
    expect(rows.map((r) => r.matched_entry_id !== null)).toEqual([true, false, false, true, false, false]);
    expect((await bank.reconciler.verify()).violations).toEqual([]);
  });

  it("matches a payment by transaction hash when there is no user operation", async () => {
    const { a } = await setup();
    const txHash = hashOf("exit-tool");
    const p = await bank.seedPayment(a, { to: EXTERNAL, amount: usd(7), txHash });
    const events = txEvents({
      chainId,
      blockNumber: 2n,
      txHash,
      logs: [transfer(usdc, a.address, EXTERNAL, usd(7))],
    });
    const res = await bank.reconciler.ingest(request(chainId, events, 2n, 0n));
    expect(res.results[0]).toMatchObject({ status: "matched", ref: p.id });
    expect(await bank.paymentStatus(p.id)).toBe("settled");
  });

  it("settles payments the owner signed (owner operation) or a human approved, and nothing else", async () => {
    const { a } = await setup();
    const now = bank.now();
    // require_owner: the owner signs the operation itself; the payment points at the owner operation.
    const ownerOp = hashOf("owner-op");
    const viaOwner = await bank.seedPayment(a, { to: EXTERNAL, amount: usd(3), decision: "none" });
    const opId = newId("ownerOperation", now.getTime());
    await bank.db.query(
      `INSERT INTO owner_operation (id, account_id, purpose, subject_id, status, chain_id, user_op, user_op_hash, expires_at)
       VALUES ($1, $2, 'payment', $3, 'submitted', $4, '{}', $5, $6)`,
      [opId, a.id, viaOwner.id, chainId, ownerOp, new Date(now.getTime() + 900_000)],
    );
    await bank.db.query("UPDATE payment SET owner_operation_id = $2 WHERE id = $1", [viaOwner.id, opId]);
    // require_approval: a human approved it.
    const approvedOp = hashOf("approved-op");
    const viaApproval = await bank.seedPayment(a, {
      to: EXTERNAL,
      amount: usd(4),
      decision: "none",
      userOpHash: approvedOp,
    });
    await bank.db.query(
      `INSERT INTO approval (id, payment_id, org_id, agent_id, required_approvers, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 'approved', $5)`,
      [
        newId("approval", now.getTime()),
        viaApproval.id,
        a.orgId,
        a.agentId,
        new Date(now.getTime() + 900_000),
      ],
    );
    // Neither: a pending approval does not authorize anything.
    const pendingOp = hashOf("pending-op");
    const pending = await bank.seedPayment(a, {
      to: EXTERNAL,
      amount: usd(5),
      decision: "none",
      userOpHash: pendingOp,
    });
    await bank.db.query(
      `INSERT INTO approval (id, payment_id, org_id, agent_id, required_approvers, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 'pending', $5)`,
      [newId("approval", now.getTime()), pending.id, a.orgId, a.agentId, new Date(now.getTime() + 900_000)],
    );
    const op = (hash: Hex, amount: bigint, block: bigint) =>
      txEvents({
        chainId,
        blockNumber: block,
        txHash: hashOf(`tx:${hash}`),
        userOpHash: hash,
        logs: [transfer(usdc, a.address, EXTERNAL, amount), userOperation(ENTRY_POINT, hash, a.address)],
      });
    const res = await bank.reconciler.ingest(
      request(
        chainId,
        [...op(ownerOp, usd(3), 2n), ...op(approvedOp, usd(4), 3n), ...op(pendingOp, usd(5), 4n)],
        4n,
        0n,
      ),
    );
    expect(res.results.map((r) => r.status)).toEqual([
      "matched",
      "matched",
      "matched",
      "matched",
      "deferred",
      "deferred",
    ]);
    expect(await bank.paymentStatus(viaOwner.id)).toBe("settled");
    expect(await bank.paymentStatus(viaApproval.id)).toBe("settled");
    expect(await bank.paymentStatus(pending.id)).toBe("submitted");
    expect((await bank.reconciler.verify()).violations).toEqual([]);
  });

  it("does not match an x402 payment that already expired: the outflow goes to suspense", async () => {
    const { a } = await setup();
    await bank.reconciler.ingest(
      request(
        chainId,
        txEvents({
          chainId,
          blockNumber: 2n,
          txHash: hashOf("float"),
          logs: [transfer(usdc, EXTERNAL, a.spendKey!.address, usd(4))],
        }),
        2n,
        0n,
      ),
    );
    const nonce = hashOf("nonce-1");
    const p = await bank.seedPayment(a, {
      to: EXTERNAL,
      amount: usd(1),
      kind: "x402",
      status: "requires_signature",
      x402Nonce: nonce,
    });
    await bank.failPayment(p, "expired"); // the API gave up on it
    const settle = txEvents({
      chainId,
      blockNumber: 3n,
      txHash: hashOf("relay"),
      logs: [
        { contract: usdc, name: "AuthorizationUsed", args: { authorizer: a.spendKey!.address, nonce } },
        transfer(usdc, a.spendKey!.address, EXTERNAL, usd(1)),
      ],
    });
    expect(
      (await bank.reconciler.ingest(request(chainId, settle, 3n, 0n))).results.map((r) => r.status),
    ).toEqual(["deferred", "deferred"]);
    const res = await bank.reconciler.ingest(request(chainId, settle, 23n, 0n));
    expect(res.results.map((r) => r.status)).toEqual(["ignored", "suspense"]);
    expect(await bank.ledger.balance(suspenseRef("USDC"))).toBe(usd(1));
    expect(bank.freezes.map((f) => f.id)).toEqual([a.agentId]);
  });

  it("pauses early but posts a large unexplained outflow only once final", async () => {
    const { a } = await setup();
    await bank.reconciler.ingest(
      request(
        chainId,
        txEvents({
          chainId,
          blockNumber: 2n,
          txHash: hashOf("big-fund"),
          logs: [transfer(usdc, EXTERNAL, a.address, usd(500))],
        }),
        2n,
        2n,
      ),
    );
    const out = txEvents({
      chainId,
      blockNumber: 3n,
      txHash: hashOf("drain"),
      logs: [transfer(usdc, a.address, EXTERNAL, usd(300))],
    });
    expect((await bank.reconciler.ingest(request(chainId, out, 10n, 2n))).results[0]?.status).toBe(
      "deferred",
    ); // window
    expect(bank.freezes).toHaveLength(0);
    expect((await bank.reconciler.ingest(request(chainId, out, 30n, 2n))).results[0]?.status).toBe(
      "deferred",
    ); // finality
    expect(bank.freezes).toHaveLength(1); // paused already
    expect(await bank.ledger.balance(suspenseRef("USDC"))).toBe(0n);
    const final = await bank.reconciler.ingest(request(chainId, out, 31n, 3n));
    expect(final.results[0]?.status).toBe("suspense");
    expect(await bank.ledger.balance(suspenseRef("USDC"))).toBe(usd(300));
    expect(bank.freezes).toHaveLength(1); // not twice
    const { rows } = await bank.db.query<{ n: bigint }>(
      "SELECT count(*) AS n FROM event WHERE type = 'reconciliation.mismatch'",
    );
    expect(rows[0]?.n).toBe(1n);
  });

  it("keeps a contract event of a not-yet-locked escrow waiting instead of reading it as a deposit", async () => {
    const { a, b } = await setup();
    const escrow = bank.chain.contracts.escrow as Address;
    const escrowId = newId("escrow", bank.now().getTime());
    await bank.db.query(
      `INSERT INTO escrow (id, payer_account_id, payee_address, amount, fee, status, release_mode, contract_address, onchain_id,
                           expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, 'locking', 'payer', $5, '7', $6, $6, $6)`,
      [escrowId, a.id, b.address, usd(5), escrow, bank.now()],
    );
    const released = txEvents({
      chainId,
      blockNumber: 2n,
      txHash: hashOf("release"),
      logs: [
        {
          contract: escrow,
          name: "Released",
          args: {
            id: "7",
            payee: b.address,
            caller: a.address,
            token: usdc,
            amount: usd(5).toString(),
            reason: "0",
          },
        },
        transfer(usdc, escrow, b.address, usd(5)),
      ],
    });
    const res = await bank.reconciler.ingest(request(chainId, released, 2n, 0n));
    expect(res.results.map((r) => r.status)).toEqual(["deferred", "deferred"]);
    expect(await bank.ledger.balance(operating(b))).toBe(0n);
  });

  it("restores a block that becomes canonical again while its reversal is blocked", async () => {
    const { a } = await setup();
    // The only funds of `a` are held by a payment, so reversing the deposit would overdraw.
    const p = await bank.seedPayment(a, { to: EXTERNAL, amount: usd(80) });
    const { rows } = await bank.db.query<{ block_hash: string }>("SELECT block_hash FROM chain_tx");
    const reorg = await bank.reconciler.reorg({
      chain_id: chainId,
      orphaned_block_hashes: rows.map((r) => r.block_hash),
    });
    expect(reorg.reversed_entries).toBe(0);
    const { rows: pending } = await bank.db.query<{ reversal: string }>("SELECT reversal FROM chain_tx");
    expect(pending.map((r) => r.reversal)).toEqual(["pending"]);
    // The same block comes back.
    const funding = txEvents({
      chainId,
      blockNumber: 1n,
      txHash: hashOf("fund"),
      logs: [transfer(usdc, EXTERNAL, a.address, usd(90))],
    });
    const res = await bank.reconciler.ingest(request(chainId, funding, 2n, 0n));
    expect(res.results.map((r) => r.status)).toEqual(["deposit"]);
    const { rows: restored } = await bank.db.query<{ status: string; reversal: string }>(
      "SELECT status, reversal FROM chain_tx",
    );
    expect(restored).toEqual([{ status: "processed", reversal: "none" }]);
    expect(await bank.ledger.balance(pocketRef(a.id, "reserved", "USDC"))).toBe(usd(80));
    expect((await bank.ledger.getHold(p.holdId)).status).toBe("pending");
    expect((await bank.reconciler.verify()).violations).toEqual([]);
  });

  it("puts a treasury's unexplained outflow in suspense and raises a mismatch without pausing an agent", async () => {
    await setup();
    const org = await bank.createOrg();
    const treasury = await bank.createAccount(org, { role: "treasury" });
    const fund = txEvents({
      chainId,
      blockNumber: 2n,
      txHash: hashOf("t-fund"),
      logs: [transfer(usdc, EXTERNAL, treasury.address, usd(9))],
    });
    await bank.reconciler.ingest(request(chainId, fund, 2n, 0n));
    const out = txEvents({
      chainId,
      blockNumber: 3n,
      txHash: hashOf("t-out"),
      logs: [transfer(usdc, treasury.address, EXTERNAL, usd(4))],
    });
    expect((await bank.reconciler.ingest(request(chainId, out, 30n, 0n))).results[0]?.status).toBe(
      "suspense",
    );
    expect(await bank.ledger.balance(suspenseRef("USDC"))).toBe(usd(4));
    expect(bank.freezes).toHaveLength(0);
    const { rows } = await bank.db.query<{ payload: { data: Record<string, unknown> } }>(
      "SELECT payload FROM event WHERE type = 'reconciliation.mismatch'",
    );
    expect(rows[0]?.payload.data).toMatchObject({
      account_id: treasury.id,
      agent_id: null,
      agent_paused: false,
    });
  });

  it("records revenue-address deposits and puts unexplained revenue outflows in suspense", async () => {
    await setup();
    const inflow = txEvents({
      chainId,
      blockNumber: 2n,
      txHash: hashOf("tip"),
      logs: [transfer(usdc, EXTERNAL, SIM_REVENUE, usd(2))],
    });
    expect((await bank.reconciler.ingest(request(chainId, inflow, 2n, 0n))).results[0]?.status).toBe(
      "deposit",
    );
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(usd(2));
    const outflow = txEvents({
      chainId,
      blockNumber: 3n,
      txHash: hashOf("sweep-out"),
      logs: [transfer(usdc, SIM_REVENUE, EXTERNAL, usd(1))],
    });
    expect((await bank.reconciler.ingest(request(chainId, outflow, 30n, 0n))).results[0]?.status).toBe(
      "suspense",
    );
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(usd(1));
    expect(bank.freezes).toHaveLength(0); // no agent to pause
  });

  it("isolates a transaction that cannot be reconciled: deferred with the error, the rest of the batch posts", async () => {
    const { a, b } = await setup();
    // A ledger that fails (unexpectedly) for anything credited to `b`.
    const inner = new InMemoryLedger({ clock: bank.clock });
    const ledger = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "post") {
          return async (input: Parameters<Ledger["post"]>[0]) => {
            if (input.lines.some((l) => l.account.ownerRef === b.id)) throw new Error("disk on fire");
            return target.post(input);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await inner.openPockets(a.id, "USDC", chainId);
    await inner.openPockets(b.id, "USDC", chainId);
    const errors: string[] = [];
    const reconciler = createReconciler({
      db: bank.db,
      ledger,
      cosigner: { freeze: async () => undefined },
      clock: bank.clock,
      config: { chainId, usdc, revenueAddress: SIM_REVENUE, contracts: {} },
      logger: { warn: () => undefined, error: (o) => errors.push(String(o.err ?? "")) },
    });
    const events = [
      ...txEvents({
        chainId,
        blockNumber: 5n,
        txHash: hashOf("ok-1"),
        logs: [transfer(usdc, EXTERNAL, a.address, 1_000n)],
      }),
      ...txEvents({
        chainId,
        blockNumber: 5n,
        txHash: hashOf("poison"),
        firstLogIndex: 1,
        logs: [transfer(usdc, EXTERNAL, b.address, 2_000n)],
      }),
      ...txEvents({
        chainId,
        blockNumber: 5n,
        txHash: hashOf("ok-2"),
        firstLogIndex: 2,
        logs: [transfer(usdc, EXTERNAL, a.address, 3_000n)],
      }),
    ];
    const res = await reconciler.ingest(request(chainId, events, 5n, 0n));
    expect(res.results.map((r) => r.status)).toEqual(["deposit", "deferred", "deposit"]);
    expect(await inner.balance(pocketRef(a.id, "operating", "USDC"))).toBe(4_000n);
    expect(errors.some((e) => e.includes("disk on fire"))).toBe(true);
    const { rows } = await bank.db.query<{
      status: string;
      deferred_reason: string;
      detail: { error?: string };
    }>("SELECT status, deferred_reason, detail FROM chain_tx WHERE tx_hash = $1", [hashOf("poison")]);
    expect(rows[0]).toMatchObject({
      status: "deferred",
      deferred_reason: "error",
      detail: { error: "disk on fire" },
    });
    expect(reconciler.stats().errors).toBe(1);
  });

  it("counts a batch once when its serializable transaction is retried", async () => {
    bank = await SimBank.create({ ledger: "postgres" });
    chainId = bank.chain.chainId;
    usdc = bank.chain.contracts.usdc;
    const a = await bank.createAccount(await bank.createOrg());
    const inner = bank.db;
    let attempts = 0;
    // What the PostgreSQL client does on SQLSTATE 40001: the attempt rolls back and runs again.
    const retryOnce = async <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> => {
      attempts++;
      if (attempts === 1) {
        await inner
          .transaction(async (tx) => {
            await fn(tx);
            throw new Error("could not serialize access due to read/write dependencies");
          })
          .catch(() => undefined);
        attempts++;
      }
      return inner.transaction(fn);
    };
    const db = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "transaction") return retryOnce;
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const reconciler = createReconciler({
      db,
      ledger: (tx) => new PostgresLedger(tx, { clock: bank.clock }),
      cosigner: { freeze: async () => undefined },
      clock: bank.clock,
      config: { chainId, usdc, revenueAddress: SIM_REVENUE, contracts: {} },
      logger: { warn: () => undefined, error: () => undefined },
    });
    const events = txEvents({
      chainId,
      blockNumber: 3n,
      logs: [transfer(usdc, EXTERNAL, a.address, usd(5)), transfer(usdc, EXTERNAL, a.address, usd(2))],
    });
    const res = await reconciler.ingest(request(chainId, events, 3n, 0n));
    expect(res.results.map((r) => r.status)).toEqual(["deposit", "deposit"]);
    expect(attempts).toBe(2);
    expect(reconciler.stats()).toMatchObject({ ingestedEvents: 2, deposits: 2, errors: 0 });
    expect(await bank.ledger.balance(pocketRef(a.id, "operating", "USDC"))).toBe(usd(7));
    const { rows } = await bank.db.query<{ n: bigint }>("SELECT count(*) AS n FROM chain_event");
    expect(rows[0]?.n).toBe(2n);
  });

  it("ignores other tokens and unrelated addresses, and rejects malformed requests", async () => {
    await setup();
    const other = txEvents({
      chainId,
      blockNumber: 2n,
      txHash: hashOf("other"),
      logs: [
        {
          contract: "0x0000000000000000000000000000000000c0ffee",
          name: "Transfer",
          args: { from: EXTERNAL, to: SIM_REVENUE, value: "5" },
        },
        transfer(usdc, EXTERNAL, "0x000000000000000000000000000000000000bEEF", 5n),
      ],
    });
    expect(
      (await bank.reconciler.ingest(request(chainId, other, 2n, 0n))).results.map((r) => r.status),
    ).toEqual(["ignored", "ignored"]);
    const good = txEvents({
      chainId,
      blockNumber: 3n,
      logs: [transfer(usdc, EXTERNAL, SIM_REVENUE, 1n)],
    })[0]!;
    await expect(bank.reconciler.ingest(request(chainId + 1, [good], 3n, 0n))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      bank.reconciler.ingest(
        request(chainId, [{ ...good, id: `${chainId}:${hashOf("x")}:${hashOf("y")}:0` }], 3n, 0n),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(bank.reconciler.ingest(request(chainId, [good, good], 3n, 0n))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      bank.reconciler.reorg({ chain_id: chainId + 1, orphaned_block_hashes: [hashOf("b") as Hex] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
