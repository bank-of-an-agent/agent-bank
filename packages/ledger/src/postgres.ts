import { isUniqueViolation, type SqlClient, type SqlParam } from "@agentbank/db";
import { LedgerEngine } from "./engine";
import { buildReport, RESOLUTION_KINDS, violation } from "./invariants";
import type { EntryKeyRecord, LedgerStore, StoreTx } from "./store";
import type {
  EntryKind,
  FundsLocation,
  Hold,
  HoldSource,
  HoldStatus,
  InvariantReport,
  InvariantViolation,
  JournalEntry,
  LedgerAccount,
  LedgerAccountRef,
  LedgerOptions,
} from "./types";
import type { EntryQuery } from "./validation";

/** Options of {@link PostgresLedger}. */
export interface PostgresLedgerOptions extends LedgerOptions {
  /**
   * How often a write is retried after a serialization failure or deadlock when the ledger
   * owns the transaction (default 10). Inside a caller's transaction the caller retries.
   */
  retries?: number;
}

/**
 * The production {@link Ledger}, on PostgreSQL 16 (or PGlite) through `SqlClient`, with the
 * schema from `packages/db/migrations/0001_ledger.sql`.
 *
 * Every write runs in a SERIALIZABLE transaction that locks the touched ledger accounts in id
 * order, and is retried on serialization failures, so concurrent holds against one balance
 * can never overdraw it. Construct it with a transaction client (the `tx` passed to
 * `SqlClient.transaction`) to make ledger writes part of a larger transaction: nested calls
 * join the caller's transaction, nothing commits until the caller does, and the caller's
 * `transaction()` retries the whole unit. The database independently enforces append-only
 * journal tables, zero-sum entries at commit, non-negative pockets and the hold lifecycle.
 */
export class PostgresLedger extends LedgerEngine {
  constructor(db: SqlClient, options: PostgresLedgerOptions = {}) {
    super(new PostgresStore(db, options.retries ?? 10), options);
  }
}

const ACCOUNT_COLUMNS = "id, owner_ref, code, asset, chain_id, location, allow_negative, balance, created_at";
const ENTRY_COLUMNS =
  "id, kind, idempotency_key, request_hash, ref_type, ref_id, memo, agent_id, payment_id, mandate_id, " +
  "decision_id, chain_event_id, hold_id, reverses_entry_id, metadata, created_at";
const HOLD_COLUMNS =
  "id, idempotency_key, request_hash, owner_ref, asset, source, from_account_id, reserve_account_id, amount, " +
  "posted_amount, status, expires_at, entry_id, resolution_entry_id, ref_type, ref_id, memo, agent_id, " +
  "payment_id, mandate_id, decision_id, metadata, void_reason, created_at, resolved_at";

interface AccountRow {
  id: string;
  owner_ref: string;
  code: string;
  asset: string;
  chain_id: number | null;
  location: FundsLocation;
  allow_negative: boolean;
  balance: bigint;
  created_at: Date;
}

interface EntryRow {
  id: string;
  kind: EntryKind;
  idempotency_key: string;
  request_hash: string;
  ref_type: string;
  ref_id: string | null;
  memo: string | null;
  agent_id: string | null;
  payment_id: string | null;
  mandate_id: string | null;
  decision_id: string | null;
  chain_event_id: string | null;
  hold_id: string | null;
  reverses_entry_id: string | null;
  metadata: Record<string, string>;
  created_at: Date;
}

interface LineRow {
  entry_id: string;
  ledger_account_id: string;
  owner_ref: string;
  code: string;
  asset: string;
  amount: bigint;
}

interface HoldRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  owner_ref: string;
  asset: string;
  source: HoldSource;
  from_account_id: string;
  reserve_account_id: string;
  amount: bigint;
  posted_amount: bigint | null;
  status: HoldStatus;
  expires_at: Date;
  entry_id: string;
  resolution_entry_id: string | null;
  ref_type: string;
  ref_id: string | null;
  memo: string | null;
  agent_id: string | null;
  payment_id: string | null;
  mandate_id: string | null;
  decision_id: string | null;
  metadata: Record<string, string>;
  void_reason: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toAccount(row: AccountRow): LedgerAccount {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    code: row.code,
    asset: row.asset,
    chainId: row.chain_id,
    location: row.location,
    allowNegative: row.allow_negative,
    balance: row.balance,
    createdAt: row.created_at,
  };
}

