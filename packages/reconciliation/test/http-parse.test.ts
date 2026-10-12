import { IndexerRoutes, signInternalRequest } from "@agentbank/core";
import { afterEach, describe, expect, it } from "vitest";
import { createInternalHandler, fingerprintOf, groupEvents } from "../src";
import { ledgerRefOf } from "../src/parse";
import { hashOf, request, transfer, txEvents } from "./support/events";
import { SimBank, usd } from "./support/sim-bank";

const SECRET = "test-internal-secret-0123456789";
const USDC = "0x5dc0000000000000000000000000000000005dc0";
const A = "0x00000000000000000000000000000000000000aA";
const B = "0x00000000000000000000000000000000000000bB";

describe("event grouping and identity", () => {
  it("groups per transaction in canonical order with block-independent fingerprints", () => {
    const tx1 = txEvents({
      chainId: 1337,
      blockNumber: 5n,
      txHash: hashOf("t1"),
      logs: [transfer(USDC, A, B, 5n), transfer(USDC, B, A, 1n)],
    });
    const tx2 = txEvents({
      chainId: 1337,
      blockNumber: 5n,
      txHash: hashOf("t2"),
      firstLogIndex: 2,
      logs: [transfer(USDC, A, B, 7n)],
    });
    const groups = groupEvents(1337, [...tx1, ...tx2]);
    expect(groups.map((g) => [g.txHash, g.events.length, g.firstLogIndex])).toEqual([
      [hashOf("t1"), 2, 0],
      [hashOf("t2"), 1, 2],
    ]);
    // The same transaction re-included in another block at other log indices: same fingerprint.
    const moved = txEvents({
      chainId: 1337,
      blockNumber: 9n,
      blockHash: hashOf("other-block"),
      txHash: hashOf("t1"),
      firstLogIndex: 40,
      logs: [transfer(USDC, A, B, 5n), transfer(USDC, B, A, 1n)],
    });
    expect(fingerprintOf(groupEvents(1337, moved)[0]!.events)).toBe(groups[0]!.fingerprint);
    const changed = txEvents({
      chainId: 1337,
      blockNumber: 9n,
      txHash: hashOf("t1"),
      logs: [transfer(USDC, A, B, 6n), transfer(USDC, B, A, 1n)],
    });
    expect(groupEvents(1337, changed)[0]!.fingerprint).not.toBe(groups[0]!.fingerprint);
  });

  it("derives deterministic ledger ids in the ledger's format", () => {
    const id = `1337:${hashOf("block")}:${hashOf("tx")}:3`;
    const ref = ledgerRefOf(id, 1_791_000_000);
    expect(ref).toMatch(/^cev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ledgerRefOf(id, 1_791_000_000)).toBe(ref);
    expect(ledgerRefOf(`${id}0`, 1_791_000_000)).not.toBe(ref);
  });

  it("rejects events of another chain, malformed ids and duplicates", () => {
    const [event] = txEvents({ chainId: 1337, blockNumber: 1n, logs: [transfer(USDC, A, B, 1n)] });
    expect(() => groupEvents(84532, [event!])).toThrow(/chain/);
    expect(() => groupEvents(1337, [{ ...event!, id: "1337:nope" }])).toThrow(/is not/);
    expect(() => groupEvents(1337, [event!, event!])).toThrow(/twice/);
  });
});

describe("internal HTTP handler", () => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("verifies the HMAC over method, path and raw body, validates bodies and answers problems", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const account = await bank.createAccount(org);
    const now = Math.floor(bank.now().getTime() / 1000);
    const handler = createInternalHandler(bank.reconciler, { secret: SECRET, clock: bank.clock });
    const call = (method: string, path: string, body: string, secret = SECRET) =>
      handler({ method, path, body, authorization: signInternalRequest(secret, method, path, body, now) });

    const watch = await call("GET", IndexerRoutes.watchlist.path, "");
    expect(watch.status).toBe(200);
    expect(JSON.parse(watch.body).addresses.map((a: { kind: string }) => a.kind)).toContain("account");

    const events = txEvents({
      chainId: bank.chain.chainId,
      blockNumber: 1n,
      logs: [transfer(bank.chain.contracts.usdc, B, account.address, usd(3))],
    });
    const body = JSON.stringify(request(bank.chain.chainId, events, 1n, 0n));
    const ok = await call("POST", IndexerRoutes.ingestEvents.path, body);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).results[0].status).toBe("deposit");

    const forged = await call("POST", IndexerRoutes.ingestEvents.path, body, "another-secret-0123456789");
    expect(forged.status).toBe(401);
    expect(JSON.parse(forged.body).code).toBe("unauthorized");
    // A signature over another body does not authorize this one.
    const swapped = await handler({
      method: "POST",
      path: IndexerRoutes.ingestEvents.path,
      body: body.replace("3000000", "9000000"),
      authorization: signInternalRequest(SECRET, "POST", IndexerRoutes.ingestEvents.path, body, now),
    });
    expect(swapped.status).toBe(401);
    const stale = await handler({
      method: "GET",
      path: IndexerRoutes.watchlist.path,
      body: "",
      authorization: signInternalRequest(SECRET, "GET", IndexerRoutes.watchlist.path, "", now - 3_600),
    });
    expect(stale.status).toBe(401);
    const invalid = await call(
      "POST",
      IndexerRoutes.reorg.path,
      JSON.stringify({ chain_id: 1337, orphaned_block_hashes: [] }),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).code).toBe("invalid_request");
    const unknown = await call("GET", "/internal/v1/nope", "");
    expect(unknown.status).toBe(404);
    const balances = await call(
      "POST",
      IndexerRoutes.expectedBalances.path,
      JSON.stringify({ chain_id: bank.chain.chainId, addresses: [account.address] }),
    );
    expect(JSON.parse(balances.body)).toEqual({
      balances: [{ address: account.address, expected: "3000000" }],
    });
  });
});
