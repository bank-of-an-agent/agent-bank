import type { ChainEventInternal } from "@agentbank/core";
import { loadMigrations, migrate, type SqlClient, type SqlParam } from "@agentbank/db";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The indexer's own database (design: separate cloud account and database; it never touches
 * the ledger). Migrations live in `apps/indexer/migrations`, next to both `src/` and `dist/`.
 */
export const INDEXER_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

export async function migrateIndexer(db: SqlClient): Promise<string[]> {
  return migrate(db, loadMigrations(INDEXER_MIGRATIONS_DIR));
}

export interface StoredBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface DeferredEvent {
  event: ChainEventInternal;
  attempts: number;
  lastSentHead: bigint;
  lastSentFinalized: bigint;
}

interface BlockRow {
  block_number: bigint;
  block_hash: string;
  parent_hash: string;
  timestamp: bigint;
}

interface DeferredRow {
  event: ChainEventInternal;
  attempts: number;
  last_sent_head: bigint;
  last_sent_finalized: bigint;
}

export interface TickCommit {
  blocks: StoredBlock[];
  cursor: { number: bigint; hash: string } | null;
  /** Events the reconciler deferred in this tick (inserted or updated). */
  deferred: ChainEventInternal[];
  /** Events the reconciler accepted (removed from the deferred set). */
  settled: string[];
  head: bigint;
  finalized: bigint;
  /** Drop stored headers below this block. */
  pruneBelow: bigint;
}

function tuples(rows: number, columns: number, casts: Record<number, string> = {}): string {
  return Array.from(
    { length: rows },
    (_, r) =>
      `(${Array.from({ length: columns }, (_, c) => `$${r * columns + c + 1}${casts[c] ? `::${casts[c]}` : ""}`).join(", ")})`,
  ).join(", ");
}

