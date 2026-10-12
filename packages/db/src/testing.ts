import { createSqlClient, PgClient, PgliteClient, type SqlClient } from "./client";
import { migrate, type Migration } from "./migrate";

/**
 * A fresh, fully migrated database for a test file.
 * - With `DATABASE_URL` set (CI), creates an isolated schema on that server.
 * - Otherwise uses an in-process PGlite instance.
 */
export async function createTestDatabase(extraMigrations: Migration[] = []): Promise<SqlClient> {
  const url = process.env.DATABASE_URL;
  let client: SqlClient;
  if (url && !url.startsWith("pglite://")) {
    const schema = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new PgClient({ connectionString: url, max: 1 });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await admin.close();
    const pgClient = new PgClient({ connectionString: url, schema, max: 8 });
    const closePool = pgClient.close.bind(pgClient);
    // Closing a test database drops its schema so CI and dev servers don't accumulate them.
    pgClient.close = async () => {
      await closePool();
      const dropper = new PgClient({ connectionString: url, max: 1 });
      try {
        await dropper.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await dropper.close();
      }
    };
    client = pgClient;
  } else {
    client = await PgliteClient.create();
  }
  await migrate(client);
  if (extraMigrations.length > 0) await migrate(client, extraMigrations);
  return client;
}

export { createSqlClient };
