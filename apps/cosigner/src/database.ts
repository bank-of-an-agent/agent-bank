import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqlClient, loadMigrations, migrate, type SqlClient } from "@agentbank/db";

/**
 * The co-signer's own database (never the API's). Migrations live in
 * `apps/cosigner/migrations`, next to both `src/` and the built `dist/`.
 */
export const COSIGNER_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Arbitrary constant key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 7_340_117;

/**
 * Apply the co-signer's migrations; returns the names applied. Runs in one
 * transaction holding an advisory lock, so replicas starting together
 * migrate one at a time.
 */
export async function migrateCosigner(db: SqlClient): Promise<string[]> {
  return db.transaction(
    async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      return migrate(tx, loadMigrations(COSIGNER_MIGRATIONS_DIR));
    },
    { isolation: "read committed", retries: 0 },
  );
}

/**
 * Connect to `COSIGNER_DATABASE_URL` (PostgreSQL, or `pglite://…` for local
 * development) with a statement timeout, so a stuck database makes the
 * co-signer refuse quickly instead of hanging.
 */
export async function openCosignerDatabase(url: string): Promise<SqlClient> {
  return createSqlClient(url, { max: 10, statementTimeoutMs: 3_000 });
}
