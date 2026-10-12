import { PGlite } from "@electric-sql/pglite";
import { migrate, PgClient, PgliteClient, type SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";

/**
 * Fresh, fully migrated databases for tests.
 *
 * - With `DATABASE_URL` pointing at a server (CI, or the docker compose Postgres 16), each call
 *   is `createTestDatabase()` from `@agentbank/db/testing` (an isolated schema), and `close()`
 *   drops that schema again.
 * - Otherwise each call is an in-process PGlite instance. Creating PGlite from scratch costs
 *   about two seconds (initdb), so we migrate one template per worker with the same client and
 *   migrations `createTestDatabase()` uses and load copies of its data directory (~0.3 s).
 */

const url = process.env.DATABASE_URL;
export const USING_POSTGRES_SERVER = url !== undefined && url !== "" && !url.startsWith("pglite://");

// Same type mapping as PgliteClient.create(): int8 → bigint, numeric → string.
const PARSERS = { 20: (value: string) => BigInt(value), 1700: (value: string) => value };

let template: Promise<File | Blob> | undefined;

function pgliteTemplate(): Promise<File | Blob> {
  template ??= (async () => {
    const pglite = await PGlite.create({ parsers: PARSERS });
    await migrate(new PgliteClient(pglite));
    const dump = await pglite.dumpDataDir("none");
    await pglite.close();
    return dump;
  })();
  return template;
}

export interface TestDatabase {
  db: SqlClient;
  close(): Promise<void>;
}

export async function freshDatabase(): Promise<TestDatabase> {
  if (USING_POSTGRES_SERVER) {
    const db = await createTestDatabase();
    const { rows } = await db.query<{ schema: string }>("SELECT current_schema() AS schema");
    const schema = rows[0]?.schema as string;
    return {
      db,
      close: async () => {
        await db.close();
        const admin = new PgClient({ connectionString: url as string, max: 1 });
        await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.close();
      },
    };
  }
  const db = new PgliteClient(await PGlite.create({ loadDataDir: await pgliteTemplate(), parsers: PARSERS }));
  return { db, close: () => db.close() };
}
