import { CHAINS, newId } from "@agentbank/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chainRef,
  pocketRef,
  revenueRef,
  STANDARD_POCKETS,
  suspenseRef,
  vaultRef,
  type Hold,
  type JournalEntry,
  type LedgerAccountRef,
} from "../../src";
import {
  ASSETS,
  CHAIN,
  deposit,
  HOUR,
  key,
  movePockets,
  openAccount,
  placeHold,
  rejects,
  type Harness,
  type HarnessFactory,
} from "./harness";

/**
 * The behavioural contract of `Ledger`, run unchanged against every implementation. Each test
 * gets a fresh, empty ledger.
 */
export function ledgerSuite(factory: HarnessFactory): void {
  let h: Harness;

  beforeEach(async () => {
    h = await factory();
  });

  afterEach(async () => {
    await h.close();
  });

  const operating = (accountId: string, asset = "USDC") => pocketRef(accountId, "operating", asset);
  const chain = (asset = "USDC") => chainRef(CHAIN, asset);
  const balanceOf = (ref: LedgerAccountRef) => h.ledger.balance(ref);

  describe("accounts", () => {
    it("opens every standard pocket once, on one chain", async () => {
      const accountId = newId("account");
      const pockets = await h.ledger.openPockets(accountId, "USDC", CHAIN);
      expect(pockets.map((p) => p.code)).toEqual(STANDARD_POCKETS.map((p) => `pocket:${p}`));
      expect(pockets.map((p) => p.location)).toEqual([
        "smart_account",
        "smart_account",
        "smart_account",
        "smart_account",
        "escrow_contract",
        "stream_contract",
        "spend_key",
        "spend_key",
      ]);
      for (const pocket of pockets) {
        expect(pocket).toMatchObject({ ownerRef: accountId, asset: "USDC", chainId: CHAIN, balance: 0n });
        expect(pocket.allowNegative).toBe(false);
        expect(pocket.id).toMatch(/^lac_[0-9A-Z]{26}$/);
        expect(pocket.createdAt).toEqual(h.clock.now());
      }
      expect(await h.ledger.openPockets(accountId, "USDC", CHAIN)).toEqual(pockets);
      const euro = await h.ledger.openPockets(accountId, "EURC", CHAIN);
      expect(euro.map((p) => p.id)).not.toContain(pockets[0]?.id);
      await rejects(h.ledger.openPockets(accountId, "USDC", CHAINS["base-sepolia"].id), "conflict");
    });

    it("validates openPockets arguments", async () => {
      await rejects(h.ledger.openPockets("acct_nope", "USDC", CHAIN), "invalid_request");
      await rejects(h.ledger.openPockets(newId("account"), "DOGE", CHAIN), "unsupported_asset");
      await rejects(h.ledger.openPockets(newId("account"), "USDC", 8453), "mainnet_locked");
      await rejects(h.ledger.openPockets(newId("account"), "USDC", 999_999), "unsupported_chain");
      await rejects(h.ledger.openPockets(newId("account"), "USDC", 1.5), "invalid_request");
    });

    it("creates vault pockets that inherit the account's chain", async () => {
      const accountId = await openAccount(h.ledger);
      const goal = await h.ledger.ensureAccount(vaultRef(accountId, newId("vault"), "USDC"));
      expect(goal).toMatchObject({
        chainId: CHAIN,
        location: "smart_account",
        allowNegative: false,
        balance: 0n,
      });
      const locked = await h.ledger.ensureAccount({
        ...vaultRef(accountId, newId("vault"), "USDC"),
        location: "vault_contract",
      });
      expect(locked.location).toBe("vault_contract");
      expect(await h.ledger.ensureAccount(goal)).toEqual(goal);
      await rejects(h.ledger.ensureAccount({ ...goal, location: "vault_contract" }), "conflict");
      await rejects(h.ledger.ensureAccount({ ...goal, chainId: CHAINS.anvil.id }), "conflict");
      await rejects(
        h.ledger.ensureAccount({
          ...vaultRef(accountId, newId("vault"), "USDC"),
          location: "escrow_contract",
        }),
        "invalid_request",
      );
      const orphan = await h.ledger.ensureAccount(vaultRef(newId("account"), newId("vault"), "USDC"));
      expect(orphan.chainId).toBeNull();
      const explicit = await h.ledger.ensureAccount({
        ...operating(newId("account")),
        chainId: CHAINS.anvil.id,
      });
      expect(explicit.chainId).toBe(CHAINS.anvil.id);
      const none = await h.ledger.ensureAccount({ ...operating(newId("account")), chainId: null });
      expect(none.chainId).toBeNull();
    });

    it("creates system accounts with their fixed chain and location", async () => {
      const mirror = await h.ledger.ensureAccount(chain());
      expect(mirror).toMatchObject({
        ownerRef: "system",
        code: `sys:chain:${CHAIN}:USDC`,
        chainId: CHAIN,
        location: "external",
        allowNegative: true,
      });
      expect(await h.ledger.ensureAccount({ ...chain(), chainId: CHAIN })).toEqual(mirror);
      const revenue = await h.ledger.ensureAccount(revenueRef("USDC"));
      expect(revenue).toMatchObject({ chainId: null, location: "revenue_address", allowNegative: true });
      const suspense = await h.ledger.ensureAccount({ ...suspenseRef("USDC"), chainId: null });
      expect(suspense).toMatchObject({ chainId: null, location: "none" });
      await rejects(h.ledger.ensureAccount({ ...chain(), chainId: CHAINS.anvil.id }), "invalid_request");
      await rejects(h.ledger.ensureAccount({ ...revenueRef("USDC"), chainId: CHAIN }), "invalid_request");
      await rejects(h.ledger.ensureAccount(chainRef(8453, "USDC")), "mainnet_locked");
    });

    it("rejects malformed refs", async () => {
      const accountId = newId("account");
      const bad: unknown[] = [
        null,
        "pocket:operating",
        { ownerRef: accountId, code: "pocket:operating" },
        { ownerRef: accountId, code: "pocket:checking", asset: "USDC" },
        { ownerRef: accountId, code: "pocket:vault:123", asset: "USDC" },
        { ownerRef: "system", code: "pocket:operating", asset: "USDC" },
        { ownerRef: accountId, code: "sys:revenue", asset: "USDC" },
        { ownerRef: "system", code: `sys:chain:${CHAIN}:EURC`, asset: "USDC" },
        { ownerRef: "system", code: "sys:treasury", asset: "USDC" },
      ];
      for (const ref of bad) {
        await rejects(h.ledger.ensureAccount(ref as LedgerAccountRef), "invalid_request");
      }
      await rejects(h.ledger.ensureAccount({ ...operating(accountId), asset: "usdc" }), "unsupported_asset");
    });

    it("gets and lists accounts", async () => {
      const accountId = await openAccount(h.ledger);
      await openAccount(h.ledger);
      const pocket = await h.ledger.getAccount(operating(accountId));
      expect(pocket.code).toBe("pocket:operating");
      await rejects(h.ledger.getAccount(operating(newId("account"))), "not_found");
      await rejects(h.ledger.getAccount(revenueRef("USDC")), "not_found");
      await h.ledger.openPockets(accountId, "EURC", CHAIN);
      const all = await h.ledger.listAccounts(accountId);
      expect(all).toHaveLength(16);
      expect(all.map((a) => `${a.code}/${a.asset}`).slice(0, 4)).toEqual([
        "pocket:escrow/EURC",
        "pocket:escrow/USDC",
        "pocket:fees/EURC",
        "pocket:fees/USDC",
      ]);
      expect(await h.ledger.listAccounts(accountId, "EURC")).toHaveLength(8);
      await deposit(h.ledger, accountId, 5n);
      expect((await h.ledger.listAccounts("system")).map((a) => a.code)).toEqual([`sys:chain:${CHAIN}:USDC`]);
      await rejects(h.ledger.listAccounts("bob"), "invalid_request");
      await rejects(h.ledger.listAccounts(accountId, "DOGE"), "unsupported_asset");
    });
  });

  describe("post", () => {
    it("posts a balanced entry and updates balances", async () => {
      const accountId = await openAccount(h.ledger);
      const entry = await deposit(h.ledger, accountId, 1_000_000n);
      expect(entry).toMatchObject({
        kind: "direct",
        refType: "deposit",
        refId: null,
        memo: null,
        agentId: null,
        paymentId: null,
        mandateId: null,
        decisionId: null,
        chainEventId: null,
        holdId: null,
        reversesEntryId: null,
        metadata: {},
        createdAt: h.clock.now(),
      });
      expect(entry.id).toMatch(/^ent_[0-9A-Z]{26}$/);
      expect(entry.requestHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(entry.lines.map((l) => [l.ownerRef, l.code, l.asset, l.amount])).toEqual([
        ["system", `sys:chain:${CHAIN}:USDC`, "USDC", -1_000_000n],
        [accountId, "pocket:operating", "USDC", 1_000_000n],
      ]);
      expect(await balanceOf(operating(accountId))).toBe(1_000_000n);
      expect(await balanceOf(chain())).toBe(-1_000_000n);
      expect(await h.ledger.getEntry(entry.id)).toEqual(entry);
    });

    it("records why money moved", async () => {
      const accountId = await openAccount(h.ledger);
      const context = {
        refId: "pay_123",
        memo: "invoice 7",
        agentId: newId("agent"),
        paymentId: newId("payment"),
        mandateId: newId("mandate"),
        decisionId: newId("decision"),
        chainEventId: newId("chainEvent"),
        metadata: { tx_hash: "0xabc", block: "42" },
      };
      const entry = await deposit(h.ledger, accountId, 10n, "USDC", context);
      expect(entry).toMatchObject(context);
      expect(await h.ledger.getEntry(entry.id)).toEqual(entry);
    });

    it("is idempotent by key", async () => {
      const accountId = await openAccount(h.ledger);
      const input = {
        idempotencyKey: key(),
        refType: "deposit",
        lines: [
          { account: chain(), amount: -5n },
          { account: operating(accountId), amount: 5n },
        ],
      };
      const first = await h.ledger.post(input);
      h.clock.advance(1000);
      expect(await h.ledger.post(input)).toEqual(first);
      expect(await h.ledger.post({ ...input, metadata: {}, memo: null })).toEqual(first);
      expect(await h.ledger.post({ ...input, memo: "", refId: "" })).toEqual(first);
      expect(await balanceOf(operating(accountId))).toBe(5n);
      const conflict = await rejects(h.ledger.post({ ...input, memo: "different" }), "idempotency_conflict");
      expect(conflict.extensions).toMatchObject({
        idempotency_key: input.idempotencyKey,
        entry_id: first.id,
      });
      await rejects(h.ledger.post({ ...input, lines: [...input.lines].reverse() }), "idempotency_conflict");
      await rejects(h.ledger.post({ ...input, idempotencyKey: "ledger:mine" }), "invalid_request");
      await rejects(h.ledger.post({ ...input, idempotencyKey: "" }), "invalid_request");
      await rejects(h.ledger.post({ ...input, idempotencyKey: "k".repeat(256) }), "invalid_request");
    });

    it("refuses to overdraw a pocket and writes nothing", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const input = {
        idempotencyKey: key(),
        refType: "payout",
        lines: [
          { account: operating(accountId), amount: -150n },
          { account: chain(), amount: 150n },
        ],
      };
      const error = await rejects(h.ledger.post(input), "insufficient_funds");
      expect(error.extensions).toMatchObject({
        owner_ref: accountId,
        code: "pocket:operating",
        asset: "USDC",
        available: "100",
        required: "150",
      });
      expect(await balanceOf(operating(accountId))).toBe(100n);
      expect(await balanceOf(chain())).toBe(-100n);
      expect((await h.ledger.listEntries({ ownerRef: accountId })).entries).toHaveLength(1);
      await deposit(h.ledger, accountId, 50n);
      const retried = await h.ledger.post(input);
      expect(retried.idempotencyKey).toBe(input.idempotencyKey);
      expect(await balanceOf(operating(accountId))).toBe(0n);
    });

    it("checks the net change of an account that appears twice", async () => {
      const accountId = await openAccount(h.ledger);
      const entry = await h.ledger.post({
        idempotencyKey: key(),
        refType: "noop",
        lines: [
          { account: operating(accountId), amount: -7n },
          { account: operating(accountId), amount: 7n },
        ],
      });
      expect(entry.lines).toHaveLength(2);
      expect(await balanceOf(operating(accountId))).toBe(0n);
    });

    it("balances each asset separately", async () => {
      const accountId = await openAccount(h.ledger);
      await h.ledger.openPockets(accountId, "EURC", CHAIN);
      const entry = await h.ledger.post({
        idempotencyKey: key(),
        refType: "deposit",
        lines: [
          { account: chain("USDC"), amount: -3n },
          { account: chain("EURC"), amount: -4n },
          { account: operating(accountId, "USDC"), amount: 3n },
          { account: operating(accountId, "EURC"), amount: 4n },
        ],
      });
      expect(entry.lines).toHaveLength(4);
      expect(await h.ledger.pocketBalances(accountId, "EURC")).toMatchObject({ operating: 4n });
      await rejects(
        h.ledger.post({
          idempotencyKey: key(),
          refType: "swap",
          lines: [
            { account: operating(accountId, "USDC"), amount: -3n },
            { account: operating(accountId, "EURC"), amount: 3n },
          ],
        }),
        "invalid_amount",
      );
    });

    it("validates entries", async () => {
      const accountId = await openAccount(h.ledger);
      const line = (amount: unknown, account: LedgerAccountRef = operating(accountId)) => ({
        account,
        amount,
      });
      const base = { idempotencyKey: key(), refType: "deposit" };
      const cases: [unknown, string][] = [
        [{ ...base, lines: [line(-5n, chain()), line(4n)] }, "invalid_amount"],
        [{ ...base, lines: [line(0n, chain()), line(0n)] }, "invalid_amount"],
        [{ ...base, lines: [line(-5, chain()), line(5)] }, "invalid_amount"],
        [{ ...base, lines: [line(-(2n ** 63n), chain()), line(2n ** 63n)] }, "invalid_amount"],
        [{ ...base, lines: [line(5n)] }, "invalid_request"],
        [{ ...base, lines: "nope" }, "invalid_request"],
        [{ ...base, lines: Array.from({ length: 101 }, () => line(1n)) }, "invalid_request"],
        [{ ...base, lines: [line(-5n, chain()), 7] }, "invalid_request"],
        [
          { ...base, lines: [line(-5n, chain()), line(5n, pocketRef(accountId, "reserved", "USDC"))] },
          "invalid_request",
        ],
        [
          { ...base, lines: [line(-5n, chain()), line(5n, pocketRef(accountId, "spend_reserved", "USDC"))] },
          "invalid_request",
        ],
        [{ ...base, lines: [line(-5n, chainRef(CHAIN, "DOGE")), line(5n)] }, "unsupported_asset"],
        [{ ...base, refType: undefined, lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, refType: "", lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, refType: "x".repeat(65), lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, agentId: "agent-7", lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, paymentId: newId("agent"), lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, memo: 7, lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, memo: "m".repeat(2001), lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, metadata: { n: 1 }, lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [{ ...base, metadata: [], lines: [line(-5n, chain()), line(5n)] }, "invalid_request"],
        [
          {
            ...base,
            metadata: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"])),
            lines: [line(-5n, chain()), line(5n)],
          },
          "invalid_request",
        ],
        [null, "invalid_request"],
      ];
      for (const [input, code] of cases) {
        await rejects(h.ledger.post(input as never), code as never);
      }
    });

    it("needs pockets to exist but creates system accounts on first use", async () => {
      const ghost = newId("account");
      const error = await rejects(
        h.ledger.post({
          idempotencyKey: key(),
          refType: "deposit",
          lines: [
            { account: chain(), amount: -1n },
            { account: operating(ghost), amount: 1n },
          ],
        }),
        "not_found",
      );
      expect(error.extensions).toMatchObject({ owner_ref: ghost, code: "pocket:operating" });
      expect(await balanceOf(chain())).toBe(0n);
      await rejects(h.ledger.getAccount(chain()), "not_found");
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 10n);
      await h.ledger.post({
        idempotencyKey: key(),
        refType: "suspense",
        lines: [
          { account: operating(accountId), amount: -4n },
          { account: suspenseRef("USDC"), amount: 4n },
        ],
      });
      expect(await balanceOf(suspenseRef("USDC"))).toBe(4n);
      expect((await h.ledger.getAccount(suspenseRef("USDC"))).location).toBe("none");
    });

    it("keeps balances inside the bigint range", async () => {
      const accountId = await openAccount(h.ledger);
      const max = 2n ** 63n - 1n;
      await deposit(h.ledger, accountId, max);
      await rejects(deposit(h.ledger, accountId, 1n), "invalid_amount");
      const other = await openAccount(h.ledger);
      await rejects(deposit(h.ledger, other, max), "invalid_amount");
      expect(await balanceOf(operating(accountId))).toBe(max);
    });
  });

  describe("holds", () => {
    it("reserves funds from operating", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const paymentId = newId("payment");
      const hold = await placeHold(h, accountId, 30n, "operating", {
        refId: paymentId,
        paymentId,
        memo: "api call",
      });
      expect(hold).toMatchObject({
        accountId,
        asset: "USDC",
        from: "operating",
        amount: 30n,
        postedAmount: null,
        status: "pending",
        resolutionEntryId: null,
        refType: "payment",
        refId: paymentId,
        paymentId,
        memo: "api call",
        voidReason: null,
        resolvedAt: null,
        createdAt: h.clock.now(),
      });
      expect(hold.id).toMatch(/^hld_[0-9A-Z]{26}$/);
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 70n,
        reserved: 30n,
      });
      const reservation = await h.ledger.getEntry(hold.entryId);
      expect(reservation).toMatchObject({ kind: "hold", holdId: hold.id, paymentId, refType: "payment" });
      expect(reservation.lines.map((l) => [l.code, l.amount])).toEqual([
        ["pocket:operating", -30n],
        ["pocket:reserved", 30n],
      ]);
      expect(reservation.lines.map((l) => l.ledgerAccountId)).toEqual([
        hold.fromAccountId,
        hold.reserveAccountId,
      ]);
      expect(await h.ledger.getHold(hold.id)).toEqual(hold);
    });

    it("reserves the x402 float from spend into spend_reserved", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      await movePockets(h.ledger, accountId, "operating", "spend", 40n);
      const hold = await placeHold(h, accountId, 25n, "spend");
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 60n,
        spend: 15n,
        spend_reserved: 25n,
        reserved: 0n,
      });
      await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        destinations: [{ to: chain(), amount: 25n }],
      });
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        spend: 15n,
        spend_reserved: 0n,
      });
      await rejects(placeHold(h, accountId, 16n, "spend"), "insufficient_funds");
    });

    it("refuses holds the source pocket cannot cover", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 10n);
      await rejects(placeHold(h, accountId, 11n), "insufficient_funds");
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 10n,
        reserved: 0n,
      });
      expect((await h.ledger.verifyInvariants()).holds).toBe(0);
    });

    it("validates holds", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 10n);
      const past = new Date(h.clock.now().getTime() - 1);
      await rejects(placeHold(h, accountId, 0n), "invalid_amount");
      await rejects(placeHold(h, accountId, -1n), "invalid_amount");
      await rejects(placeHold(h, accountId, 1n, "fees" as never), "invalid_request");
      await rejects(placeHold(h, accountId, 1n, "operating", { expiresAt: past }), "invalid_request");
      await rejects(
        placeHold(h, accountId, 1n, "operating", { expiresAt: h.clock.now() }),
        "invalid_request",
      );
      await rejects(
        placeHold(h, accountId, 1n, "operating", { expiresAt: new Date("nope") }),
        "invalid_request",
      );
      await rejects(placeHold(h, accountId, 1n, "operating", { expiresAt: "2030-01-01" }), "invalid_request");
      await rejects(placeHold(h, "acct_nope", 1n), "invalid_request");
      await rejects(placeHold(h, accountId, 1n, "operating", { asset: "DOGE" }), "unsupported_asset");
      await rejects(placeHold(h, accountId, 1n, "operating", { refType: undefined }), "invalid_request");
      await rejects(placeHold(h, newId("account"), 1n), "not_found");
    });

    it("replays a hold in its current state", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const input = {
        idempotencyKey: key(),
        accountId,
        asset: "USDC",
        amount: 40n,
        from: "operating" as const,
        expiresAt: new Date(h.clock.now().getTime() + HOUR),
        refType: "payment",
      };
      const hold = await h.ledger.hold(input);
      expect(await h.ledger.hold(input)).toEqual(hold);
      await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        destinations: [{ to: chain(), amount: 40n }],
      });
      h.clock.advance(2 * HOUR);
      const replayed = await h.ledger.hold(input);
      expect(replayed).toMatchObject({ id: hold.id, status: "posted", postedAmount: 40n });
      expect(await balanceOf(operating(accountId))).toBe(60n);
      await rejects(h.ledger.hold({ ...input, amount: 41n }), "idempotency_conflict");
    });

    it("posts the full amount to its destinations", async () => {
      const payer = await openAccount(h.ledger);
      const payee = await openAccount(h.ledger);
      await deposit(h.ledger, payer, 1_000n);
      const agentId = newId("agent");
      const decisionId = newId("decision");
      const hold = await placeHold(h, payer, 1_000n, "operating", { agentId, decisionId, memo: "hold memo" });
      h.clock.advance(5_000);
      const chainEventId = newId("chainEvent");
      const entry = await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        destinations: [
          { to: operating(payee), amount: 998n },
          { to: revenueRef("USDC"), amount: 2n },
        ],
        chainEventId,
        metadata: { tx_hash: "0x01" },
      });
      expect(entry).toMatchObject({
        kind: "hold_post",
        holdId: hold.id,
        refType: "payment",
        agentId,
        decisionId,
        memo: "hold memo",
        chainEventId,
        metadata: { tx_hash: "0x01" },
        createdAt: h.clock.now(),
      });
      expect(entry.lines.map((l) => [l.ownerRef, l.code, l.amount])).toEqual([
        [payer, "pocket:reserved", -1_000n],
        [payee, "pocket:operating", 998n],
        ["system", "sys:revenue", 2n],
      ]);
      expect(await h.ledger.getHold(hold.id)).toMatchObject({
        status: "posted",
        postedAmount: 1_000n,
        resolutionEntryId: entry.id,
        resolvedAt: h.clock.now(),
      });
      expect(await h.ledger.pocketBalances(payer, "USDC")).toMatchObject({ operating: 0n, reserved: 0n });
      expect(await balanceOf(operating(payee))).toBe(998n);
      expect(await balanceOf(revenueRef("USDC"))).toBe(2n);
    });

    it("posts part of a hold and releases the rest", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 100n);
      const entry = await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        amount: 60n,
        destinations: [
          { to: chain(), amount: 59n },
          { to: revenueRef("USDC"), amount: 1n },
        ],
        refType: "x402",
        memo: null,
      });
      expect(entry.refType).toBe("x402");
      expect(entry.memo).toBeNull();
      expect(entry.lines.map((l) => [l.code, l.amount])).toEqual([
        ["pocket:reserved", -100n],
        [`sys:chain:${CHAIN}:USDC`, 59n],
        ["sys:revenue", 1n],
        ["pocket:operating", 40n],
      ]);
      expect(await h.ledger.getHold(hold.id)).toMatchObject({ status: "posted", postedAmount: 60n });
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 40n,
        reserved: 0n,
      });
    });

    it("merges destinations that hit the same account", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 100n);
      const entry = await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        amount: 50n,
        destinations: [
          { to: pocketRef(accountId, "spend", "USDC"), amount: 20n },
          { to: pocketRef(accountId, "spend", "USDC"), amount: 10n },
          { to: operating(accountId), amount: 20n },
        ],
      });
      expect(entry.lines.map((l) => [l.code, l.amount])).toEqual([
        ["pocket:reserved", -100n],
        ["pocket:spend", 30n],
        ["pocket:operating", 70n],
      ]);
    });

    it("validates postHold", async () => {
      const accountId = await openAccount(h.ledger);
      await h.ledger.openPockets(accountId, "EURC", CHAIN);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 50n);
      const post = (input: Record<string, unknown>) =>
        h.ledger.postHold({
          idempotencyKey: key(),
          holdId: hold.id,
          destinations: [{ to: chain(), amount: 50n }],
          ...input,
        });
      await rejects(post({ amount: 51n, destinations: [{ to: chain(), amount: 51n }] }), "invalid_amount");
      await rejects(post({ amount: 50n, destinations: [{ to: chain(), amount: 49n }] }), "invalid_amount");
      await rejects(post({ destinations: [{ to: chain(), amount: 49n }] }), "invalid_amount");
      await rejects(post({ amount: 0n }), "invalid_amount");
      await rejects(post({ destinations: [{ to: chain(), amount: 0n }] }), "invalid_amount");
      await rejects(post({ destinations: [] }), "invalid_request");
      await rejects(
        post({ destinations: [{ to: pocketRef(accountId, "reserved", "USDC"), amount: 50n }] }),
        "invalid_request",
      );
      await rejects(post({ destinations: [{ to: chain("EURC"), amount: 50n }] }), "invalid_request");
      await rejects(post({ destinations: [{ to: operating(newId("account")), amount: 50n }] }), "not_found");
      await rejects(post({ holdId: newId("hold") }), "not_found");
      await rejects(post({ holdId: "" }), "invalid_request");
      await rejects(post({ refType: "" }), "invalid_request");
      expect(await h.ledger.getHold(hold.id)).toMatchObject({ status: "pending" });
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 50n,
        reserved: 50n,
      });
    });

    it("resolves a hold exactly once", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 50n);
      const input = { idempotencyKey: key(), holdId: hold.id, destinations: [{ to: chain(), amount: 50n }] };
      const posted = await h.ledger.postHold(input);
      expect(await h.ledger.postHold(input)).toEqual(posted);
      await rejects(h.ledger.postHold({ ...input, memo: "again" }), "idempotency_conflict");
      const error = await rejects(h.ledger.postHold({ ...input, idempotencyKey: key() }), "invalid_state");
      expect(error.extensions).toMatchObject({ hold_id: hold.id, status: "posted" });
      await rejects(
        h.ledger.voidHold({ idempotencyKey: key(), holdId: hold.id, reason: "late" }),
        "invalid_state",
      );
      expect(await h.ledger.expireHolds(new Date(h.clock.now().getTime() + 2 * HOUR))).toBe(0);
      expect(await balanceOf(chain())).toBe(-50n);
    });

    it("voids a hold back to its source", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 60n);
      const input = { idempotencyKey: key(), holdId: hold.id, reason: "policy_denied" };
      const entry = await h.ledger.voidHold(input);
      expect(entry).toMatchObject({
        kind: "hold_void",
        holdId: hold.id,
        memo: "policy_denied",
        refType: "payment",
      });
      expect(entry.lines.map((l) => [l.code, l.amount])).toEqual([
        ["pocket:reserved", -60n],
        ["pocket:operating", 60n],
      ]);
      expect(await h.ledger.getHold(hold.id)).toMatchObject({
        status: "voided",
        voidReason: "policy_denied",
        resolutionEntryId: entry.id,
        postedAmount: null,
      });
      expect(await h.ledger.voidHold(input)).toEqual(entry);
      await rejects(h.ledger.voidHold({ ...input, reason: "other" }), "idempotency_conflict");
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 100n,
        reserved: 0n,
      });
      const second = await placeHold(h, accountId, 10n);
      const withMemo = await h.ledger.voidHold({
        idempotencyKey: key(),
        holdId: second.id,
        reason: "failed",
        memo: "bundler error",
      });
      expect(withMemo.memo).toBe("bundler error");
      await rejects(
        h.ledger.voidHold({ idempotencyKey: key(), holdId: newId("hold"), reason: "x" }),
        "not_found",
      );
      await rejects(
        h.ledger.voidHold({ idempotencyKey: key(), holdId: second.id, reason: "" }),
        "invalid_request",
      );
    });

    it("posts a pending hold even after it is due, until it is expired", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const late = await placeHold(h, accountId, 10n);
      h.clock.advance(3 * HOUR);
      await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: late.id,
        destinations: [{ to: chain(), amount: 10n }],
      });
      expect((await h.ledger.getHold(late.id)).status).toBe("posted");
    });

    it("expires due holds", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const start = h.clock.now().getTime();
      const first = await placeHold(h, accountId, 10n, "operating", { expiresAt: new Date(start + 1_000) });
      const second = await placeHold(h, accountId, 20n, "operating", { expiresAt: new Date(start + 2_000) });
      const third = await placeHold(h, accountId, 30n, "operating", { expiresAt: new Date(start + 3_000) });
      expect(await h.ledger.expireHolds(new Date(start + 999))).toBe(0);
      h.clock.advance(5_000);
      expect(await h.ledger.expireHolds(new Date(start + 2_000), { limit: 1 })).toBe(1);
      expect((await h.ledger.getHold(first.id)).status).toBe("expired");
      expect((await h.ledger.getHold(second.id)).status).toBe("pending");
      expect(await h.ledger.expireHolds(new Date(start + 2_000))).toBe(1);
      expect(await h.ledger.expireHolds(new Date(start + 2_000))).toBe(0);
      const expired = await h.ledger.getHold(second.id);
      expect(expired).toMatchObject({ status: "expired", voidReason: null, resolvedAt: h.clock.now() });
      const entry = await h.ledger.getEntry(expired.resolutionEntryId as string);
      expect(entry).toMatchObject({ kind: "hold_expire", memo: "hold expired", holdId: second.id });
      expect(entry.idempotencyKey.startsWith("ledger:expire:")).toBe(true);
      expect(entry.lines.map((l) => [l.code, l.amount])).toEqual([
        ["pocket:reserved", -20n],
        ["pocket:operating", 20n],
      ]);
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 70n,
        reserved: 30n,
      });
      await rejects(
        h.ledger.postHold({
          idempotencyKey: key(),
          holdId: first.id,
          destinations: [{ to: chain(), amount: 10n }],
        }),
        "invalid_state",
      );
      expect((await h.ledger.getHold(third.id)).status).toBe("pending");
      await rejects(h.ledger.expireHolds(new Date("bad")), "invalid_request");
      await rejects(h.ledger.expireHolds(h.clock.now(), { limit: 0 }), "invalid_request");
      await rejects(h.ledger.expireHolds(h.clock.now(), { limit: 1.5 }), "invalid_request");
    });
  });

  describe("reverse", () => {
    it("negates an entry once", async () => {
      const accountId = await openAccount(h.ledger);
      const agentId = newId("agent");
      const original = await deposit(h.ledger, accountId, 100n, "USDC", {
        refId: "cev_1",
        agentId,
        chainEventId: newId("chainEvent"),
        metadata: { block: "1" },
      });
      h.clock.advance(1_000);
      const input = { idempotencyKey: key(), entryId: original.id, memo: "reorg" };
      const reversal = await h.ledger.reverse(input);
      expect(reversal).toMatchObject({
        kind: "reversal",
        reversesEntryId: original.id,
        refType: "deposit",
        refId: "cev_1",
        agentId,
        memo: "reorg",
        chainEventId: null,
        metadata: {},
        holdId: null,
        createdAt: h.clock.now(),
      });
      expect(reversal.lines.map((l) => [l.ledgerAccountId, l.amount])).toEqual(
        original.lines.map((l) => [l.ledgerAccountId, -l.amount]),
      );
      expect(await balanceOf(operating(accountId))).toBe(0n);
      expect(await balanceOf(chain())).toBe(0n);
      expect(await h.ledger.reverse(input)).toEqual(reversal);
      await rejects(h.ledger.reverse({ ...input, memo: "other" }), "idempotency_conflict");
      const twice = await rejects(h.ledger.reverse({ ...input, idempotencyKey: key() }), "invalid_state");
      expect(twice.extensions).toMatchObject({ reversal_entry_id: reversal.id });
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: reversal.id, memo: "undo" }),
        "invalid_state",
      );
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: newId("entry"), memo: "?" }),
        "not_found",
      );
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: original.id, memo: "" }),
        "invalid_request",
      );
    });

    it("refuses a reversal that would overdraw a pocket", async () => {
      const accountId = await openAccount(h.ledger);
      const original = await deposit(h.ledger, accountId, 100n);
      await placeHold(h, accountId, 60n);
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: original.id, memo: "reorg" }),
        "insufficient_funds",
      );
      expect(await balanceOf(operating(accountId))).toBe(40n);
    });

    it("never reverses a hold's reservation", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 60n);
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: hold.entryId, memo: "no" }),
        "invalid_state",
      );
    });

    it("re-opens a hold when its settlement is reversed", async () => {
      const payer = await openAccount(h.ledger);
      const payee = await openAccount(h.ledger);
      await deposit(h.ledger, payer, 100n);
      const hold = await placeHold(h, payer, 100n, "operating", { paymentId: newId("payment") });
      const posted = await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        amount: 80n,
        destinations: [{ to: operating(payee), amount: 80n }],
      });
      const reversal = await h.ledger.reverse({ idempotencyKey: key(), entryId: posted.id, memo: "reorg" });
      expect(reversal).toMatchObject({
        holdId: hold.id,
        paymentId: hold.paymentId,
        reversesEntryId: posted.id,
      });
      expect(await h.ledger.getHold(hold.id)).toEqual({ ...hold, status: "pending" });
      expect(await h.ledger.pocketBalances(payer, "USDC")).toMatchObject({ operating: 0n, reserved: 100n });
      expect(await balanceOf(operating(payee))).toBe(0n);
      const reposted = await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        destinations: [{ to: operating(payee), amount: 100n }],
      });
      expect(await h.ledger.getHold(hold.id)).toMatchObject({
        status: "posted",
        resolutionEntryId: reposted.id,
      });
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: posted.id, memo: "again" }),
        "invalid_state",
      );
      await movePockets(h.ledger, payee, "operating", "fees", 50n);
      await rejects(
        h.ledger.reverse({ idempotencyKey: key(), entryId: reposted.id, memo: "reorg" }),
        "insufficient_funds",
      );
      expect((await h.ledger.getHold(hold.id)).status).toBe("posted");
      expect((await h.ledger.verifyInvariants()).violations).toEqual([]);
    });

    it("re-opens voided and expired holds, which can then expire again", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 40n);
      const voided = await h.ledger.voidHold({ idempotencyKey: key(), holdId: hold.id, reason: "denied" });
      await h.ledger.reverse({ idempotencyKey: key(), entryId: voided.id, memo: "approval arrived" });
      expect(await h.ledger.getHold(hold.id)).toMatchObject({ status: "pending", voidReason: null });
      h.clock.advance(2 * HOUR);
      expect(await h.ledger.expireHolds(h.clock.now())).toBe(1);
      const expiry = (await h.ledger.getHold(hold.id)).resolutionEntryId as string;
      await h.ledger.reverse({ idempotencyKey: key(), entryId: expiry, memo: "settled on chain" });
      expect(await h.ledger.expireHolds(h.clock.now())).toBe(1);
      const entries = await h.ledger.listEntries({ holdId: hold.id });
      expect(entries.entries.map((e) => e.kind).sort()).toEqual([
        "hold",
        "hold_expire",
        "hold_expire",
        "hold_void",
        "reversal",
        "reversal",
      ]);
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 100n,
        reserved: 0n,
      });
    });
  });

  describe("reads", () => {
    it("reads balances, with unused system accounts at zero", async () => {
      const accountId = await openAccount(h.ledger);
      expect(await balanceOf(operating(accountId))).toBe(0n);
      expect(await balanceOf(revenueRef("USDC"))).toBe(0n);
      await rejects(balanceOf(operating(newId("account"))), "not_found");
      await rejects(balanceOf({ ...operating(accountId), asset: "DOGE" }), "unsupported_asset");
    });

    it("reads balances as of a point in time", async () => {
      const accountId = await openAccount(h.ledger);
      const t0 = h.clock.now();
      await deposit(h.ledger, accountId, 10n);
      const t1 = h.clock.advance(1_000);
      await deposit(h.ledger, accountId, 20n);
      const t2 = h.clock.advance(1_000);
      await placeHold(h, accountId, 5n);
      expect(await h.ledger.balanceAt(operating(accountId), new Date(t0.getTime() - 1))).toBe(0n);
      expect(await h.ledger.balanceAt(operating(accountId), t0)).toBe(10n);
      expect(await h.ledger.balanceAt(operating(accountId), new Date(t1.getTime() - 1))).toBe(10n);
      expect(await h.ledger.balanceAt(operating(accountId), t1)).toBe(30n);
      expect(await h.ledger.balanceAt(operating(accountId), t2)).toBe(25n);
      expect(await h.ledger.balanceAt(chain(), t1)).toBe(-30n);
      expect(await h.ledger.balanceAt(revenueRef("USDC"), t2)).toBe(0n);
      await rejects(h.ledger.balanceAt(operating(newId("account")), t2), "not_found");
      await rejects(h.ledger.balanceAt(operating(accountId), new Date("x")), "invalid_request");
    });

    it("reads pocket and location balances", async () => {
      const accountId = await openAccount(h.ledger);
      const goal = newId("vault");
      const locked = newId("vault");
      await h.ledger.ensureAccount(vaultRef(accountId, goal, "USDC"));
      await h.ledger.ensureAccount({ ...vaultRef(accountId, locked, "USDC"), location: "vault_contract" });
      await deposit(h.ledger, accountId, 1_000n);
      await movePockets(h.ledger, accountId, "operating", `vault:${goal}`, 100n);
      await movePockets(h.ledger, accountId, "operating", `vault:${locked}`, 200n);
      await movePockets(h.ledger, accountId, "operating", "escrow", 50n);
      await movePockets(h.ledger, accountId, "operating", "stream", 40n);
      await movePockets(h.ledger, accountId, "operating", "spend", 30n);
      await movePockets(h.ledger, accountId, "operating", "fees", 5n);
      await movePockets(h.ledger, accountId, "operating", "savings", 15n);
      await placeHold(h, accountId, 10n, "spend");
      await placeHold(h, accountId, 60n);
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toEqual({
        operating: 500n,
        reserved: 60n,
        fees: 5n,
        savings: 15n,
        escrow: 50n,
        stream: 40n,
        spend: 20n,
        spend_reserved: 10n,
        [`vault:${goal}`]: 100n,
        [`vault:${locked}`]: 200n,
      });
      expect(await h.ledger.locationBalances(accountId, "USDC")).toEqual({
        smart_account: 680n,
        vault_contract: 200n,
        escrow_contract: 50n,
        stream_contract: 40n,
        spend_key: 30n,
      });
      const lonely = newId("account");
      await h.ledger.ensureAccount(operating(lonely));
      expect(await h.ledger.pocketBalances(lonely, "USDC")).toMatchObject({ operating: 0n, spend: 0n });
      await rejects(h.ledger.pocketBalances(newId("account"), "USDC"), "not_found");
      await rejects(h.ledger.locationBalances(accountId, "EURC"), "not_found");
      await rejects(h.ledger.pocketBalances("acct_x", "USDC"), "invalid_request");
    });

    it("gets entries and holds by id", async () => {
      await rejects(h.ledger.getEntry(newId("entry")), "not_found");
      await rejects(h.ledger.getHold(newId("hold")), "not_found");
      await rejects(h.ledger.getHold("not-an-id"), "not_found");
    });

    it("lists entries newest first with stable keyset pagination", async () => {
      const accountId = await openAccount(h.ledger);
      const written: JournalEntry[] = [];
      for (let i = 0; i < 7; i += 1) {
        written.push(await deposit(h.ledger, accountId, BigInt(i + 1)));
        if (i % 3 === 0) h.clock.advance(1_000);
      }
      const expected = [...written]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .reverse()
        .map((e) => e.id);
      const first = await h.ledger.listEntries({ ownerRef: accountId }, { limit: 3 });
      expect(first.entries.map((e) => e.id)).toEqual(expected.slice(0, 3));
      expect(first.nextCursor).not.toBeNull();
      h.clock.advance(1_000);
      await deposit(h.ledger, accountId, 100n);
      const second = await h.ledger.listEntries(
        { ownerRef: accountId },
        { limit: 3, cursor: first.nextCursor },
      );
      expect(second.entries.map((e) => e.id)).toEqual(expected.slice(3, 6));
      const third = await h.ledger.listEntries(
        { ownerRef: accountId },
        { limit: 3, cursor: second.nextCursor },
      );
      expect(third.entries.map((e) => e.id)).toEqual(expected.slice(6));
      expect(third.nextCursor).toBeNull();
      const all = await h.ledger.listEntries({ ownerRef: accountId }, { limit: 8 });
      expect(all.entries).toHaveLength(8);
      expect(all.nextCursor).toBeNull();
      expect(all.entries[1]).toEqual(written.find((e) => e.id === expected[0]));
      expect((await h.ledger.listEntries()).entries).toHaveLength(8);
      expect((await h.ledger.listEntries(undefined, { limit: 500 })).entries).toHaveLength(8);
    });

    it("filters entries", async () => {
      const a = await openAccount(h.ledger);
      const b = await openAccount(h.ledger);
      await h.ledger.openPockets(a, "EURC", CHAIN);
      const agentId = newId("agent");
      const paymentId = newId("payment");
      const chainEventId = newId("chainEvent");
      const t0 = h.clock.now();
      const d1 = await deposit(h.ledger, a, 100n, "USDC", { chainEventId, refId: "cev_a" });
      h.clock.advance(1_000);
      const d2 = await deposit(h.ledger, b, 100n);
      const d3 = await deposit(h.ledger, a, 100n, "EURC");
      h.clock.advance(1_000);
      const hold = await placeHold(h, a, 30n, "operating", { agentId, paymentId, refId: paymentId });
      const post = await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        destinations: [{ to: operating(b), amount: 30n }],
      });
      const t3 = h.clock.advance(1_000);
      const ids = async (filter: Parameters<typeof h.ledger.listEntries>[0]) =>
        (await h.ledger.listEntries(filter)).entries.map((e) => e.id).sort();
      const sorted = (...entries: { id: string }[]) => entries.map((e) => e.id).sort();
      const reservationId = hold.entryId;
      const operatingA = await h.ledger.getAccount(operating(a));
      expect(await ids({ ownerRef: a })).toEqual(sorted(d1, d3, { id: reservationId }, post));
      expect(await ids({ ownerRef: b })).toEqual(sorted(d2, post));
      expect(await ids({ ownerRef: "system" })).toEqual(sorted(d1, d2, d3));
      expect(await ids({ ledgerAccountId: operatingA.id })).toEqual(sorted(d1, { id: reservationId }));
      expect(await ids({ ownerRef: a, asset: "EURC" })).toEqual(sorted(d3));
      expect(await ids({ ownerRef: b, asset: "EURC" })).toEqual([]);
      expect(await ids({ asset: "EURC" })).toEqual(sorted(d3));
      expect(await ids({ kind: "hold_post" })).toEqual(sorted(post));
      expect(await ids({ refType: "payment" })).toEqual(sorted({ id: reservationId }, post));
      expect(await ids({ refType: "payment", refId: paymentId })).toEqual(
        sorted({ id: reservationId }, post),
      );
      expect(await ids({ refId: "cev_a" })).toEqual(sorted(d1));
      expect(await ids({ agentId })).toEqual(sorted({ id: reservationId }, post));
      expect(await ids({ paymentId })).toEqual(sorted({ id: reservationId }, post));
      expect(await ids({ holdId: hold.id })).toEqual(sorted({ id: reservationId }, post));
      expect(await ids({ chainEventId })).toEqual(sorted(d1));
      expect(await ids({ since: new Date(t0.getTime() + 1_000) })).toEqual(
        sorted(d2, d3, { id: reservationId }, post),
      );
      expect(await ids({ until: new Date(t0.getTime() + 1_000) })).toEqual(sorted(d1));
      expect(await ids({ since: t0, until: t3, ownerRef: b, kind: "direct" })).toEqual(sorted(d2));
      await rejects(h.ledger.listEntries({ kind: "nope" as never }), "invalid_request");
      await rejects(h.ledger.listEntries({ ownerRef: "" }), "invalid_request");
      await rejects(h.ledger.listEntries({ ownerRef: 7 as never }), "invalid_request");
      await rejects(h.ledger.listEntries({ since: "2026-01-01" as never }), "invalid_request");
      await rejects(h.ledger.listEntries(null as never), "invalid_request");
      await rejects(h.ledger.listEntries({}, { limit: 0 }), "invalid_request");
      await rejects(h.ledger.listEntries({}, { limit: 501 }), "invalid_request");
      const encode = (value: string) => Buffer.from(value).toString("base64url");
      const badCursors = [
        "%%%",
        encode("{"),
        encode("[]"),
        encode('["not a date","ent_1"]'),
        encode('["2026-10-11T12:00:00.000Z",7]'),
        encode('["2026-10-11T12:00:00.000Z",""]'),
        encode('[1,"ent_1"]'),
      ];
      for (const cursor of badCursors) {
        await rejects(h.ledger.listEntries({}, { cursor }), "invalid_request");
      }
      await rejects(h.ledger.listEntries({}, { cursor: 5 as never }), "invalid_request");
    });
  });

  describe("invariants and concurrency", () => {
    it("reports a clean ledger after a mixed workload", async () => {
      const empty = await h.ledger.verifyInvariants();
      expect(empty).toEqual({
        ok: true,
        checkedAt: h.clock.now(),
        accounts: 0,
        entries: 0,
        lines: 0,
        holds: 0,
        violations: [],
      });
      const a = await openAccount(h.ledger);
      const b = await openAccount(h.ledger);
      await deposit(h.ledger, a, 500n);
      const hold = await placeHold(h, a, 100n);
      await h.ledger.postHold({
        idempotencyKey: key(),
        holdId: hold.id,
        amount: 90n,
        destinations: [{ to: operating(b), amount: 90n }],
      });
      const voided = await placeHold(h, a, 50n);
      await h.ledger.voidHold({ idempotencyKey: key(), holdId: voided.id, reason: "denied" });
      await placeHold(h, a, 25n);
      const payout = await h.ledger.post({
        idempotencyKey: key(),
        refType: "payout",
        lines: [
          { account: operating(b), amount: -40n },
          { account: chain(), amount: 40n },
        ],
      });
      await h.ledger.reverse({ idempotencyKey: key(), entryId: payout.id, memo: "reorg" });
      const report = await h.ledger.verifyInvariants();
      expect(report.violations).toEqual([]);
      expect(report).toMatchObject({ ok: true, accounts: 17, entries: 8, holds: 3 });
      expect(report.lines).toBe(17);
    });

    it("never overdraws a balance under parallel holds", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const results = await Promise.allSettled(
        Array.from({ length: 25 }, () => placeHold(h, accountId, 10n)),
      );
      const placed = results.filter((r): r is PromiseFulfilledResult<Hold> => r.status === "fulfilled");
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(placed).toHaveLength(10);
      expect(failed.map((r) => (r.reason as { code?: string }).code)).toEqual(
        Array(15).fill("insufficient_funds"),
      );
      expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({
        operating: 0n,
        reserved: 100n,
      });
      expect((await h.ledger.verifyInvariants()).ok).toBe(true);
    });

    it("resolves racing writes on one hold or key exactly once", async () => {
      const accountId = await openAccount(h.ledger);
      await deposit(h.ledger, accountId, 100n);
      const hold = await placeHold(h, accountId, 100n);
      const racers = await Promise.allSettled([
        h.ledger.postHold({
          idempotencyKey: key(),
          holdId: hold.id,
          destinations: [{ to: chain(), amount: 100n }],
        }),
        h.ledger.voidHold({ idempotencyKey: key(), holdId: hold.id, reason: "timeout" }),
        h.ledger.postHold({
          idempotencyKey: key(),
          holdId: hold.id,
          amount: 1n,
          destinations: [{ to: chain(), amount: 1n }],
        }),
        h.ledger.expireHolds(new Date(h.clock.now().getTime() + 2 * HOUR)),
      ]);
      const wins = racers.filter((r) => r.status === "fulfilled" && r.value !== 0);
      expect(wins).toHaveLength(1);
      for (const loser of racers.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
        expect((loser.reason as { code?: string }).code).toBe("invalid_state");
      }
      const input = {
        idempotencyKey: key(),
        refType: "deposit",
        lines: [
          { account: chain(), amount: -9n },
          { account: operating(accountId), amount: 9n },
        ],
      };
      const replays = await Promise.all(Array.from({ length: 8 }, () => h.ledger.post(input)));
      expect(new Set(replays.map((e) => e.id)).size).toBe(1);
      const accounts = await Promise.all(
        Array.from({ length: 6 }, () => h.ledger.ensureAccount(revenueRef("EURC"))),
      );
      expect(new Set(accounts.map((a) => a.id)).size).toBe(1);
      expect((await h.ledger.verifyInvariants()).ok).toBe(true);
      const settled = await h.ledger.getHold(hold.id);
      expect(settled.status).not.toBe("pending");
      expect(await balanceOf(chain())).toBe(-100n + (settled.postedAmount ?? 0n) - 9n);
    });

    it("supports every asset it was configured with", () => {
      expect(ASSETS).toContain("EURC");
    });
  });
}
