import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processSettled } from "../src/jobs/settlement";
import { agentCall, call, createHarness, type Harness } from "./support/harness";
import { onboard, payAndSign, type World } from "./support/flows";

let h: Harness;
let alice: World;
let bob: World;
let paymentId: string;

beforeAll(async () => {
  h = await createHarness();
  alice = await onboard(h, { name: "alice", fund: usdc("500") });
  bob = await onboard(h, { name: "bob" });
  // Real traffic is spread over time; entries in the same millisecond have no defined order.
  h.clock.advanceSeconds(1);
  const paid = await payAndSign(h, alice, {
    amount: { amount: "100.00", asset: "USDC" },
    to: { agent_id: bob.agent.id },
    memo: "Dataset purchase",
  });
  paymentId = paid.body.id;
  h.clock.advanceSeconds(1);
  await h.indexer.sync();
  await processSettled(h.deps);
  h.clock.advanceSeconds(1);
  const vault = await agentCall(h, alice.session, "POST", "/v1/vaults", {
    body: { account_id: alice.account.id, kind: "goal", name: "Rainy day" },
  });
  await agentCall(h, alice.session, "POST", `/v1/vaults/${vault.body.id}/deposit`, {
    body: { amount: { amount: "50.00", asset: "USDC" } },
  });
});
afterAll(async () => h.close());

describe("ledger entries", () => {
  it("lists the account's entries with counterparty lines redacted", async () => {
    const res = await agentCall(h, alice.session, "GET", `/v1/accounts/${alice.account.id}/entries?limit=50`);
    expect(res.status).toBe(200);
    const entries = res.body.data as Array<{
      ref_type: string;
      lines: Array<{ ledger_account: string; account_id: string | null; amount: string }>;
    }>;
    expect(entries.length).toBeGreaterThanOrEqual(4);
    const settlement = entries.find((e) => e.lines.some((l) => l.ledger_account === "sys:revenue"));
    expect(settlement).toBeDefined();
    expect(settlement?.lines).toEqual(
      expect.arrayContaining([
        { ledger_account: "pocket:reserved", account_id: alice.account.id, amount: "-100.20", asset: "USDC" },
        { ledger_account: "counterparty", account_id: null, amount: "100.00", asset: "USDC" },
        { ledger_account: "sys:revenue", account_id: null, amount: "0.20", asset: "USDC" },
      ]),
    );
    for (const entry of entries) {
      for (const line of entry.lines) expect(typeof line.amount).toBe("string");
    }
  });

  it("filters entries by payment", async () => {
    const res = await agentCall(
      h,
      alice.session,
      "GET",
      `/v1/accounts/${alice.account.id}/entries?payment_id=${paymentId}`,
    );
    expect(res.status).toBe(200);
    const entries = res.body.data as Array<{ payment_id: string | null }>;
    expect(entries).toHaveLength(2); // the hold and its settlement
    for (const entry of entries) expect(entry.payment_id).toBe(paymentId);
  });

  it("paginates with the ledger's cursor", async () => {
    const page1 = await agentCall(
      h,
      alice.session,
      "GET",
      `/v1/accounts/${alice.account.id}/entries?limit=2`,
    );
    expect(page1.body.data).toHaveLength(2);
    const page2 = await agentCall(
      h,
      alice.session,
      "GET",
      `/v1/accounts/${alice.account.id}/entries?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
    );
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
  });

  it("hides other accounts' ledgers", async () => {
    expect((await agentCall(h, bob.session, "GET", `/v1/accounts/${alice.account.id}/entries`)).status).toBe(
      404,
    );
    expect(
      (await call(h.app, "GET", `/v1/accounts/${alice.account.id}/entries`, { token: bob.apiKey })).status,
    ).toBe(404);
  });
});

describe("statements", () => {
  it("builds the monthly statement from the ledger (internal moves excluded)", async () => {
    const res = await call(h.app, "GET", `/v1/statements?account_id=${alice.account.id}&period=2026-10`, {
      token: alice.apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "statement",
      account_id: alice.account.id,
      period: "2026-10",
      opening_balance: "0.00",
      closing_balance: "399.80",
      total_in: "500.00",
      total_out: "100.20",
      fees: "0.20",
      entry_count: 2,
    });
    expect(res.body.lines.map((l: { amount: string }) => l.amount)).toEqual(["500.00", "-100.20"]);
    expect(res.body.lines.map((l: { balance: string }) => l.balance)).toEqual(["500.00", "399.80"]);
  });

  it("exports CSV", async () => {
    const res = await agentCall(
      h,
      alice.session,
      "GET",
      `/v1/statements?account_id=${alice.account.id}&period=2026-10&format=csv`,
    );
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/csv");
    expect(String(res.headers["content-disposition"])).toContain(`statement-${alice.account.id}-2026-10.csv`);
    const lines = res.text.trim().split("\r\n");
    expect(lines).toContain("# closing_balance,399.80");
    expect(lines).toContain("entry_id,date,description,amount,balance,ref_type,ref_id");
    expect(lines.filter((l) => /^ent_/.test(l))).toHaveLength(2);
    expect(lines.some((l) => l.includes("Dataset purchase") && l.includes(",-100.20,399.80,"))).toBe(true);
  });

  it("is empty for a month before the account existed", async () => {
    const res = await call(h.app, "GET", `/v1/statements?account_id=${alice.account.id}&period=2026-09`, {
      token: alice.apiKey,
    });
    expect(res.body).toMatchObject({
      opening_balance: "0.00",
      closing_balance: "0.00",
      entry_count: 0,
      lines: [],
    });
  });

  it("validates the period", async () => {
    const res = await call(h.app, "GET", `/v1/statements?account_id=${alice.account.id}&period=2026-13`, {
      token: alice.apiKey,
    });
    expect(res.status).toBe(400);
  });
});
