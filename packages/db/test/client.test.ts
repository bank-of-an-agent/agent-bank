import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUniqueViolation, type SqlClient } from "../src/client";
import { migrate } from "../src/migrate";
import { createTestDatabase } from "../src/testing";

let db: SqlClient;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe("SqlClient", () => {
  it("maps int8 to bigint and numeric to string", async () => {
    const { rows } = await db.query<{ a: bigint; b: string }>(
      "SELECT 9223372036854775807::int8 AS a, 1.5::numeric AS b",
    );
    expect(rows[0]?.a).toBe(9_223_372_036_854_775_807n);
    expect(rows[0]?.b).toBe("1.5");
  });

  it("round-trips bigint, json and array params", async () => {
    const { rows } = await db.query<{ a: bigint; j: { x: string }; t: string[] }>(
      "SELECT $1::int8 AS a, $2::jsonb AS j, $3::text[] AS t",
      [123_456_789_012n, { x: "y" }, ["a", "b"]],
    );
    expect(rows[0]).toEqual({ a: 123_456_789_012n, j: { x: "y" }, t: ["a", "b"] });
  });

  it("commits and rolls back transactions", async () => {
    await db.exec("CREATE TABLE IF NOT EXISTS t_tx (id int PRIMARY KEY)");
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO t_tx VALUES (1)");
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO t_tx VALUES (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await db.query<{ id: number }>("SELECT id FROM t_tx ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("detects unique violations", async () => {
    await expect(db.query("INSERT INTO t_tx VALUES (1)")).rejects.toSatisfy((e: unknown) =>
      isUniqueViolation(e),
    );
  });

  it("migrations are idempotent and seed plans", async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ code: string; monthly_price: bigint }>(
      "SELECT code, monthly_price FROM plan ORDER BY monthly_price",
    );
    expect(rows.map((r) => [r.code, r.monthly_price])).toEqual([
      ["free", 0n],
      ["pro", 99_000_000n],
      ["business", 499_000_000n],
      ["enterprise", 4_000_000_000n],
    ]);
  });

  it("refuses mainnet accounts at the database level", async () => {
    await db.query(
      "INSERT INTO org (id, legal_name, kind, country, contact_email, owner_address) VALUES ('org_x','X','company','US','x@example.com','0x1')",
    );
    await expect(
      db.query(
        "INSERT INTO account (id, org_id, role, chain_id, address, owner_address, salt) VALUES ('acct_x','org_x','treasury',8453,'0xabc','0x1','0')",
      ),
    ).rejects.toThrow(/check/i);
  });

  it("refuses mainnet private-proof roots and malformed proof rows", async () => {
    const root = `0x${"ab".repeat(32)}`;
    const insertRoot = (chainId: number, epoch: number, value: string) =>
      db.query(
        `INSERT INTO proof_root (chain_id, root, epoch, snapshot_at, valid_until, leaf_count, status, created_at)
         VALUES ($1, $2, $3, now(), now() + interval '2 hours', 1, 'publishing', now())`,
        [chainId, value, epoch],
      );
    await expect(insertRoot(8453, 1, root)).rejects.toThrow(/check/i);
    await insertRoot(84532, 1, root);
    await expect(insertRoot(84532, 2, root)).rejects.toSatisfy((e: unknown) => isUniqueViolation(e));
    await expect(insertRoot(84532, 1, `0x${"cd".repeat(32)}`)).rejects.toSatisfy((e: unknown) =>
      isUniqueViolation(e),
    );
    await expect(insertRoot(84532, 3, "0xABC")).rejects.toThrow(/check/i);
    await expect(
      db.query("INSERT INTO proof_tree_state (chain_id, updated_at) VALUES (1, now())"),
    ).rejects.toThrow(/check/i);
    await db.query("INSERT INTO agent (id, org_id, name) VALUES ('agt_x', 'org_x', 'x')");
    await expect(
      db.query(
        `INSERT INTO proof_settings (agent_id, org_id, enabled, disclose, disclosure_mask, updated_at, updated_by)
         VALUES ('agt_x', 'org_x', true, ARRAY['balance', 'secrets'], 8, now(), 'test')`,
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO proof_settings (agent_id, org_id, enabled, disclose, disclosure_mask, updated_at, updated_by)
         VALUES ('agt_x', 'org_x', true, ARRAY['balance'], 8192, now(), 'test')`,
      ),
    ).rejects.toThrow(/check/i);
    const { rows } = await db.query<{ a: bigint | null; b: bigint | null }>(
      "SELECT resolution_payee_amount AS a, resolution_payer_amount AS b FROM escrow LIMIT 1",
    );
    expect(rows).toEqual([]);
  });

  it("keeps the audit log append-only", async () => {
    await db.query(
      "INSERT INTO audit_log (seq, at, actor, action, subject, payload, prev_hash, hash) VALUES (1, now(), 'a', 'b', 'c', '{}', '0x0', '0x1')",
    );
    await expect(db.query("UPDATE audit_log SET actor = 'evil'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
  });
});
