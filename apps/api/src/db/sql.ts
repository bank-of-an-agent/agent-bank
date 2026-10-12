import { AgentBankError, base64UrlToBytes, bytesToBase64Url, utf8 } from "@agentbank/core";
import type { SqlClient, SqlParam } from "@agentbank/db";

/** First row of a query, or undefined. */
export async function one<T>(
  db: SqlClient,
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<T | undefined> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}

/** First row of a query; `not_found` (404) when there is none. */
export async function mustFind<T>(
  db: SqlClient,
  sql: string,
  params: readonly SqlParam[],
  what: string,
): Promise<T> {
  const row = await one<T>(db, sql, params);
  if (!row) throw new AgentBankError("not_found", `${what} not found`);
  return row;
}

/** Rows of a query. */
export async function all<T>(db: SqlClient, sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
  const { rows } = await db.query<T>(sql, params);
  return rows;
}

// ---------------------------------------------------------------- keyset pagination

/**
 * Opaque cursor over `(created_at, id)` in descending order. Ids are ULIDs, but several rows
 * can share a millisecond, so the timestamp alone is not a total order; the pair is.
 */
export interface Cursor {
  createdAt: Date;
  id: string;
}

const CURSOR_ID_RE = /^[a-z0-9]+_[0-9A-HJKMNP-TV-Z]{26}$/;

export function encodeCursor(cursor: Cursor): string {
  return bytesToBase64Url(utf8(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id })));
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined || value === "") return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string" || !CURSOR_ID_RE.test(parsed.i)) {
      throw new Error("shape");
    }
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) throw new Error("time");
    return { createdAt, id: parsed.i };
  } catch {
    throw new AgentBankError("invalid_request", "Invalid pagination cursor");
  }
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Build a keyset page query: appends the cursor predicate, ordering and limit (limit + 1 rows
 * are fetched to know whether there is a next page). `alias` prefixes `created_at` and `id`.
 */
export function pageClause(cursor: Cursor | null, limit: number, params: SqlParam[], alias = ""): string {
  const p = alias ? `${alias}.` : "";
  let where = "";
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where = ` AND (${p}created_at, ${p}id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);
  return `${where} ORDER BY ${p}created_at DESC, ${p}id DESC LIMIT $${params.length}`;
}

export function toPage<T extends { id: string; created_at: Date }>(rows: T[], limit: number): PageResult<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
