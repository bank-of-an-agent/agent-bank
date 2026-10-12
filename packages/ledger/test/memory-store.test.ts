import { newId } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import {
  chainRef,
  InMemoryLedger,
  pocketRef,
  revenueRef,
  type Hold,
  type JournalEntry,
  type LedgerAccount,
} from "../src";
import type { StoreTx } from "../src/store";
import { CHAIN, deposit, key, memoryHarness, openAccount, placeHold } from "./support/harness";

/**
 * InMemoryLedger-only behaviour: a failed write leaves no trace, the store re-asserts the
 * constraints PostgreSQL enforces, and verifyInvariants finds corruption of its state.
 */

interface MemoryInternals {
  write<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  accounts: Map<string, LedgerAccount>;
  entriesById: Map<string, JournalEntry>;
  holds: Map<string, Hold>;
}

function internals(ledger: unknown): MemoryInternals {
  return (ledger as { store: MemoryInternals }).store;
}

describe("InMemoryLedger storage", () => {
  it("undoes every write of a failed operation", async () => {
    const h = await memoryHarness();
    const accountId = await openAccount(h.ledger);
    await deposit(h.ledger, accountId, 100n);
    const hold = await placeHold(h, accountId, 30n);
    const store = internals(h.ledger);
    const revenue = await h.ledger.ensureAccount(revenueRef("USDC"));
    const before = await h.ledger.verifyInvariants();
    const entry: JournalEntry = {
      ...(await h.ledger.getEntry(hold.entryId)),
      id: newId("entry"),
      idempotencyKey: key(),
    };
    await expect(
      store.write(async (tx) => {
        await tx.insertAccounts([{ ...revenue, id: newId("ledgerAccount"), code: "sys:suspense" }]);
        await tx.insertEntry({ ...entry, kind: "direct", holdId: null });
        await tx.updateHold({
          ...hold,
          status: "voided",
          voidReason: "x",
          resolutionEntryId: entry.id,
          resolvedAt: new Date(),
        });
        const second = newId("hold");
        await tx.insertHold({ ...hold, id: second, idempotencyKey: key() });
        expect(await tx.dueHoldIds(new Date(Date.parse("2100-01-01")), null)).toContain(second);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const after = await h.ledger.verifyInvariants();
    expect({ ...after, checkedAt: null }).toEqual({ ...before, checkedAt: null });
    expect(await h.ledger.getHold(hold.id)).toEqual(hold);
    expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({ operating: 70n, reserved: 30n });
    expect(await h.ledger.balance(revenueRef("USDC"))).toBe(0n);
    await expect(h.ledger.getAccount({ ...revenue, code: "sys:suspense" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await h.ledger.listEntries({ ownerRef: accountId })).entries).toHaveLength(2);
    expect(await h.ledger.expireHolds(new Date(Date.parse("2100-01-01")))).toBe(1);
  });

  it("re-asserts the database constraints on every write", async () => {
    const h = await memoryHarness();
    const accountId = await openAccount(h.ledger);
    const entry = await deposit(h.ledger, accountId, 100n);
    const hold = await placeHold(h, accountId, 30n);
    const store = internals(h.ledger);
    const [chainLine, pocketLine] = entry.lines as [JournalEntry["lines"][0], JournalEntry["lines"][0]];
    const write = (fn: (tx: StoreTx) => Promise<void>) => store.write(fn);
    const fresh = (patch: Partial<JournalEntry>): JournalEntry => ({
      ...entry,
      id: newId("entry"),
      idempotencyKey: key(),
      ...patch,
    });
    const attempts: [string, (tx: StoreTx) => Promise<void>][] = [
      ["duplicate", (tx) => tx.insertEntry({ ...entry })],
      ["duplicate", (tx) => tx.insertEntry(fresh({ idempotencyKey: entry.idempotencyKey }))],
      [
        "does not balance",
        (tx) => tx.insertEntry(fresh({ lines: [chainLine, { ...pocketLine, amount: 99n }] })),
      ],
      ["does not balance", (tx) => tx.insertEntry(fresh({ lines: [] }))],
      ["invalid line", (tx) => tx.insertEntry(fresh({ lines: [chainLine, { ...pocketLine, amount: 0n }] }))],
      [
        "invalid line",
        (tx) =>
          tx.insertEntry(
            fresh({ lines: [chainLine, { ...pocketLine, ledgerAccountId: newId("ledgerAccount") }] }),
          ),
      ],
      [
        "invalid line",
        (tx) => tx.insertEntry(fresh({ lines: [chainLine, { ...pocketLine, asset: "EURC" }] })),
      ],
      [
        "would go negative",
        (tx) =>
          tx.insertEntry(
            fresh({
              lines: [
                { ...chainLine, amount: 500n },
                { ...pocketLine, amount: -500n },
              ],
            }),
          ),
      ],
      ["duplicate hold", (tx) => tx.insertHold(hold)],
    ];
    for (const [message, attempt] of attempts) {
      await expect(write(attempt)).rejects.toThrow(message);
    }
    const reversal = await h.ledger.reverse({
      idempotencyKey: key(),
      entryId: (await deposit(h.ledger, accountId, 1n)).id,
      memo: "x",
    });
    await expect(
      write((tx) =>
        tx.insertEntry(
          fresh({ kind: "reversal", reversesEntryId: reversal.reversesEntryId, lines: reversal.lines }),
        ),
      ),
    ).rejects.toThrow("already reversed");
    expect((await h.ledger.verifyInvariants()).ok).toBe(true);
  });

  it("uses the system clock and the core asset list by default", async () => {
    const ledger = new InMemoryLedger();
    const before = Date.now();
    const account = await ledger.ensureAccount(chainRef(CHAIN, "USDC"));
    expect(account.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    await expect(ledger.ensureAccount(chainRef(CHAIN, "EURC"))).rejects.toMatchObject({
      code: "unsupported_asset",
    });
  });

  it("returns copies that callers cannot use to change the ledger", async () => {
    const h = await memoryHarness();
    const accountId = await openAccount(h.ledger);
    const entry = await deposit(h.ledger, accountId, 100n);
    (entry.lines[1] as { amount: bigint }).amount = 1_000_000n;
    entry.metadata.forged = "yes";
    const fetched = await h.ledger.getEntry(entry.id);
    expect(fetched.lines[1]?.amount).toBe(100n);
    expect(fetched.metadata).toEqual({});
    const account = await h.ledger.getAccount(pocketRef(accountId, "operating", "USDC"));
    account.balance = 5n;
    expect(await h.ledger.balance(pocketRef(accountId, "operating", "USDC"))).toBe(100n);
  });
});

describe("InMemoryLedger verifyInvariants on corrupted state", () => {
  it("reports every kind of violation", async () => {
    const h = await memoryHarness();
    const accountId = await openAccount(h.ledger);
    const other = await openAccount(h.ledger);
    const first = await deposit(h.ledger, accountId, 1_000n);
    const second = await deposit(h.ledger, other, 500n);
    const third = await deposit(h.ledger, other, 300n);
    const posted = await placeHold(h, accountId, 100n);
    const pending = await placeHold(h, accountId, 50n);
    const voided = await placeHold(h, other, 10n);
    await h.ledger.voidHold({ idempotencyKey: key(), holdId: voided.id, reason: "x" });
    const account = (pocket: string, owner = accountId) =>
      h.ledger.getAccount(pocketRef(owner, pocket as never, "USDC"));
    const fees = await account("fees");
    const savings = await account("savings");
    const spare = await account("savings", other);
    expect((await h.ledger.verifyInvariants()).ok).toBe(true);

    const store = internals(h.ledger);
    const [, secondPocket] = second.lines as [JournalEntry["lines"][0], JournalEntry["lines"][0]];
    const chain = await h.ledger.getAccount(chainRef(CHAIN, "USDC"));
    const fake = newId("entry");
    await store.write((tx) =>
      tx.insertEntry({
        ...second,
        id: fake,
        idempotencyKey: key(),
        kind: "reversal",
        reversesEntryId: second.id,
        lines: [
          { ledgerAccountId: chain.id, ownerRef: "system", code: chain.code, asset: "USDC", amount: 7n },
          { ...secondPocket, amount: -7n },
        ],
      }),
    );
    (store.accounts.get(fees.id) as LedgerAccount).balance += 3n;
    (store.accounts.get(savings.id) as LedgerAccount).balance = -5n;
    const thirdStored = store.entriesById.get(third.id) as JournalEntry;
    thirdStored.lines.push({
      ledgerAccountId: spare.id,
      ownerRef: other,
      code: spare.code,
      asset: "USDC",
      amount: -9n,
    });
    const firstStored = store.entriesById.get(first.id) as JournalEntry;
    firstStored.lines = firstStored.lines.filter((line) => line.amount < 0n);
    const postedStored = store.holds.get(posted.id) as Hold;
    store.holds.set(posted.id, {
      ...postedStored,
      status: "posted",
      postedAmount: 100n,
      resolutionEntryId: posted.entryId,
      resolvedAt: new Date(),
    });
    store.holds.set(pending.id, { ...(store.holds.get(pending.id) as Hold), entryId: third.id });
    const voidedStored = store.holds.get(voided.id) as Hold;
    store.holds.set(voided.id, { ...voidedStored, resolutionEntryId: null });

    const report = await h.ledger.verifyInvariants();
    expect(report.ok).toBe(false);
    const operatingA = (first.lines[1] as JournalEntry["lines"][0]).ledgerAccountId;
    const expected: [string, string][] = [
      ["entry_balanced", first.id],
      ["entry_balanced", third.id],
      ["entry_lines", first.id],
      ["entry_lines", third.id],
      ["cached_balance", fees.id],
      ["cached_balance", savings.id],
      ["cached_balance", operatingA],
      ["cached_balance", spare.id],
      ["non_negative", savings.id],
      ["non_negative", operatingA],
      ["non_negative", spare.id],
      ["hold_entries", posted.id],
      ["hold_entries", pending.id],
      ["hold_entries", voided.id],
      ["reserve_matches_holds", posted.reserveAccountId],
      ["reversal_mirrors_original", fake],
    ];
    const order = (a: [string, string], b: [string, string]) =>
      a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    expect(report.violations.map((v) => [v.invariant, v.subject])).toEqual(expected.sort(order));
    expect(report.violations.find((v) => v.subject === voided.id)?.detail).toBe(
      "voided hold lacks a matching hold_void entry (has none)",
    );
    expect(
      report.violations.find((v) => v.invariant === "entry_lines" && v.subject === third.id)?.detail,
    ).toBe("has 3 lines, expected 2");

    store.holds.set(pending.id, { ...(store.holds.get(pending.id) as Hold), resolutionEntryId: first.id });
    const pendingDetails = (await h.ledger.verifyInvariants()).violations
      .filter((v) => v.subject === pending.id)
      .map((v) => v.detail);
    expect(pendingDetails).toContain(`pending hold has resolution entry ${first.id}`);
  });
});
