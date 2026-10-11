import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./client";

/**
 * Plain-SQL migrations, applied in filename order and recorded in
 * `schema_migrations`. Each file runs in its own transaction. Files are
 * owned by domain: 0001_ledger, 0002_core, 0003_chain, 0004_x402, …
 */

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

export interface Migration {
  name: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export async function migrate(client: SqlClient, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  await client.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    await client.transaction(
      async (tx) => {
        await tx.exec(m.sql);
        await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
      },
      { isolation: "read committed", retries: 0 },
    );
    ran.push(m.name);
  }
  return ran;
}
