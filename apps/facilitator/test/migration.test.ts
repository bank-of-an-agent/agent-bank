import { newId } from "@agentbank/core";
import { isUniqueViolation, type SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationStore } from "../src/store";
import { payer, randomNonce, seller } from "./helpers";

/** `packages/db/migrations/0004_x402.sql`: the single-use authorization log enforced by the database. */

let db: SqlClient;
let store: AuthorizationStore;
const ASSET = "0x5dC0000000000000000000000000000000005DC0";
const AT = new Date("2026-10-11T12:00:00Z");

beforeAll(async () => {
  db = await createTestDatabase();
  store = new AuthorizationStore(db);
});

afterAll(async () => {
  await db.close();
});

function row(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    id: newId("x402"),
    chain_id: 1337,
    asset: ASSET,
    authorizer: payer.address,
    nonce: randomNonce(),
    pay_to: seller,
    amount: 10_000n,
    valid_after: 0n,
    valid_before: 1_791_720_060n,
    request_hash: "0xabc",
    ...overrides,
  };
  const columns = Object.keys(values);
  return db.query(
    `INSERT INTO x402_authorization (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values) as never[],
  );
}

async function rejects(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  return String((error as Error).message);
}

describe("x402_authorization", () => {
  it("UNIQUE (chain_id, asset, authorizer, nonce): an authorization can be claimed once", async () => {
    const nonce = randomNonce();
    await row({ nonce });
    const duplicate = await row({ nonce }).catch((e: unknown) => e);
    expect(isUniqueViolation(duplicate)).toBe(true);
    // Another payer may use the same nonce value: the key is per authorizer.
    await row({ nonce, authorizer: seller });
  });

  it("insertSettling reports a lost race instead of throwing", async () => {
    const input = {
      chainId: 1337,
      asset: ASSET as `0x${string}`,
      authorizer: payer.address,
      nonce: randomNonce(),
      payTo: seller,
      amount: 5n,
      validAfter: 0n,
      validBefore: 100n,
      payeeAccountId: null,
      resourceUrl: undefined,
      requestHash: "0x01",
      relayer: undefined,
      at: AT,
    };
    expect((await store.insertSettling(input))?.status).toBe("settling");
    expect(await store.insertSettling(input)).toBeUndefined();
  });

  it("refuses mainnet chain ids", async () => {
    expect(await rejects(row({ chain_id: 8453 }))).toMatch(/check/i);
    expect(await rejects(row({ chain_id: 1 }))).toMatch(/check/i);
  });

  it("requires a lowercase 32-byte nonce and positive amounts", async () => {
    expect(await rejects(row({ nonce: randomNonce().toUpperCase().replace("0X", "0x") }))).toMatch(/check/i);
    expect(await rejects(row({ nonce: "0x1234" }))).toMatch(/check/i);
    expect(await rejects(row({ amount: 0n }))).toMatch(/check/i);
    expect(await rejects(row({ valid_before: 0n }))).toMatch(/check/i);
  });

  it("a settled row carries its transaction; a failed row its reason", async () => {
    expect(await rejects(row({ status: "settled" }))).toMatch(/check/i);
    expect(await rejects(row({ status: "failed" }))).toMatch(/check/i);
    expect(await rejects(row({ status: "pending" }))).toMatch(/check/i);
    await row({ status: "settled", tx_hash: `0x${"ab".repeat(32)}`, settled_at: AT });
    await row({ status: "failed", failure_reason: "invalid_transaction_state" });
  });

  it("payee_account_id must name an Agent Bank account", async () => {
    expect(await rejects(row({ payee_account_id: "acct_missing" }))).toMatch(/foreign key/i);
  });

  it("final states are not overwritten by later transitions", async () => {
    const input = {
      chainId: 1337,
      asset: ASSET as `0x${string}`,
      authorizer: payer.address,
      nonce: randomNonce(),
      payTo: seller,
      amount: 5n,
      validAfter: 0n,
      validBefore: 100n,
      payeeAccountId: null,
      resourceUrl: "https://seller.example",
      requestHash: "0x02",
      relayer: undefined,
      at: AT,
    };
    const claimed = await store.insertSettling(input);
    const failed = await store.markFailed(claimed?.id as string, "invalid_transaction_state", "reverted", AT);
    expect(failed?.status).toBe("failed");
    const after = await store.markSettled(claimed?.id as string, `0x${"cd".repeat(32)}`, 1n, AT);
    expect(after).toMatchObject({
      status: "failed",
      tx_hash: null,
      failure_reason: "invalid_transaction_state",
    });
  });
});
