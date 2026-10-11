import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/**
 * A deliberately small database interface. Every service talks to Postgres
 * through `SqlClient`, so the same code runs against a real PostgreSQL 16
 * (production, CI) and an in-process PGlite (unit tests, local sandbox).
 *
 * Type mapping is identical for both drivers:
 *   int8 / bigint  → bigint (money is never a JS number)
 *   numeric        → string
 *   timestamptz    → Date
 *   jsonb          → parsed JSON
 */

export type SqlParam = string | number | bigint | boolean | Date | null | Uint8Array | unknown[] | object;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export type IsolationLevel = "serializable" | "repeatable read" | "read committed";

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** Retries on serialization failures / deadlocks (SQLSTATE 40001, 40P01). Default 5. */
  retries?: number;
}

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<QueryResult<T>>;
  /** Run `fn` in a transaction. Nested calls reuse the outer transaction. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Execute a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly driver: "pg" | "pglite";
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;

const RETRYABLE = new Set(["40001", "40P01"]);

export function isRetryableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  if (e?.code !== "23505") return false;
  if (!constraint) return true;
  return e.constraint === constraint || (typeof e.message === "string" && e.message.includes(constraint));
}

function serializeParam(value: SqlParam): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    // Arrays of primitives map to Postgres arrays; anything else is JSON.
    return value.every((v) => v === null || ["string", "number", "boolean", "bigint"].includes(typeof v))
      ? value.map((v) => (typeof v === "bigint" ? v.toString() : v))
      : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  if (typeof value === "object") {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(retries: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retries) throw error;
      await sleep(Math.min(200, 5 * 2 ** attempt) + Math.floor(Math.random() * 10));
    }
  }
}

// ------------------------------------------------------------------ node-postgres

pg.types.setTypeParser(INT8_OID, (v: string) => BigInt(v));
pg.types.setTypeParser(NUMERIC_OID, (v: string) => v);

class PgTransactionClient implements SqlClient {
  readonly driver = "pg" as const;
  constructor(private readonly conn: pg.PoolClient) {}

  async query<T>(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult<T>> {
    const res = await this.conn.query(sql, params.map(serializeParam));
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async exec(sql: string): Promise<void> {
    await this.conn.query(sql);
  }

  async close(): Promise<void> {
    // Owned by the outer pool client.
  }
}

export interface PgClientOptions {
  connectionString: string;
  max?: number;
  /** Search path, e.g. an isolated schema for tests. */
  schema?: string;
  statementTimeoutMs?: number;
}

export class PgClient implements SqlClient {
  readonly driver = "pg" as const;
  private readonly pool: pg.Pool;

  constructor(options: PgClientOptions) {
    const settings: string[] = [];
    if (options.schema) settings.push(`-c search_path=${options.schema}`);
    if (options.statementTimeoutMs) settings.push(`-c statement_timeout=${options.statementTimeoutMs}`);
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ...(settings.length > 0 ? { options: settings.join(" ") } : {}),
    });
  }

  async query<T>(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params.map(serializeParam));
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const isolation = options.isolation ?? "serializable";
    return withRetries(options.retries ?? 5, async () => {
      const conn = await this.pool.connect();
      try {
        await conn.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
        const result = await fn(new PgTransactionClient(conn));
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        conn.release();
      }
    });
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ------------------------------------------------------------------ PGlite

type PGliteTx = Parameters<Parameters<PGlite["transaction"]>[0]>[0];

class PgliteTransactionClient implements SqlClient {
  readonly driver = "pglite" as const;
  constructor(private readonly tx: PGliteTx) {}

  async query<T>(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult<T>> {
    const res = await this.tx.query<T>(sql, params.map(serializeParam) as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async exec(sql: string): Promise<void> {
    await this.tx.exec(sql);
  }

  async close(): Promise<void> {
    // Owned by the outer PGlite instance.
  }
}

export class PgliteClient implements SqlClient {
  readonly driver = "pglite" as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PGlite) {}

  static async create(dataDir?: string): Promise<PgliteClient> {
    const db = await PGlite.create({
      ...(dataDir ? { dataDir } : {}),
      parsers: { [INT8_OID]: (v: string) => BigInt(v), [NUMERIC_OID]: (v: string) => v },
    });
    return new PgliteClient(db);
  }

  /** PGlite is single-connection: serialize work to mirror one-at-a-time commits. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async query<T>(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult<T>> {
    return this.enqueue(async () => {
      const res = await this.db.query<T>(sql, params.map(serializeParam) as unknown[]);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    });
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const isolation = options.isolation ?? "serializable";
    return this.enqueue(() =>
      withRetries(options.retries ?? 5, () =>
        this.db.transaction(async (tx) => {
          await tx.exec(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
          return fn(new PgliteTransactionClient(tx));
        }),
      ),
    );
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(() => this.db.exec(sql));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * Create a client from a connection string. `pglite://memory` (or an empty
 * string) gives an in-process database; `pglite:///path` persists to disk.
 */
export async function createSqlClient(url: string | undefined, options: Omit<PgClientOptions, "connectionString"> = {}): Promise<SqlClient> {
  if (!url || url === "pglite://memory") return PgliteClient.create();
  if (url.startsWith("pglite://")) return PgliteClient.create(url.slice("pglite://".length));
  return new PgClient({ connectionString: url, ...options });
}
