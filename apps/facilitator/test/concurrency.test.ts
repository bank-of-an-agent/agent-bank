import { CHAINS, usdc } from "@agentbank/core";
import type { SqlClient, SqlParam } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Facilitator, type FacilitatorReply, type SettleResponse } from "../src/facilitator";
import { simulatedReceipts } from "../src/receipts";
import { SandboxScreening } from "../src/screening";
import {
  buildPayment,
  createHarness,
  otherRelayer,
  overrideGateway,
  payer,
  seller,
  type BuiltPayment,
  type Harness,
} from "./helpers";

/**
 * The single-use guarantee under concurrency: the authorization row is inserted (UNIQUE on
 * chain, asset, authorizer, nonce) before anything is submitted, so of N concurrent settles of
 * one authorization exactly one reaches the chain. Blocks are mined only after every other
 * request has answered, so no request can observe the finished settlement: the outcome does
 * not depend on scheduling (PGlite or PostgreSQL).
 */

let db: SqlClient;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

function harness(): Harness {
  const h = createHarness(db, { automine: false });
  h.chain.faucet(payer.address, usdc("100"));
  h.chain.mine();
  return h;
}

/** Start every settle at once; mine once all but one have answered. */
async function race(h: Harness, settles: (() => Promise<FacilitatorReply<SettleResponse>>)[]) {
  let answered = 0;
  const runs = settles.map((settle) =>
    settle().then((reply) => {
      answered += 1;
      if (answered === settles.length - 1) h.chain.mine();
      return reply;
    }),
  );
  return Promise.all(runs);
}

async function authorizationUses(h: Harness, built: BuiltPayment): Promise<number> {
  const logs = await h.chain.gateway.getLogs({
    fromBlock: 0n,
    toBlock: h.chain.head.number,
    events: ["AuthorizationUsed"],
  });
  return logs.filter((l) => String(l.args.nonce).toLowerCase() === built.authorization.nonce).length;
}

async function rows(built: BuiltPayment): Promise<{ status: string; tx_hash: string | null }[]> {
  const result = await db.query<{ status: string; tx_hash: string | null }>(
    "SELECT status, tx_hash FROM x402_authorization WHERE nonce = $1",
    [built.authorization.nonce],
  );
  return result.rows;
}

describe("concurrent settlement of one authorization", () => {
  it("double settle: exactly one succeeds and the funds move once", async () => {
    const h = harness();
    const built = await buildPayment(h, { amount: usdc("5") });
    const results = await race(h, [
      () => h.facilitator.settle(built.body),
      () => h.facilitator.settle(built.body),
    ]);

    const succeeded = results.filter((r) => r.body.success);
    expect(succeeded).toHaveLength(1);
    expect(results.filter((r) => !r.body.success).map((r) => r.body.errorReason)).toEqual([
      "settlement_in_progress",
    ]);
    expect(h.chain.balanceOf(seller)).toBe(usdc("5"));
    expect(h.chain.balanceOf(payer.address)).toBe(usdc("95"));
    expect(await authorizationUses(h, built)).toBe(1);
    expect(await rows(built)).toEqual([{ status: "settled", tx_hash: succeeded[0]?.body.transaction }]);

    // Afterwards the settlement is answered idempotently.
    expect((await h.facilitator.settle(built.body)).body).toEqual(succeeded[0]?.body);
  });

  it("the UNIQUE constraint decides the race when both requests pass the lookup", async () => {
    // Hold both requests inside verification (after the log lookup) until both have arrived,
    // so both reach the INSERT: exactly one insert may claim the authorization.
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inserts: number[] = [];
    const counting: SqlClient = {
      driver: db.driver,
      async query<T>(sql: string, params?: readonly SqlParam[]) {
        const result = await db.query<T>(sql, params);
        if (sql.includes("INSERT INTO x402_authorization")) inserts.push(result.rows.length);
        return result;
      },
      transaction: (fn, options) => db.transaction(fn, options),
      exec: (sql) => db.exec(sql),
      close: async () => undefined,
    };
    const h = createHarness(counting, {
      automine: false,
      gateway: (gateway) =>
        overrideGateway(gateway, {
          getTokenBalance: async (token, holder, block) => {
            arrived += 1;
            if (arrived === 2) release();
            await gate;
            return gateway.getTokenBalance(token, holder, block);
          },
        }),
    });
    h.chain.faucet(payer.address, usdc("10"));
    h.chain.mine();
    const built = await buildPayment(h, { amount: usdc("3") });
    const results = await race(h, [
      () => h.facilitator.settle(built.body),
      () => h.facilitator.settle(built.body),
    ]);
    expect(inserts.sort()).toEqual([0, 1]);
    expect(results.filter((r) => r.body.success)).toHaveLength(1);
    expect(results.filter((r) => r.body.errorReason === "settlement_in_progress")).toHaveLength(1);
    expect(h.chain.balanceOf(seller)).toBe(usdc("3"));
    expect(await authorizationUses(h, built)).toBe(1);
  });

  it("a burst of eight settles: one success, seven in progress, one transfer", async () => {
    const h = harness();
    const built = await buildPayment(h, { amount: usdc("1.5") });
    const results = await race(
      h,
      Array.from({ length: 8 }, () => () => h.facilitator.settle(built.body)),
    );
    expect(results.filter((r) => r.body.success)).toHaveLength(1);
    expect(results.filter((r) => r.body.errorReason === "settlement_in_progress")).toHaveLength(7);
    expect(h.chain.balanceOf(seller)).toBe(usdc("1.5"));
    expect(await authorizationUses(h, built)).toBe(1);
    expect(await rows(built)).toHaveLength(1);
  });

  it("two facilitator replicas sharing the database: exactly one settles", async () => {
    const h = harness();
    const replica = new Facilitator({
      db,
      gateway: h.chain.gateway,
      receipts: simulatedReceipts(h.chain),
      screening: new SandboxScreening(),
      clock: h.clock,
      relayer: otherRelayer,
      options: { chain: CHAINS.simulated, asset: h.asset, receiptTimeoutMs: 2_000 },
    });
    const built = await buildPayment(h, { amount: usdc("2") });
    const results = await race(h, [() => h.facilitator.settle(built.body), () => replica.settle(built.body)]);
    expect(results.filter((r) => r.body.success)).toHaveLength(1);
    expect(h.chain.balanceOf(seller)).toBe(usdc("2"));
    expect(await authorizationUses(h, built)).toBe(1);
  });

  it("concurrent settles of different authorizations all succeed", async () => {
    const h = harness();
    const payments = await Promise.all(
      Array.from({ length: 4 }, () => buildPayment(h, { amount: usdc("1") })),
    );
    // Every request submits its own transaction; keep mining until all have settled.
    const miner = setInterval(() => h.chain.mine(), 10);
    let results: FacilitatorReply<SettleResponse>[];
    try {
      results = await Promise.all(payments.map((p) => h.facilitator.settle(p.body)));
    } finally {
      clearInterval(miner);
    }
    expect(results.every((r) => r.body.success)).toBe(true);
    expect(new Set(results.map((r) => r.body.transaction)).size).toBe(4);
    expect(h.chain.balanceOf(seller)).toBe(usdc("4"));
  });
});