function toHold(row: HoldRow): Hold {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    accountId: row.owner_ref,
    asset: row.asset,
    from: row.source,
    fromAccountId: row.from_account_id,
    reserveAccountId: row.reserve_account_id,
    amount: row.amount,
    postedAmount: row.posted_amount,
    status: row.status,
    expiresAt: row.expires_at,
    entryId: row.entry_id,
    resolutionEntryId: row.resolution_entry_id,
    refType: row.ref_type,
    refId: row.ref_id,
    memo: row.memo,
    agentId: row.agent_id,
    paymentId: row.payment_id,
    mandateId: row.mandate_id,
    decisionId: row.decision_id,
    metadata: row.metadata,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** `($1, $2, …), ($n+1, …)` for `rows` tuples of `columns` parameters. */
function tuples(rows: number, columns: number): string {
  return Array.from(
    { length: rows },
    (_, row) =>
      `(${Array.from({ length: columns }, (_, column) => `$${row * columns + column + 1}`).join(", ")})`,
  ).join(", ");
}

/** `$1, $2, …, $count`. */
function list(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");
}

class SqlStoreTx implements StoreTx {
  constructor(private readonly db: SqlClient) {}

  async entryByKey(key: string): Promise<EntryKeyRecord | null> {
    const { rows } = await this.db.query<{
      id: string;
      kind: EntryKind;
      request_hash: string;
      hold_id: string | null;
    }>("SELECT id, kind, request_hash, hold_id FROM journal_entry WHERE idempotency_key = $1", [key]);
    const row = rows[0];
    return row ? { id: row.id, kind: row.kind, requestHash: row.request_hash, holdId: row.hold_id } : null;
  }

  async accountsByRefs(refs: readonly LedgerAccountRef[]): Promise<LedgerAccount[]> {
    if (refs.length === 0) return [];
    const { rows } = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ledger_account WHERE (owner_ref, code, asset) IN (${tuples(refs.length, 3)}) ORDER BY id`,
      refs.flatMap((ref) => [ref.ownerRef, ref.code, ref.asset]),
    );
    return rows.map(toAccount);
  }

  async accountsByOwner(ownerRef: string, asset: string | null): Promise<LedgerAccount[]> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ledger_account WHERE owner_ref = $1 AND ($2::text IS NULL OR asset = $2::text) ORDER BY code, asset`,
      [ownerRef, asset],
    );
    return rows.map(toAccount);
  }

  async insertAccounts(accounts: readonly LedgerAccount[]): Promise<void> {
    await this.db.query(
      `INSERT INTO ledger_account (id, owner_ref, code, asset, chain_id, location, allow_negative, created_at)
       VALUES ${tuples(accounts.length, 8)} ON CONFLICT (owner_ref, code, asset) DO NOTHING`,
      accounts.flatMap((a) => [
        a.id,
        a.ownerRef,
        a.code,
        a.asset,
        a.chainId,
        a.location,
        a.allowNegative,
        a.createdAt,
      ]),
    );
  }

  async lockAccounts(ids: readonly string[]): Promise<Map<string, LedgerAccount>> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ledger_account WHERE id IN (${list(ids.length)}) ORDER BY id FOR UPDATE`,
      ids,
    );
    return new Map(rows.map((row) => [row.id, toAccount(row)]));
  }

  async insertEntry(entry: JournalEntry): Promise<void> {
    await this.db.query(`INSERT INTO journal_entry (${ENTRY_COLUMNS}, line_count) VALUES (${list(17)})`, [
      entry.id,
      entry.kind,
      entry.idempotencyKey,
      entry.requestHash,
      entry.refType,
      entry.refId,
      entry.memo,
      entry.agentId,
      entry.paymentId,
      entry.mandateId,
      entry.decisionId,
      entry.chainEventId,
      entry.holdId,
      entry.reversesEntryId,
      entry.metadata,
      entry.createdAt,
      entry.lines.length,
    ]);
    // One statement, so the balance trigger sees only each account's net change.
    await this.db.query(
      `INSERT INTO journal_line (entry_id, ledger_account_id, owner_ref, asset, amount, created_at)
       VALUES ${tuples(entry.lines.length, 6)}`,
      entry.lines.flatMap((line) => [
        entry.id,
        line.ledgerAccountId,
        line.ownerRef,
        line.asset,
        line.amount,
        entry.createdAt,
      ]),
    );
  }

  async entries(ids: readonly string[]): Promise<JournalEntry[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM journal_entry WHERE id IN (${list(ids.length)})`,
      ids,
    );
    return this.withLines(rows);
  }

  /** Attach lines (in the order they were written) to entry rows, keeping the rows' order. */
  private async withLines(rows: readonly EntryRow[]): Promise<JournalEntry[]> {
    if (rows.length === 0) return [];
    const lines = await this.db.query<LineRow>(
      `SELECT l.entry_id, l.ledger_account_id, l.owner_ref, a.code, l.asset, l.amount
         FROM journal_line l JOIN ledger_account a ON a.id = l.ledger_account_id
        WHERE l.entry_id IN (${list(rows.length)}) ORDER BY l.id`,
      rows.map((row) => row.id),
    );
    const byEntry = new Map<string, JournalEntry["lines"]>(rows.map((row) => [row.id, []]));
    for (const line of lines.rows) {
      byEntry.get(line.entry_id)?.push({
        ledgerAccountId: line.ledger_account_id,
        ownerRef: line.owner_ref,
        code: line.code,
        asset: line.asset,
        amount: line.amount,
      });
    }
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      refType: row.ref_type,
      refId: row.ref_id,
      memo: row.memo,
      agentId: row.agent_id,
      paymentId: row.payment_id,
      mandateId: row.mandate_id,
      decisionId: row.decision_id,
      chainEventId: row.chain_event_id,
      metadata: row.metadata,
      holdId: row.hold_id,
      reversesEntryId: row.reverses_entry_id,
      lines: byEntry.get(row.id) ?? [],
      createdAt: row.created_at,
    }));
  }

  async reversalOf(entryId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT id FROM journal_entry WHERE reverses_entry_id = $1",
      [entryId],
    );
    return rows[0]?.id ?? null;
  }

  async hold(id: string, lock: boolean): Promise<Hold | null> {
    const { rows } = await this.db.query<HoldRow>(
      `SELECT ${HOLD_COLUMNS} FROM hold WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
    const row = rows[0];
    return row ? toHold(row) : null;
  }

  async insertHold(hold: Hold): Promise<void> {
    await this.db.query(`INSERT INTO hold (${HOLD_COLUMNS}) VALUES (${list(25)})`, [
      hold.id,
      hold.idempotencyKey,
      hold.requestHash,
      hold.accountId,
      hold.asset,
      hold.from,
      hold.fromAccountId,
      hold.reserveAccountId,
      hold.amount,
      hold.postedAmount,
      hold.status,
      hold.expiresAt,
      hold.entryId,
      hold.resolutionEntryId,
      hold.refType,
      hold.refId,
      hold.memo,
      hold.agentId,
      hold.paymentId,
      hold.mandateId,
      hold.decisionId,
      hold.metadata,
      hold.voidReason,
      hold.createdAt,
      hold.resolvedAt,
    ]);
  }

  async updateHold(hold: Hold): Promise<void> {
    await this.db.query(
      `UPDATE hold SET status = $2, posted_amount = $3, resolution_entry_id = $4, void_reason = $5, resolved_at = $6
        WHERE id = $1`,
      [hold.id, hold.status, hold.postedAmount, hold.resolutionEntryId, hold.voidReason, hold.resolvedAt],
    );
  }

  async dueHoldIds(now: Date, limit: number | null): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM hold WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at, id
        LIMIT $2::bigint`,
      [now, limit],
    );
    return rows.map((row) => row.id);
  }

  async balanceAt(accountId: string, at: Date): Promise<bigint> {
    const { rows } = await this.db.query<{ total: bigint }>(
      "SELECT coalesce(sum(amount), 0)::bigint AS total FROM journal_line WHERE ledger_account_id = $1 AND created_at <= $2",
      [accountId, at],
    );
    return rows[0]?.total ?? 0n;
  }

  async listEntries(query: EntryQuery): Promise<JournalEntry[]> {
    const params: SqlParam[] = [];
    const param = (value: SqlParam): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    const f = query.filter;
    const columns = {
      kind: "kind",
      refType: "ref_type",
      refId: "ref_id",
      agentId: "agent_id",
      paymentId: "payment_id",
      holdId: "hold_id",
      chainEventId: "chain_event_id",
    } as const;
    for (const [field, column] of Object.entries(columns) as [keyof typeof columns, string][]) {
      const value = f[field];
      if (value !== undefined) where.push(`e.${column} = ${param(value)}`);
    }
    if (f.since) where.push(`e.created_at >= ${param(f.since)}`);
    if (f.until) where.push(`e.created_at < ${param(f.until)}`);
    const onLine: string[] = [];
    if (f.ownerRef !== undefined) onLine.push(`l.owner_ref = ${param(f.ownerRef)}`);
    if (f.ledgerAccountId !== undefined) onLine.push(`l.ledger_account_id = ${param(f.ledgerAccountId)}`);
    if (f.asset !== undefined) onLine.push(`l.asset = ${param(f.asset)}`);
    if (onLine.length > 0) {
      where.push(`EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = e.id AND ${onLine.join(" AND ")})`);
    }
    if (query.cursor) {
      const at = param(query.cursor.createdAt);
      where.push(`(e.created_at < ${at} OR (e.created_at = ${at} AND e.id < ${param(query.cursor.id)}))`);
    }
    const { rows } = await this.db.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM journal_entry e ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${param(query.limit)}`,
      params,
    );
    return this.withLines(rows);
  }
}

class PostgresStore implements LedgerStore {
  constructor(
    private readonly db: SqlClient,
    private readonly retries: number,
  ) {}

  async write<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = () =>
      this.db.transaction((tx) => fn(new SqlStoreTx(tx)), {
        isolation: "serializable",
        retries: this.retries,
      });
    try {
      return await run();
    } catch (error) {
      // Two writers raced on one idempotency key and the loser saw a unique violation rather
      // than a serialization failure: run again, which now finds and replays the winner.
      if (
        isUniqueViolation(error, "journal_entry_idempotency_key_key") ||
        isUniqueViolation(error, "hold_idempotency_key_key")
      ) {
        return run();
      }
      throw error;
    }
  }

  read<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return fn(new SqlStoreTx(this.db));
  }

  verify(checkedAt: Date): Promise<InvariantReport> {
    return this.db.transaction((tx) => verifyInvariants(tx, checkedAt), { isolation: "repeatable read" });
  }
}

/** The SQL behind {@link Ledger.verifyInvariants}, run in one REPEATABLE READ snapshot. */
async function verifyInvariants(db: SqlClient, checkedAt: Date): Promise<InvariantReport> {
  const violations: InvariantViolation[] = [];
  const journal = `(SELECT ledger_account_id, sum(amount) AS total FROM journal_line GROUP BY ledger_account_id)`;

  const counts = await db.query<{ accounts: bigint; entries: bigint; lines: bigint; holds: bigint }>(
    `SELECT (SELECT count(*) FROM ledger_account) AS accounts, (SELECT count(*) FROM journal_entry) AS entries,
            (SELECT count(*) FROM journal_line) AS lines, (SELECT count(*) FROM hold) AS holds`,
  );

  const unbalanced = await db.query<{ entry_id: string; asset: string; total: string }>(
    `SELECT entry_id, asset, sum(amount)::text AS total FROM journal_line
      GROUP BY entry_id, asset HAVING sum(amount) <> 0`,
  );
  for (const row of unbalanced.rows)
    violations.push(violation.unbalanced(row.entry_id, row.asset, row.total));

  const lineCounts = await db.query<{ id: string; actual: number; expected: number }>(
    `SELECT e.id, count(l.id)::integer AS actual, e.line_count AS expected
       FROM journal_entry e LEFT JOIN journal_line l ON l.entry_id = e.id
      GROUP BY e.id, e.line_count HAVING count(l.id) <> e.line_count OR count(l.id) < 2`,
  );
  for (const row of lineCounts.rows) violations.push(violation.lineCount(row.id, row.actual, row.expected));

  const balances = await db.query<{
    id: string;
    code: string;
    allow_negative: boolean;
    cached: string;
    total: string;
    cached_matches: boolean;
    negative: boolean;
  }>(
    `SELECT a.id, a.code, a.allow_negative, a.balance::text AS cached, coalesce(j.total, 0)::text AS total,
            a.balance = coalesce(j.total, 0) AS cached_matches,
            NOT a.allow_negative AND (a.balance < 0 OR coalesce(j.total, 0) < 0) AS negative
       FROM ledger_account a LEFT JOIN ${journal} j ON j.ledger_account_id = a.id
      WHERE a.balance <> coalesce(j.total, 0) OR (NOT a.allow_negative AND (a.balance < 0 OR j.total < 0))`,
  );
  for (const row of balances.rows) {
    if (!row.cached_matches) violations.push(violation.cachedBalance(row.id, row.cached, row.total));
    if (row.negative) violations.push(violation.negative(row.id, row.cached, row.total));
  }

  const holds = await db.query<{
    id: string;
    status: HoldStatus;
    entry_id: string;
    resolution_entry_id: string | null;
    reservation_ok: boolean;
    resolution_ok: boolean;
  }>(
    `SELECT * FROM (
       SELECT h.id, h.status, h.entry_id, h.resolution_entry_id,
              coalesce(e.kind = 'hold' AND e.hold_id = h.id, false) AS reservation_ok,
              CASE WHEN h.status = 'pending' THEN h.resolution_entry_id IS NULL
                   ELSE coalesce(r.hold_id = h.id AND r.kind = CASE h.status
                          WHEN 'posted' THEN '${RESOLUTION_KINDS.posted}'
                          WHEN 'voided' THEN '${RESOLUTION_KINDS.voided}'
                          ELSE '${RESOLUTION_KINDS.expired}' END, false) END AS resolution_ok
         FROM hold h
         LEFT JOIN journal_entry e ON e.id = h.entry_id
         LEFT JOIN journal_entry r ON r.id = h.resolution_entry_id) AS checked
      WHERE NOT reservation_ok OR NOT resolution_ok`,
  );
  for (const row of holds.rows) {
    if (!row.reservation_ok) violations.push(violation.reservation(row.id, row.entry_id));
    if (!row.resolution_ok)
      violations.push(violation.resolution(row.id, row.status, row.resolution_entry_id));
  }

  const reserves = await db.query<{ id: string; total: string; pending: string }>(
    `SELECT a.id, coalesce(j.total, 0)::text AS total, coalesce(p.pending, 0)::text AS pending
       FROM ledger_account a
       LEFT JOIN ${journal} j ON j.ledger_account_id = a.id
       LEFT JOIN (SELECT reserve_account_id, sum(amount) AS pending FROM hold WHERE status = 'pending'
                   GROUP BY reserve_account_id) p ON p.reserve_account_id = a.id
      WHERE a.code IN ('pocket:reserved', 'pocket:spend_reserved')
        AND coalesce(j.total, 0) <> coalesce(p.pending, 0)`,
  );
  for (const row of reserves.rows) violations.push(violation.reserve(row.id, row.total, row.pending));

  const reversals = await db.query<{ id: string; reverses_entry_id: string }>(
    `WITH r AS (SELECT id, reverses_entry_id FROM journal_entry WHERE reverses_entry_id IS NOT NULL),
          mine AS (SELECT r.id, l.ledger_account_id, sum(l.amount) AS total
                     FROM r JOIN journal_line l ON l.entry_id = r.id GROUP BY r.id, l.ledger_account_id),
          theirs AS (SELECT r.id, l.ledger_account_id, -sum(l.amount) AS total
                       FROM r JOIN journal_line l ON l.entry_id = r.reverses_entry_id GROUP BY r.id, l.ledger_account_id),
          broken AS (SELECT DISTINCT coalesce(mine.id, theirs.id) AS id
                       FROM mine FULL JOIN theirs ON mine.id = theirs.id AND mine.ledger_account_id = theirs.ledger_account_id
                      WHERE mine.total IS DISTINCT FROM theirs.total)
     SELECT r.id, r.reverses_entry_id FROM r JOIN broken ON broken.id = r.id`,
  );
  for (const row of reversals.rows) violations.push(violation.reversal(row.id, row.reverses_entry_id));

  const count = counts.rows[0] as { accounts: bigint; entries: bigint; lines: bigint; holds: bigint };
  return buildReport(
    checkedAt,
    {
      accounts: Number(count.accounts),
      entries: Number(count.entries),
      lines: Number(count.lines),
      holds: Number(count.holds),
    },
    violations,
  );
}
