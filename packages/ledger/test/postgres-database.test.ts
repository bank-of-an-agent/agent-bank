import { newId } from "@agentbank/core";
import type { QueryResult, SqlClient, SqlParam, TransactionOptions } from "@agentbank/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainRef, pocketRef, PostgresLedger, revenueRef, type JournalEntry } from "../src";
import {
  ASSETS,
  CHAIN,
  deposit,
  HOUR,
  key,
  openAccount,
  placeHold,
  postgresHarness,
  type Harness,
} from "./support/harness";
import { USING_POSTGRES_SERVER } from "./support/database";

/**
 * PostgreSQL-only behaviour: what the schema guarantees on its own (even against raw SQL),
 * ledgers that join a caller's transaction, and the invariant checker finding corruption.
 */

let h: Harness;
let db: SqlClient;

beforeEach(async () => {
  h = await postgresHarness();
  db = h.db as SqlClient;
});

afterEach(async () => {
  await h.close();
});

async function sqlError(
  run: () => Promise<unknown>,
): Promise<Error & { code?: string; constraint?: string }> {
  const error: unknown = await run().then(
    () => new Error("expected the statement to fail"),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toBe("expected the statement to fail");
  return error as Error & { code?: string };
}

const ACCOUNT_COLUMNS = "id, owner_ref, code, asset, chain_id, location, allow_negative, created_at";

async function insertAccount(values: {
  ownerRef: string;
  code: string;
  chainId?: number | null;
  location: string;
  allowNegative?: boolean;
  balance?: bigint;
}): Promise<QueryResult<unknown>> {
  return db.query(
    `INSERT INTO ledger_account (${ACCOUNT_COLUMNS}, balance) VALUES ($1, $2, $3, 'USDC', $4, $5, $6, now(), $7)`,
    [
      newId("ledgerAccount"),
      values.ownerRef,
      values.code,
      values.chainId === undefined ? CHAIN : values.chainId,
      values.location,
      values.allowNegative ?? false,
      values.balance ?? 0n,
    ],
  );
}

/** Write an entry with raw SQL, bypassing the library. */
async function rawEntry(
  tx: SqlClient,
  lines: { accountId: string; ownerRef: string; amount: bigint }[],
  extra: { kind?: string; reverses?: string | null; lineCount?: number } = {},
): Promise<string> {
  const id = newId("entry");
  const at = new Date();
  await tx.query(
    `INSERT INTO journal_entry (id, kind, idempotency_key, request_hash, ref_type, reverses_entry_id, line_count, created_at)
     VALUES ($1, $2, $3, 'raw', 'raw', $4, $5, $6)`,
    [id, extra.kind ?? "direct", key("raw"), extra.reverses ?? null, extra.lineCount ?? lines.length, at],
  );
  for (const line of lines) {
    await tx.query(
      `INSERT INTO journal_line (entry_id, ledger_account_id, owner_ref, asset, amount, created_at)
       VALUES ($1, $2, $3, 'USDC', $4, $5)`,
      [id, line.accountId, line.ownerRef, line.amount, at],
    );
  }
  return id;
}

describe("database guarantees", () => {
  it("keeps the journal append-only", async () => {
    const accountId = await openAccount(h.ledger);
    const entry = await deposit(h.ledger, accountId, 10n);
    const statements = [
      ["UPDATE journal_entry SET memo = 'edited' WHERE id = $1", [entry.id]],
      ["DELETE FROM journal_entry WHERE id = $1", [entry.id]],
      ["UPDATE journal_line SET amount = amount * 2 WHERE entry_id = $1", [entry.id]],
      ["DELETE FROM journal_line WHERE entry_id = $1", [entry.id]],
      ["TRUNCATE journal_line", []],
      ["TRUNCATE journal_entry CASCADE", []],
      ["TRUNCATE ledger_account CASCADE", []],
      ["TRUNCATE hold CASCADE", []],
    ] as const;
    for (const [sql, params] of statements) {
      const error = await sqlError(() => db.query(sql, params as unknown as SqlParam[]));
      expect(error.message).toMatch(/append-only/);
    }
    expect(await h.ledger.getEntry(entry.id)).toEqual(entry);
  });

  it("refuses an unbalanced entry at commit", async () => {
    const accountId = await openAccount(h.ledger);
    const chain = await h.ledger.ensureAccount(chainRef(CHAIN, "USDC"));
    const operating = await h.ledger.getAccount(pocketRef(accountId, "operating", "USDC"));
    let inserted = false;
    const error = await sqlError(() =>
      db.transaction(async (tx) => {
        await rawEntry(tx, [
          { accountId: chain.id, ownerRef: "system", amount: -100n },
          { accountId: operating.id, ownerRef: accountId, amount: 90n },
        ]);
        inserted = true;
      }),
    );
    expect(inserted).toBe(true);
    expect(error.message).toMatch(/does not balance: USDC -10/);
    expect(await h.ledger.balance(operating)).toBe(0n);
    expect((await h.ledger.listEntries()).entries).toEqual([]);
  });

  it("refuses lines added to an existing entry", async () => {
    const accountId = await openAccount(h.ledger);
    const entry = await deposit(h.ledger, accountId, 100n);
    const [chainLine, pocketLine] = entry.lines as [JournalEntry["lines"][0], JournalEntry["lines"][0]];
    const error = await sqlError(() =>
      db.transaction(async (tx) => {
        for (const [line, amount] of [
          [chainLine, -5n],
          [pocketLine, 5n],
        ] as const) {
          await tx.query(
            `INSERT INTO journal_line (entry_id, ledger_account_id, owner_ref, asset, amount, created_at)
             VALUES ($1, $2, $3, 'USDC', $4, $5)`,
            [entry.id, line.ledgerAccountId, line.ownerRef, amount, entry.createdAt],
          );
        }
      }),
    );
    expect(error.message).toMatch(/has 4 lines but was written with 2/);
    expect(await h.ledger.getEntry(entry.id)).toEqual(entry);
  });

  it("refuses zero lines and lines that disagree with their account or entry", async () => {
    const accountId = await openAccount(h.ledger);
    const entry = await deposit(h.ledger, accountId, 100n);
    const line = entry.lines[1] as JournalEntry["lines"][0];
    const insertLine = (values: SqlParam[]) =>
      db.query(
        `INSERT INTO journal_line (entry_id, ledger_account_id, owner_ref, asset, amount, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        values,
      );
    expect(
      (
        await sqlError(() =>
          insertLine([entry.id, line.ledgerAccountId, accountId, "USDC", 0n, entry.createdAt]),
        )
      ).message,
    ).toMatch(/journal_line_amount_nonzero/);
    expect(
      (
        await sqlError(() =>
          insertLine([entry.id, line.ledgerAccountId, newId("account"), "USDC", 1n, entry.createdAt]),
        )
      ).message,
    ).toMatch(/journal_line_account_fk/);
    expect(
      (
        await sqlError(() =>
          insertLine([entry.id, line.ledgerAccountId, accountId, "EURC", 1n, entry.createdAt]),
        )
      ).message,
    ).toMatch(/journal_line_account_fk/);
    expect(
      (await sqlError(() => insertLine([entry.id, line.ledgerAccountId, accountId, "USDC", 1n, new Date(0)])))
        .message,
    ).toMatch(/journal_line_entry_fk/);
  });

  it("keeps cached balances a projection of the journal", async () => {
    const accountId = await openAccount(h.ledger);
    const operating = await h.ledger.getAccount(pocketRef(accountId, "operating", "USDC"));
    expect(
      (await sqlError(() => db.query("UPDATE ledger_account SET balance = 5 WHERE id = $1", [operating.id])))
        .message,
    ).toMatch(/changes only through journal lines/);
    expect(
      (
        await sqlError(() =>
          db.query("UPDATE ledger_account SET code = 'pocket:fees' WHERE id = $1", [operating.id]),
        )
      ).message,
    ).toMatch(/immutable/);
    expect(
      (await sqlError(() => db.query("DELETE FROM ledger_account WHERE id = $1", [operating.id]))).message,
    ).toMatch(/permanent/);
    expect(
      (
        await sqlError(() =>
          insertAccount({
            ownerRef: newId("account"),
            code: "pocket:fees",
            location: "smart_account",
            balance: 7n,
          }),
        )
      ).message,
    ).toMatch(/zero balance/);
  });

  it("never lets a pocket go negative", async () => {
    const accountId = await openAccount(h.ledger);
    await deposit(h.ledger, accountId, 10n);
    const chain = await h.ledger.getAccount(chainRef(CHAIN, "USDC"));
    const operating = await h.ledger.getAccount(pocketRef(accountId, "operating", "USDC"));
    const error = await sqlError(() =>
      db.transaction((tx) =>
        rawEntry(tx, [
          { accountId: operating.id, ownerRef: accountId, amount: -11n },
          { accountId: chain.id, ownerRef: "system", amount: 11n },
        ]),
      ),
    );
    expect(error.message).toMatch(/ledger_account_non_negative/);
    expect(
      (
        await sqlError(() =>
          insertAccount({
            ownerRef: newId("account"),
            code: "pocket:fees",
            location: "smart_account",
            allowNegative: true,
          }),
        )
      ).message,
    ).toMatch(/ledger_account_negative_only_system/);
  });

  it("checks account codes, owners, locations and chains", async () => {
    const owner = newId("account");
    const cases: [Parameters<typeof insertAccount>[0], RegExp][] = [
      [{ ownerRef: owner, code: "pocket:checking", location: "smart_account" }, /ledger_account_code_format/],
      [{ ownerRef: "bob", code: "pocket:fees", location: "smart_account" }, /ledger_account_owner_format/],
      [{ ownerRef: "system", code: "pocket:fees", location: "smart_account" }, /ledger_account_owner_kind/],
      [{ ownerRef: owner, code: "pocket:escrow", location: "smart_account" }, /ledger_account_location/],
      [
        { ownerRef: "system", code: `sys:chain:${CHAIN}:EURC`, location: "external", allowNegative: true },
        /ledger_account_chain/,
      ],
      [
        { ownerRef: "system", code: "sys:revenue", location: "revenue_address", allowNegative: true },
        /ledger_account_chain/,
      ],
      [
        {
          ownerRef: "system",
          code: "sys:chain:8453:USDC",
          chainId: 8453,
          location: "external",
          allowNegative: true,
        },
        /ledger_account_testnet_only/,
      ],
    ];
    for (const [values, pattern] of cases) {
      expect((await sqlError(() => insertAccount(values))).message).toMatch(pattern);
    }
    await insertAccount({
      ownerRef: "system",
      code: "sys:revenue",
      chainId: null,
      location: "revenue_address",
      allowNegative: true,
    });
  });

  it("guards the hold lifecycle", async () => {
    const accountId = await openAccount(h.ledger);
    await deposit(h.ledger, accountId, 100n);
    const hold = await placeHold(h, accountId, 40n);
    const other = await deposit(h.ledger, accountId, 1n);
    const statements: [string, SqlParam[], RegExp][] = [
      ["DELETE FROM hold WHERE id = $1", [hold.id], /permanent/],
      ["UPDATE hold SET amount = 1 WHERE id = $1", [hold.id], /only change its status/],
      [
        "UPDATE hold SET status = 'posted', posted_amount = 40, resolution_entry_id = $2, resolved_at = now() WHERE id = $1",
        [hold.id, other.id],
        /only become posted with its own hold_post entry/,
      ],
      [
        "UPDATE hold SET status = 'voided', resolution_entry_id = $2, resolved_at = now() WHERE id = $1",
        [hold.id, hold.entryId],
        /hold_void/,
      ],
    ];
    for (const [sql, params, pattern] of statements) {
      expect((await sqlError(() => db.query(sql, params))).message).toMatch(pattern);
    }
    const voided = await h.ledger.voidHold({ idempotencyKey: key(), holdId: hold.id, reason: "test" });
    expect(
      (
        await sqlError(() =>
          db.query("UPDATE hold SET status = 'expired', void_reason = NULL WHERE id = $1", [hold.id]),
        )
      ).message,
    ).toMatch(/already voided/);
    expect(
      (
        await sqlError(() =>
          db.query(
            "UPDATE hold SET status = 'pending', resolution_entry_id = NULL, resolved_at = NULL, void_reason = NULL WHERE id = $1",
            [hold.id],
          ),
        )
      ).message,
    ).toMatch(/re-opened by reversing/);
    expect((await h.ledger.getHold(hold.id)).resolutionEntryId).toBe(voided.id);
    const operating = await h.ledger.getAccount(pocketRef(accountId, "operating", "USDC"));
    const reserved = await h.ledger.getAccount(pocketRef(accountId, "reserved", "USDC"));
    const forged = (from: string, entryId: string) =>
      db.query(
        `INSERT INTO hold (id, idempotency_key, request_hash, owner_ref, asset, source, from_account_id, reserve_account_id,
                           amount, expires_at, entry_id, ref_type, created_at)
         VALUES ($1, $2, 'x', $3, 'USDC', 'operating', $4, $5, 1, now(), $6, 'payment', now())`,
        [newId("hold"), key("forged"), accountId, from, reserved.id, entryId],
      );
    expect((await sqlError(() => forged(operating.id, other.id))).message).toMatch(/own reservation entry/);
    const fees = await h.ledger.getAccount(pocketRef(accountId, "fees", "USDC"));
    for (const from of [reserved.id, fees.id]) {
      expect((await sqlError(() => forged(from, other.id))).message).toMatch(
        /must move funds from pocket:operating/,
      );
    }
  });
});

describe("transactions", () => {
  it("joins a caller's transaction and rolls back with it", async () => {
    const accountId = await openAccount(h.ledger);
    await expect(
      db.transaction(async (tx) => {
        const ledger = new PostgresLedger(tx, { clock: h.clock, assets: ASSETS });
        await deposit(ledger, accountId, 500n);
        await ledger.hold({
          idempotencyKey: key(),
          accountId,
          asset: "USDC",
          amount: 100n,
          from: "operating",
          expiresAt: new Date(h.clock.now().getTime() + HOUR),
          refType: "payment",
        });
        expect(await ledger.pocketBalances(accountId, "USDC")).toMatchObject({
          operating: 400n,
          reserved: 100n,
        });
        throw new Error("payment row failed to insert");
      }),
    ).rejects.toThrow("payment row failed to insert");
    expect(await h.ledger.pocketBalances(accountId, "USDC")).toMatchObject({ operating: 0n, reserved: 0n });
    expect((await h.ledger.verifyInvariants()).entries).toBe(0);

    const committed = await db.transaction(async (tx) => {
      const ledger = new PostgresLedger(tx, { clock: h.clock, assets: ASSETS });
      const entry = await deposit(ledger, accountId, 500n);
      expect((await ledger.verifyInvariants()).ok).toBe(true);
      return entry;
    });
    expect(await h.ledger.getEntry(committed.id)).toEqual(committed);
  });

  it("replays the winner when a concurrent writer took the idempotency key", async () => {
    const accountId = await openAccount(h.ledger);
    let raced = 0;
    const racing: SqlClient = {
      driver: db.driver,
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      async transaction<T>(fn: (tx: SqlClient) => Promise<T>, options?: TransactionOptions): Promise<T> {
        const result = await db.transaction(fn, options);
        raced += 1;
        if (raced === 1) {
          throw Object.assign(
            new Error('duplicate key value violates unique constraint "journal_entry_idempotency_key_key"'),
            {
              code: "23505",
              constraint: "journal_entry_idempotency_key_key",
            },
          );
        }
        return result;
      },
    };
    const ledger = new PostgresLedger(racing, { clock: h.clock, assets: ASSETS });
    const entry = await deposit(ledger, accountId, 10n);
    expect(raced).toBe(2);
    expect(await h.ledger.balance(pocketRef(accountId, "operating", "USDC"))).toBe(10n);
    expect(await h.ledger.getEntry(entry.id)).toEqual(entry);

    const failing: SqlClient = {
      ...racing,
      transaction: () => Promise.reject(new Error("connection reset")),
    };
    await expect(deposit(new PostgresLedger(failing, { assets: ASSETS }), accountId, 1n)).rejects.toThrow(
      "connection reset",
    );
  });

  it("uses the system clock and the core asset list by default", async () => {
    const ledger = new PostgresLedger(db);
    const before = Date.now();
    const account = await ledger.ensureAccount(revenueRef("USDC"));
    expect(account.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    await expect(ledger.ensureAccount(revenueRef("EURC"))).rejects.toMatchObject({
      code: "unsupported_asset",
    });
  });
});

describe("contention", () => {
  /** Wrap a client so every query error inside a ledger transaction is counted by SQLSTATE. */
  function observed(client: SqlClient, seen: Map<string, number>): SqlClient {
    const count = (error: unknown): never => {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) seen.set(code, (seen.get(code) ?? 0) + 1);
      throw error;
    };
    const wrap = (tx: SqlClient): SqlClient => ({
      driver: tx.driver,
      query: <T>(sql: string, params?: readonly SqlParam[]) => tx.query<T>(sql, params).catch(count),
      exec: (sql) => tx.exec(sql).catch(count),
      transaction: <T>(fn: (inner: SqlClient) => Promise<T>) => fn(wrap(tx)),
      close: () => tx.close(),
    });
    return {
      driver: client.driver,
      query: <T>(sql: string, params?: readonly SqlParam[]) => client.query<T>(sql, params),
      exec: (sql) => client.exec(sql),
      close: () => client.close(),
      transaction: <T>(fn: (tx: SqlClient) => Promise<T>, options?: TransactionOptions) =>
        client.transaction<T>((tx) => fn(wrap(tx)), options).catch(count),
    };
  }

  it("retries serialization failures and never overdraws under heavy contention", async () => {
    const seen = new Map<string, number>();
    const ledger = new PostgresLedger(observed(db, seen), { clock: h.clock, assets: ASSETS, retries: 200 });
    const payer = await openAccount(ledger);
    const payees = await Promise.all(Array.from({ length: 4 }, () => openAccount(ledger)));
    await deposit(ledger, payer, 1_000n);
    const results = await Promise.allSettled([
      ...Array.from({ length: 40 }, (_, i) =>
        ledger.hold({
          idempotencyKey: key(),
          accountId: payer,
          asset: "USDC",
          amount: 40n + BigInt(i % 3),
          from: "operating",
          expiresAt: new Date(h.clock.now().getTime() + HOUR),
          refType: "payment",
        }),
      ),
      ...payees.map((payee) => deposit(ledger, payee, 5n)),
    ]);
    const holds = results.slice(0, 40).filter((r) => r.status === "fulfilled");
    const refused = results.slice(0, 40).filter((r) => r.status === "rejected");
    for (const failure of refused) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: "insufficient_funds" });
    }
    expect(results.slice(40).every((r) => r.status === "fulfilled")).toBe(true);
    const pockets = await ledger.pocketBalances(payer, "USDC");
    expect(pockets.operating).toBeGreaterThanOrEqual(0n);
    expect(pockets.operating).toBeLessThan(42n);
    expect(pockets.operating + pockets.reserved).toBe(1_000n);
    expect(holds.length).toBeGreaterThanOrEqual(23);
    expect(await ledger.balance(chainRef(CHAIN, "USDC"))).toBe(-1_020n);
    expect((await ledger.verifyInvariants()).ok).toBe(true);
    const conflicts = (seen.get("40001") ?? 0) + (seen.get("40P01") ?? 0);
    console.log(
      `[ledger contention] ${db.driver}: ${holds.length} holds placed, ${refused.length} refused, ${conflicts} serialization failures retried`,
    );
    if (USING_POSTGRES_SERVER) expect(conflicts).toBeGreaterThan(0);
    expect([...seen.keys()].every((code) => ["40001", "40P01"].includes(code))).toBe(true);
  });
});

describe("verifyInvariants on a corrupted database", () => {
  it("reports every kind of violation", async () => {
    const accountId = await openAccount(h.ledger);
    const other = await openAccount(h.ledger);
    const first = await deposit(h.ledger, accountId, 1_000n);
    const second = await deposit(h.ledger, other, 500n);
    const third = await deposit(h.ledger, other, 300n);
    const posted = await placeHold(h, accountId, 100n);
    const pending = await placeHold(h, accountId, 50n);
    const account = (pocket: string, owner = accountId) =>
      h.ledger.getAccount(pocketRef(owner, pocket as never, "USDC"));
    const fees = await account("fees");
    const savings = await account("savings");
    const spare = await account("savings", other);
    const chain = await h.ledger.getAccount(chainRef(CHAIN, "USDC"));
    expect((await h.ledger.verifyInvariants()).ok).toBe(true);

    // A reversal that does not mirror its original (balanced, so the database accepts it).
    const fake = await db.transaction((tx) =>
      rawEntry(
        tx,
        [
          { accountId: chain.id, ownerRef: "system", amount: 7n },
          {
            accountId: (second.lines[1] as JournalEntry["lines"][0]).ledgerAccountId,
            ownerRef: other,
            amount: -7n,
          },
        ],
        { kind: "reversal", reverses: second.id },
      ),
    );
    await db.exec(`
      ALTER TABLE ledger_account DISABLE TRIGGER USER;
      ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_non_negative;
      ALTER TABLE journal_line DISABLE TRIGGER USER;
      ALTER TABLE hold DISABLE TRIGGER USER;
    `);
    await db.query("UPDATE ledger_account SET balance = balance + 3 WHERE id = $1", [fees.id]);
    await db.query("UPDATE ledger_account SET balance = -5 WHERE id = $1", [savings.id]);
    await db.query(
      `INSERT INTO journal_line (entry_id, ledger_account_id, owner_ref, asset, amount, created_at)
       VALUES ($1, $2, $3, 'USDC', -9, $4)`,
      [third.id, spare.id, other, third.createdAt],
    );
    await db.query("DELETE FROM journal_line WHERE entry_id = $1 AND amount > 0", [first.id]);
    await db.query(
      "UPDATE hold SET status = 'posted', posted_amount = 100, resolution_entry_id = entry_id, resolved_at = now() WHERE id = $1",
      [posted.id],
    );
    await db.query("UPDATE hold SET entry_id = $2 WHERE id = $1", [pending.id, third.id]);

    const report = await h.ledger.verifyInvariants();
    expect(report.ok).toBe(false);
    const operatingA = (first.lines[1] as JournalEntry["lines"][0]).ledgerAccountId;
    const reservedA = posted.reserveAccountId;
    expect(report.violations.map((v) => [v.invariant, v.subject])).toEqual(
      [
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
        ["reserve_matches_holds", reservedA],
        ["reversal_mirrors_original", fake],
      ].sort((a, b) =>
        a[0] !== b[0]
          ? (a[0] as string) < (b[0] as string)
            ? -1
            : 1
          : (a[1] as string) < (b[1] as string)
            ? -1
            : 1,
      ),
    );
    expect(report.violations.find((v) => v.subject === posted.id)?.detail).toMatch(
      /posted hold lacks a matching hold_post entry/,
    );
    expect(report.violations.find((v) => v.subject === pending.id)?.detail).toMatch(
      /does not reserve this hold/,
    );
    expect(
      report.violations.find((v) => v.invariant === "entry_lines" && v.subject === third.id)?.detail,
    ).toBe("has 3 lines, expected 2");
  });
});
