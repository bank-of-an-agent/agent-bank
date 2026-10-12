import { newId } from "@agentbank/core";
import { POCKETS } from "@agentbank/core/api";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allowedLocations,
  chainRef,
  decodeCursor,
  encodeCursor,
  FUNDS_LOCATIONS,
  HOLD_RESERVES,
  parseCode,
  POCKET_LOCATIONS,
  pocketCode,
  pocketRef,
  RESERVE_POCKETS,
  RESERVED_KEY_PREFIX,
  revenueRef,
  STANDARD_POCKETS,
  suspenseRef,
  SYSTEM_OWNER,
  vaultPocket,
  vaultRef,
} from "../src";
import { normalizePost } from "../src/validation";

describe("ledger account refs and codes", () => {
  it("matches the pockets of the public API contract", () => {
    expect([...STANDARD_POCKETS]).toEqual([...POCKETS]);
    expect(Object.keys(POCKET_LOCATIONS)).toEqual([...STANDARD_POCKETS]);
    for (const location of Object.values(POCKET_LOCATIONS)) expect(FUNDS_LOCATIONS).toContain(location);
    expect(HOLD_RESERVES).toEqual({ operating: "reserved", spend: "spend_reserved" });
    expect(RESERVE_POCKETS).toEqual(["reserved", "spend_reserved"]);
    expect(RESERVED_KEY_PREFIX).toBe("ledger:");
  });

  it("builds refs", () => {
    const accountId = newId("account");
    const vaultId = newId("vault");
    expect(pocketCode("operating")).toBe("pocket:operating");
    expect(vaultPocket(vaultId)).toBe(`vault:${vaultId}`);
    expect(pocketRef(accountId, "fees", "USDC")).toEqual({
      ownerRef: accountId,
      code: "pocket:fees",
      asset: "USDC",
    });
    expect(vaultRef(accountId, vaultId, "USDC")).toEqual({
      ownerRef: accountId,
      code: `pocket:vault:${vaultId}`,
      asset: "USDC",
    });
    expect(chainRef(84532, "USDC")).toEqual({
      ownerRef: SYSTEM_OWNER,
      code: "sys:chain:84532:USDC",
      asset: "USDC",
    });
    expect(revenueRef("USDC")).toEqual({ ownerRef: "system", code: "sys:revenue", asset: "USDC" });
    expect(suspenseRef("EURC")).toEqual({ ownerRef: "system", code: "sys:suspense", asset: "EURC" });
  });

  it("parses codes and knows their locations", () => {
    const vaultId = newId("vault");
    expect(parseCode("pocket:spend_reserved")).toEqual({
      kind: "pocket",
      pocket: "spend_reserved",
      vaultId: null,
    });
    expect(parseCode(`pocket:vault:${vaultId}`)).toEqual({
      kind: "pocket",
      pocket: `vault:${vaultId}`,
      vaultId,
    });
    expect(parseCode("sys:chain:84532:USDC")).toEqual({ kind: "chain", chainId: 84532, asset: "USDC" });
    expect(parseCode("sys:revenue")).toEqual({ kind: "revenue" });
    expect(parseCode("sys:suspense")).toEqual({ kind: "suspense" });
    for (const bad of [
      "",
      "pocket:",
      "pocket:vault:",
      "sys:chain:0:USDC",
      "sys:chain:1:usdc",
      "operating",
      "sys:revenue:x",
    ]) {
      expect(() => parseCode(bad)).toThrow(/Unknown ledger account code/);
    }
    expect(allowedLocations(parseCode("pocket:escrow"))).toEqual(["escrow_contract"]);
    expect(allowedLocations(parseCode(`pocket:vault:${vaultId}`))).toEqual([
      "smart_account",
      "vault_contract",
    ]);
    expect(allowedLocations(parseCode("sys:chain:1337:USDC"))).toEqual(["external"]);
    expect(allowedLocations(parseCode("sys:revenue"))).toEqual(["revenue_address"]);
    expect(allowedLocations(parseCode("sys:suspense"))).toEqual(["none"]);
  });
});

describe("cursors and request hashes", () => {
  it("round-trips cursors", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01"), max: new Date("2200-01-01"), noInvalidDate: true }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (createdAt, id) => {
          expect(decodeCursor(encodeCursor({ createdAt, id }))).toEqual({ createdAt, id });
        },
      ),
    );
  });

  it("hashes a request independently of key order and optional nulls", () => {
    const accountId = newId("account");
    const assets = new Set(["USDC"]);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 2n ** 62n }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (amount, memo) => {
          const lines = [
            { account: chainRef(1337, "USDC"), amount: -amount },
            { account: pocketRef(accountId, "operating", "USDC"), amount },
          ];
          const a = normalizePost({ idempotencyKey: "k", refType: "deposit", memo, lines }, assets);
          const b = normalizePost(
            {
              lines,
              memo,
              refType: "deposit",
              idempotencyKey: "k",
              refId: null,
              metadata: {},
              agentId: undefined,
            },
            assets,
          );
          const c = normalizePost(
            { idempotencyKey: "k", refType: "deposit", memo: `${memo}!`, lines },
            assets,
          );
          expect(b.hash).toBe(a.hash);
          expect(c.hash).not.toBe(a.hash);
        },
      ),
    );
  });
});
