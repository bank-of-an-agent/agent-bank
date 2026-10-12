import type { IngestEventsRequest, ReorgRequest } from "@agentbank/core";
import { pocketRef } from "@agentbank/ledger";
import type { Reconciler } from "@agentbank/reconciliation";
import { afterEach, describe, expect, it } from "vitest";
import { SimBank, usd } from "../../../packages/reconciliation/test/support/sim-bank";
import { Indexer, IndexerMetrics, IndexerStore, type ReconcilerTransport } from "../src";

const EXTERNAL = "0x000000000000000000000000000000000000dEaD" as const;

/** The reconciler in-process, recording what the indexer sends. */
class Recorder implements ReconcilerTransport {
  readonly ingests: IngestEventsRequest[] = [];
  readonly reorgs: ReorgRequest[] = [];
  constructor(readonly inner: Reconciler) {}
  watchlist() {
    return this.inner.watchlist();
  }
  ingest(r: IngestEventsRequest) {
    this.ingests.push(r);
    return this.inner.ingest(r);
  }
  reorg(r: ReorgRequest) {
    this.reorgs.push(r);
    return this.inner.reorg(r);
  }
  expectedBalances(r: Parameters<Reconciler["expectedBalances"]>[0]) {
    return this.inner.expectedBalances(r);
  }
  report(r: Parameters<Reconciler["report"]>[0]) {
    return this.inner.report(r);
  }
  sent(): string[] {
    return this.ingests.flatMap((r) => r.events.map((e) => e.id));
  }
}

async function expectReconciled(bank: SimBank): Promise<void> {
  const balances = await bank.compareBalances();
  expect(balances.filter((b) => b.onchain !== b.expected)).toEqual([]);
  expect((await bank.ledger.verifyInvariants()).violations).toEqual([]);
  expect((await bank.reconciler.verify()).violations).toEqual([]);
}

