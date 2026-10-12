# @agentbank/db

PostgreSQL access for Agent Bank: one small `SqlClient` over node-postgres (production, CI) or
PGlite (in-process Postgres for tests and the local sandbox), serializable transactions with
retry, plain-SQL migrations and the webhook outbox.

Internal workspace package. See [ADR 0004](../../docs/adr/0004-sql-client-pglite.md).

## Usage

```ts
import { createSqlClient, migrate, emitEvent } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";

const db = await createSqlClient(process.env.DATABASE_URL); // "pglite://memory" when unset
await migrate(db);
await db.transaction(async (tx) => {
  /* serializable by default; retried on 40001/40P01 */
});
```

Both drivers map `int8` to `bigint` and `numeric` to `string`, so money never becomes a
JavaScript number.

## Migrations

`migrations/*.sql` run in filename order, each in its own transaction, recorded in
`schema_migrations`. Files are owned by domain: `0001_ledger`, `0002_core`, `0003_chain`,
`0004_x402`, `0005_api`. The co-signer and indexer keep their own migrations in their apps.

```bash
DATABASE_URL=postgres://agentbank:agentbank@127.0.0.1:54329/agentbank pnpm --filter @agentbank/db migrate
pnpm --filter @agentbank/db test                       # PGlite
DATABASE_URL=postgres://… pnpm --filter @agentbank/db test   # PostgreSQL 16 (isolated schema, dropped afterwards)
```