export class IndexerStore {
  constructor(
    readonly db: SqlClient,
    readonly chainId: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async cursor(): Promise<{ number: bigint; hash: string } | null> {
    const { rows } = await this.db.query<{ block_number: bigint; block_hash: string }>(
      "SELECT block_number, block_hash FROM indexer_cursor WHERE chain_id = $1",
      [this.chainId],
    );
    const row = rows[0];
    return row ? { number: row.block_number, hash: row.block_hash } : null;
  }

  async block(number: bigint): Promise<StoredBlock | null> {
    const { rows } = await this.db.query<BlockRow>(
      "SELECT block_number, block_hash, parent_hash, timestamp FROM indexer_block WHERE chain_id = $1 AND block_number = $2",
      [this.chainId, number],
    );
    const row = rows[0];
    return row
      ? {
          number: row.block_number,
          hash: row.block_hash,
          parentHash: row.parent_hash,
          timestamp: Number(row.timestamp),
        }
      : null;
  }

  /** Stored headers above `number`, highest first. */
  async blocksAbove(number: bigint): Promise<StoredBlock[]> {
    const { rows } = await this.db.query<BlockRow>(
      `SELECT block_number, block_hash, parent_hash, timestamp FROM indexer_block
        WHERE chain_id = $1 AND block_number > $2 ORDER BY block_number DESC`,
      [this.chainId, number],
    );
    return rows.map((r) => ({
      number: r.block_number,
      hash: r.block_hash,
      parentHash: r.parent_hash,
      timestamp: Number(r.timestamp),
    }));
  }

  async lowestBlock(): Promise<bigint | null> {
    const { rows } = await this.db.query<{ n: bigint | null }>(
      "SELECT min(block_number) AS n FROM indexer_block WHERE chain_id = $1",
      [this.chainId],
    );
    return rows[0]?.n ?? null;
  }

  /** Record a processed range: headers, cursor and deferred-set changes, atomically. */
  async commitTick(commit: TickCommit): Promise<void> {
    const at = this.now();
    await this.db.transaction(async (tx) => {
      if (commit.blocks.length > 0) {
        const params: SqlParam[] = [];
        for (const b of commit.blocks)
          params.push(this.chainId, b.number, b.hash, b.parentHash, BigInt(b.timestamp), at);
        await tx.query(
          `INSERT INTO indexer_block (chain_id, block_number, block_hash, parent_hash, timestamp, created_at)
           VALUES ${tuples(commit.blocks.length, 6)}
           ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash,
             parent_hash = EXCLUDED.parent_hash, timestamp = EXCLUDED.timestamp, created_at = EXCLUDED.created_at`,
          params,
        );
      }
      if (commit.cursor) {
        await tx.query(
          `INSERT INTO indexer_cursor (chain_id, block_number, block_hash, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (chain_id) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash,
             updated_at = EXCLUDED.updated_at`,
          [this.chainId, commit.cursor.number, commit.cursor.hash, at],
        );
      }
      if (commit.settled.length > 0) {
        await tx.query("DELETE FROM indexer_deferred WHERE event_id = ANY($1::text[])", [commit.settled]);
      }
      for (let i = 0; i < commit.deferred.length; i += 500) {
        const chunk = commit.deferred.slice(i, i + 500);
        const params: SqlParam[] = [];
        for (const e of chunk) {
          params.push(
            e.id,
            this.chainId,
            BigInt(e.block_number),
            e.block_hash,
            e.tx_hash,
            e.log_index,
            JSON.stringify(e),
            commit.head,
            commit.finalized,
            at,
            at,
          );
        }
        await tx.query(
          `INSERT INTO indexer_deferred (event_id, chain_id, block_number, block_hash, tx_hash, log_index, event,
                                         last_sent_head, last_sent_finalized, first_deferred_at, updated_at)
           VALUES ${tuples(chunk.length, 11, { 6: "jsonb" })}
           ON CONFLICT (event_id) DO UPDATE SET event = EXCLUDED.event, attempts = indexer_deferred.attempts + 1,
             last_sent_head = EXCLUDED.last_sent_head, last_sent_finalized = EXCLUDED.last_sent_finalized,
             updated_at = EXCLUDED.updated_at`,
          params,
        );
      }
      await tx.query("DELETE FROM indexer_block WHERE chain_id = $1 AND block_number < $2", [
        this.chainId,
        commit.pruneBelow,
      ]);
    });
  }

  /**
   * Rewind to the common ancestor after a reorg: forget headers and deferred events above it and
   * remember the orphaned blocks until the replacement blocks have been pushed.
   */
  async rewind(ancestor: StoredBlock, orphaned: readonly StoredBlock[]): Promise<void> {
    const at = this.now();
    await this.db.transaction(async (tx) => {
      await tx.query("DELETE FROM indexer_block WHERE chain_id = $1 AND block_number > $2", [
        this.chainId,
        ancestor.number,
      ]);
      await tx.query("DELETE FROM indexer_deferred WHERE chain_id = $1 AND block_number > $2", [
        this.chainId,
        ancestor.number,
      ]);
      await tx.query(
        `INSERT INTO indexer_cursor (chain_id, block_number, block_hash, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (chain_id) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash,
           updated_at = EXCLUDED.updated_at`,
        [this.chainId, ancestor.number, ancestor.hash, at],
      );
      if (orphaned.length > 0) {
        const params: SqlParam[] = [];
        for (const b of orphaned) params.push(this.chainId, b.hash, b.number, at);
        await tx.query(
          `INSERT INTO indexer_pending_reorg (chain_id, block_hash, block_number, detected_at)
           VALUES ${tuples(orphaned.length, 4)} ON CONFLICT (chain_id, block_hash) DO NOTHING`,
          params,
        );
      }
    });
  }

  async pendingReorg(): Promise<{ hash: string; number: bigint }[]> {
    const { rows } = await this.db.query<{ block_hash: string; block_number: bigint }>(
      "SELECT block_hash, block_number FROM indexer_pending_reorg WHERE chain_id = $1 ORDER BY block_number",
      [this.chainId],
    );
    return rows.map((r) => ({ hash: r.block_hash, number: r.block_number }));
  }

  async clearPendingReorg(hashes: readonly string[]): Promise<void> {
    await this.db.query(
      "DELETE FROM indexer_pending_reorg WHERE chain_id = $1 AND block_hash = ANY($2::text[])",
      [this.chainId, [...hashes]],
    );
  }

  /** Deferred events in canonical order. */
  async deferred(): Promise<DeferredEvent[]> {
    const { rows } = await this.db.query<DeferredRow>(
      `SELECT event, attempts, last_sent_head, last_sent_finalized FROM indexer_deferred
        WHERE chain_id = $1 ORDER BY block_number, log_index`,
      [this.chainId],
    );
    return rows.map((r) => ({
      event: r.event,
      attempts: r.attempts,
      lastSentHead: r.last_sent_head,
      lastSentFinalized: r.last_sent_finalized,
    }));
  }

  async deferredCount(): Promise<number> {
    const { rows } = await this.db.query<{ n: bigint }>(
      "SELECT count(*) AS n FROM indexer_deferred WHERE chain_id = $1",
      [this.chainId],
    );
    return Number(rows[0]?.n ?? 0n);
  }

  async getState(key: string): Promise<string | null> {
    const { rows } = await this.db.query<{ value: string }>(
      "SELECT value FROM indexer_state WHERE chain_id = $1 AND key = $2",
      [this.chainId, key],
    );
    return rows[0]?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO indexer_state (chain_id, key, value, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [this.chainId, key, value, this.now()],
    );
  }

  async recordBalanceCheck(input: {
    id: string;
    blockNumber: bigint;
    checked: number;
    mismatches: unknown[];
    reported: boolean;
    runId: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO indexer_balance_check (id, chain_id, block_number, checked, mismatches, reported, run_id, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        input.id,
        this.chainId,
        input.blockNumber,
        input.checked,
        JSON.stringify(input.mismatches),
        input.reported,
        input.runId,
        this.now(),
      ],
    );
  }
}