describe("indexer loop (SimulatedChain, in-process reconciler)", () => {
  let bank: SimBank;
  let recorder: Recorder;
  afterEach(async () => bank?.close());

  async function create(options: Parameters<typeof SimBank.create>[0] = {}) {
    bank = await SimBank.create({
      ...options,
      transport: (r) => {
        recorder = new Recorder(r);
        return recorder;
      },
    });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    const b = await bank.createAccount(org);
    return { a, b };
  }

  it("pushes relevant logs per transaction, advances its cursor and reports block lag", async () => {
    const lines: string[] = [];
    const { a } = await create();
    const indexer = new Indexer({
      chain: bank.chain.gateway,
      transport: recorder,
      store: new IndexerStore(bank.indexerDb, bank.chain.chainId, () => bank.now()),
      startBlock: 0n,
      clock: bank.clock,
      metrics: new IndexerMetrics({
        indexerNamespace: "AgentBank/Indexer",
        reconciliationNamespace: "AgentBank/Reconciliation",
        write: (l) => lines.push(l),
      }),
    });
    bank.faucet(a.address, usd(20));
    bank.faucet(EXTERNAL, usd(1)); // nobody watched: not pushed
    const results = await indexer.catchUp();
    expect(results.at(-1)?.caughtUp).toBe(true);
    const events = recorder.ingests.flatMap((r) => r.events);
    expect(events.map((e) => [e.event_name, e.args.to])).toEqual([["Transfer", a.address]]);
    const e = events[0]!;
    expect(e.id).toBe(`${bank.chain.chainId}:${e.block_hash}:${e.tx_hash}:${e.log_index}`);
    expect(e.finality).toBe("latest");
    expect(await bank.available(a)).toBe(usd(20));
    const emf = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(emf.filter((l) => "BlockLag" in l).at(-1)).toMatchObject({
      BlockLag: 0,
      _aws: {
        CloudWatchMetrics: [
          { Namespace: "AgentBank/Indexer", Dimensions: [[]], Metrics: [{ Name: "BlockLag" }] },
        ],
      },
    });
    expect(emf.filter((l) => "UnmatchedEvents" in l).at(-1)).toMatchObject({
      UnmatchedEvents: 0,
      _aws: { CloudWatchMetrics: [{ Namespace: "AgentBank/Reconciliation" }] },
    });
  });

  it.each([1, 2, 3, 4, 5])(
    "detects a reorg of depth %i, pushes the replacement blocks, then reports the orphans",
    async (depth) => {
      const { a, b } = await create();
      bank.faucet(a.address, usd(50));
      await bank.sync();
      for (let i = 0; i < 5; i++) await bank.pay(a, b.address, usd(1), { toAccount: b });
      await bank.sync();
      const orphanedHashes = Array.from(
        { length: depth },
        (_, i) => bank.chain.block(bank.chain.head.number - BigInt(i))!.hash,
      );
      const before = recorder.ingests.length;
      bank.chain.injectReorg(depth);
      const ticks = await bank.indexer.catchUp();
      expect(ticks[0]?.reorg?.orphaned).toBe(depth);
      expect(recorder.reorgs).toHaveLength(1);
      expect(new Set(recorder.reorgs[0]!.orphaned_block_hashes)).toEqual(new Set(orphanedHashes));
      // Replacement blocks went first, the reorg notice after them.
      expect(recorder.ingests.length).toBeGreaterThan(before);
      expect(bank.reconciler.stats().rebound).toBe(depth);
      expect(bank.reconciler.stats().reversedEntries).toBe(0);
      await expectReconciled(bank);
    },
  );

  it("reverses what a reorg dropped and keeps going from the common ancestor", async () => {
    const { a, b } = await create();
    bank.faucet(a.address, usd(50));
    await bank.sync();
    const p = await bank.pay(a, b.address, usd(5), { toAccount: b });
    await bank.sync();
    bank.chain.injectReorg(2, { drop: "all" });
    bank.chain.mine(2);
    await bank.sync();
    expect(await bank.paymentStatus(p.id)).toBe("submitted");
    await bank.apiWorker();
    await bank.settleAll();
    await expectReconciled(bank);
  });

  it("restarts from its cursor without re-pushing indexed blocks, and finishes a pending reorg", async () => {
    const { a } = await create();
    bank.faucet(a.address, usd(10));
    await bank.sync();
    const pushed = new Set(recorder.sent());
    // Crash after rewinding for a reorg, before the replacement blocks and the notice are pushed.
    bank.chain.injectReorg(1);
    const store = new IndexerStore(bank.indexerDb, bank.chain.chainId, () => bank.now());
    const crashing = new Indexer({
      chain: bank.chain.gateway,
      transport: {
        watchlist: () => recorder.watchlist(),
        ingest: () => Promise.reject(new Error("API down")),
        reorg: (r) => recorder.reorg(r),
        expectedBalances: (r) => recorder.expectedBalances(r),
        report: (r) => recorder.report(r),
      } satisfies ReconcilerTransport,
      store,
      clock: bank.clock,
    });
    await expect(crashing.tick()).rejects.toThrow("API down");
    expect((await store.pendingReorg()).length).toBe(1);
    // A fresh process on the same database.
    const restarted = new Indexer({
      chain: bank.chain.gateway,
      transport: recorder,
      store,
      clock: bank.clock,
    });
    bank.faucet(a.address, usd(2));
    await restarted.catchUp();
    expect((await store.pendingReorg()).length).toBe(0);
    expect(recorder.reorgs).toHaveLength(1);
    const after = recorder.sent().filter((id) => !pushed.has(id));
    expect(after.length).toBeGreaterThan(0);
    expect(new Set(after).size).toBe(after.length);
    await expectReconciled(bank);
  });

  it("resends deferred events when they become final", async () => {
    const { a } = await create();
    bank.faucet(a.address, usd(250)); // >= $100
    await bank.sync();
    const { rows } = await bank.indexerDb.query<{ n: bigint }>("SELECT count(*) AS n FROM indexer_deferred");
    expect(rows[0]?.n).toBe(1n);
    expect(await bank.available(a)).toBe(0n);
    bank.chain.mine(12);
    await bank.sync();
    expect(await bank.available(a)).toBe(usd(250));
    const { rows: left } = await bank.indexerDb.query<{ n: bigint }>(
      "SELECT count(*) AS n FROM indexer_deferred",
    );
    expect(left[0]?.n).toBe(0n);
    const sends = recorder.sent().filter((id) => id === recorder.ingests[0]!.events[0]!.id);
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  it("backfills an address that received funds before it was registered", async () => {
    await create();
    await bank.sync();
    const org = await bank.createOrg();
    const early = await bank.createAccount(org);
    // Not registered yet when its counterfactual address is funded.
    await bank.db.query("DELETE FROM account WHERE id = $1", [early.id]);
    bank.indexer.invalidateWatchlist();
    bank.faucet(early.address, usd(7));
    await bank.sync();
    expect(recorder.sent()).toHaveLength(0);
    await bank.db.query(
      `INSERT INTO account (id, org_id, agent_id, role, chain_id, address, owner_address, salt, created_at)
       VALUES ($1, $2, $3, 'agent', $4, $5, $6, $7, $8)`,
      [
        early.id,
        org,
        early.agentId,
        bank.chain.chainId,
        early.address,
        early.owner.address,
        early.salt.toString(),
        bank.now(),
      ],
    );
    bank.indexer.invalidateWatchlist();
    await bank.sync();
    expect(await bank.available(early)).toBe(usd(7));
    await expectReconciled(bank);
  });

  it("checks on-chain balances against the ledger and reports mismatches", async () => {
    const { a } = await create();
    bank.faucet(a.address, usd(30));
    bank.faucet(a.address, usd(150)); // deferred (finality): counted as pending
    await bank.sync();
    const clean = await bank.indexer.balanceCheck();
    expect(clean?.mismatches).toEqual([]);
    expect(clean?.checked).toBeGreaterThan(0);
    // Drift: the ledger moves money the chain never saw.
    await bank.ledger.post({
      idempotencyKey: "test:drift",
      refType: "test",
      lines: [
        { account: pocketRef(a.id, "operating", "USDC"), amount: -usd(1) },
        {
          account: { ownerRef: "system", code: `sys:chain:${bank.chain.chainId}:USDC`, asset: "USDC" },
          amount: usd(1),
        },
      ],
    });
    const drifted = await bank.indexer.balanceCheck();
    expect(drifted?.mismatches).toEqual([
      { address: a.address, onchain: usd(180).toString(), expected: usd(179).toString() },
    ]);
    expect(drifted?.report).toMatchObject({ status: "mismatch", frozen_agents: [a.agentId] });
    const { rows } = await bank.indexerDb.query<{ n: bigint }>(
      "SELECT count(*) AS n FROM indexer_balance_check",
    );
    expect(rows[0]?.n).toBe(2n);
  });
});
