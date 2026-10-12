import {
  AgentBankError,
  assertTestnet,
  BalanceReportRequest,
  ExpectedBalancesRequest,
  FINALITY_THRESHOLD_MINOR,
  IngestEventsRequest,
  isAgentBankError,
  money,
  newId,
  PRICING,
  ReorgRequest,
  systemClock,
  type ExpectedBalancesResponse,
  type IngestEventsResponse,
  type IngestResult,
  type ReorgResponse,
  type WatchlistResponse,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { suspenseRef } from "@agentbank/ledger";
import { getAddress } from "viem";
import { expectedBalances, watchlist } from "./balances";
import type { ResolvedConfig } from "./context";
import {
  assertChain,
  IngestRun,
  ledgerFor,
  recordFailure,
  retryPending,
  reverseTx,
  type EngineDeps,
} from "./engine";
import { deliverFreezes, queueFreeze, type QueuedFreeze } from "./freeze";
import { KnownIndex, loadAccounts, type ContractKind } from "./known";
import { EventWriter, type PendingEvent } from "./notify";
import { groupEvents, lower } from "./parse";
import { ASSET } from "./plan";
import { all, type ChainTxRow } from "./rows";
import { verifyReconciliation } from "./invariants";
import type {
  BalanceReportResponse,
  CreateReconcilerOptions,
  Reconciler,
  ReconcilerLogger,
  ReconcilerStats,
  ReconciliationReport,
} from "./types";

const DEFAULT_WINDOW_BLOCKS = 20;

function resolveConfig(options: CreateReconcilerOptions): ResolvedConfig {
  const c = options.config;
  assertTestnet(c.chainId);
  const checksum = (value: string | null | undefined): string | null => (value ? getAddress(value) : null);
  const contractsChecksum: Record<ContractKind, string | null> = {
    escrow: checksum(c.contracts.escrow),
    streams: checksum(c.contracts.streams),
    vaults: checksum(c.contracts.vaults),
    topup: checksum(c.contracts.topUpExecutor),
    sweep: checksum(c.contracts.sweepExecutor),
  };
  const contracts = Object.fromEntries(
    Object.entries(contractsChecksum).map(([k, v]) => [k, v ? lower(v) : null]),
  ) as Record<ContractKind, string | null>;
  const window = c.windowBlocks ?? DEFAULT_WINDOW_BLOCKS;
  if (!Number.isInteger(window) || window < 0)
    throw new AgentBankError("invalid_request", "windowBlocks must be >= 0");
  return {
    chainId: c.chainId,
    asset: "USDC",
    usdc: lower(getAddress(c.usdc)),
    usdcChecksum: getAddress(c.usdc),
    revenue: lower(getAddress(c.revenueAddress)),
    revenueChecksum: getAddress(c.revenueAddress),
    contracts,
    contractsChecksum,
    windowBlocks: BigInt(window),
    finalityThreshold: c.finalityThreshold ?? FINALITY_THRESHOLD_MINOR,
    x402FeeBps: c.x402ReceiveFeeBps ?? PRICING.x402ReceiveBps,
    reversalRetryLimit: c.reversalRetryLimit ?? 200,
  };
}

function zeroStats(): ReconcilerStats {
  return {
    ingestedEvents: 0,
    duplicates: 0,
    deferred: 0,
    suspense: 0,
    deposits: 0,
    matched: 0,
    rebound: 0,
    reversedEntries: 0,
    pendingReversals: 0,
    freezes: 0,
    freezeFailures: 0,
    errors: 0,
  };
}

const consoleLogger: ReconcilerLogger = {
  warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: "error", msg, ...obj })),
};

/**
 * Create the reconciler the API mounts on `/internal/v1/*` (contract: `core/src/indexer-api.ts`).
 *
 * ```ts
 * const reconciler = createReconciler({
 *   db, ledger: (tx) => new PostgresLedger(tx, { clock }), cosigner, clock,
 *   config: { chainId, usdc, revenueAddress, contracts: { escrow, streams, vaults, topUpExecutor, sweepExecutor } },
 * });
 * ```
 */
export function createReconciler(options: CreateReconcilerOptions): Reconciler {
  const cfg = resolveConfig(options);
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? consoleLogger;
  const stats = zeroStats();
  const deps: EngineDeps = { db: options.db, ledger: options.ledger, clock, cfg, logger, stats };
  const db = options.db;

  /**
   * One serializable transaction (retried on serialization failures). Counters of an attempt
   * reach `stats()` only when it commits, so retries and rolled-back batches never double count.
   */
  async function inTx<T>(fn: (d: EngineDeps, tx: SqlClient) => Promise<T>): Promise<T> {
    let attempt = zeroStats();
    const result = await db.transaction((tx) => {
      attempt = zeroStats();
      return fn({ ...deps, stats: attempt }, tx);
    });
    for (const key of Object.keys(attempt) as (keyof ReconcilerStats)[]) stats[key] += attempt[key];
    return result;
  }

  async function deliver(freezes: readonly QueuedFreeze[]): Promise<void> {
    if (freezes.length === 0) return;
    const { failed } = await deliverFreezes(db, options.cosigner, freezes, () => clock.now(), logger);
    stats.freezeFailures += failed;
  }

  return {
    watchlist(): Promise<WatchlistResponse> {
      return watchlist(db, cfg);
    },

    async ingest(request): Promise<IngestEventsResponse> {
      const req = IngestEventsRequest.parse(request);
      assertChain(cfg, req.chain_id);
      const groups = groupEvents(cfg.chainId, req.events);
      const head = BigInt(req.head_block);
      const finalized = BigInt(req.finalized_block);
      if (groups.length === 0) return { results: [] };
      stats.ingestedEvents += req.events.length;
      let results: Map<string, IngestResult>;
      let freezes: QueuedFreeze[];
      try {
        ({ results, freezes } = await inTx(async (d, tx) => {
          const run = await IngestRun.create(d, tx, groups, head, finalized);
          for (const group of groups) await run.process(group);
          await run.retryPendingReversals();
          await run.flush();
          return { results: run.results, freezes: run.freezes };
        }));
      } catch (error) {
        if (isAgentBankError(error) && error.code === "invalid_request") throw error;
        stats.errors++;
        logger.error(
          { err: String((error as Error)?.message ?? error).slice(0, 500), events: req.events.length },
          "reconciliation batch failed; retrying transaction by transaction",
        );
        // Isolate the failing transaction(s): every other one still reconciles.
        results = new Map();
        freezes = [];
        for (const group of groups) {
          try {
            const one = await inTx(async (d, tx) => {
              const run = await IngestRun.create(d, tx, [group], head, finalized);
              await run.process(group);
              await run.flush();
              return { results: run.results, freezes: run.freezes };
            });
            for (const [id, r] of one.results) results.set(id, r);
            freezes.push(...one.freezes);
          } catch (groupError) {
            logger.error(
              {
                chain_tx_id: group.id,
                err: String((groupError as Error)?.message ?? groupError).slice(0, 500),
              },
              "chain transaction could not be reconciled; deferred",
            );
            const failed = await inTx((d, tx) => recordFailure(d, tx, group, groupError));
            for (const [i, event] of group.events.entries()) results.set(event.id, failed[i] as IngestResult);
          }
        }
      }
      await deliver(freezes);
      return {
        results: req.events.map(
          (event) =>
            results.get(lower(event.id)) ?? {
              event_id: event.id,
              status: "ignored",
              entry_id: null,
              ref: null,
            },
        ),
      };
    },

    async reorg(request): Promise<ReorgResponse> {
      const req = ReorgRequest.parse(request);
      assertChain(cfg, req.chain_id);
      const hashes = [...new Set(req.orphaned_block_hashes.map((h) => lower(h)))];
      return inTx(async (d, tx) => {
        const now = clock.now();
        const ledger = ledgerFor(d, tx);
        const rows = await all<ChainTxRow>(
          tx,
          `SELECT * FROM chain_tx WHERE chain_id = $1 AND block_hash = ANY($2::text[]) AND status <> 'reorged'
            ORDER BY block_number DESC, first_log_index DESC`,
          [cfg.chainId, hashes],
        );
        let reversed = 0;
        const reopened: string[] = [];
        for (const row of rows) {
          const r = await reverseTx(d, tx, ledger, row, now);
          reversed += r.reversed.length;
          reopened.push(...r.reopened);
        }
        const retried = await retryPending(d, tx, ledger, now, cfg.reversalRetryLimit);
        reversed += retried.reversed.length;
        reopened.push(...retried.reopened);
        return { reversed_entries: reversed, reopened: [...new Set(reopened)] };
      });
    },

    async expectedBalances(request): Promise<ExpectedBalancesResponse> {
      const req = ExpectedBalancesRequest.parse(request);
      assertChain(cfg, req.chain_id);
      const balances = await expectedBalances(db, ledgerFor(deps, db), cfg, req.addresses);
      return {
        balances: [...balances].map(([address, expected]) => {
          // Pocket sums are never negative; a negative sys:revenue would be a ledger defect.
          if (expected < 0n)
            logger.error({ address, expected: expected.toString() }, "negative expected balance");
          return { address, expected: (expected < 0n ? 0n : expected).toString() };
        }),
      };
    },

    async report(request): Promise<BalanceReportResponse> {
      const req = BalanceReportRequest.parse(request);
      assertChain(cfg, req.chain_id);
      const { response, freezes } = await inTx(async (d, tx) => {
        const now = clock.now();
        const ledger = ledgerFor(d, tx);
        const mismatches = req.mismatches.map((m) => ({ ...m, address: getAddress(m.address) }));
        const accounts = await loadAccounts(
          tx,
          cfg.chainId,
          mismatches.map((m) => m.address),
        );
        const known = new KnownIndex({ revenue: cfg.revenue, contracts: new Map() }, accounts);
        const events: PendingEvent[] = [];
        const queued: QueuedFreeze[] = [];
        const frozen = new Set<string>();
        const recorded = [];
        for (const m of mismatches) {
          const party = known.partyOf(m.address);
          const account = party?.kind === "account" || party?.kind === "spend_key" ? party.account : null;
          recorded.push({ ...m, account_id: account?.id ?? null });
          if (!account) continue;
          events.push({
            orgId: account.org_id,
            type: "reconciliation.mismatch",
            data: {
              object: "reconciliation_mismatch",
              kind: "balance",
              account_id: account.id,
              agent_id: account.agent_id,
              address: m.address,
              onchain: money(BigInt(m.onchain)),
              expected: money(BigInt(m.expected)),
              block_number: req.block_number,
              agent_paused: account.agent_id !== null,
            },
          });
          if (account.agent_id && !frozen.has(account.agent_id)) {
            frozen.add(account.agent_id);
            const f = await queueFreeze(db, tx, account.agent_id, now);
            queued.push(f.queued);
            events.push(...f.events);
            d.stats.freezes++;
          }
        }
        await new EventWriter(tx).emit(events, now);
        const suspense = await ledger.balance(suspenseRef(ASSET));
        const id = `rcr_${newId("audit", now.getTime()).slice("aud_".length)}`;
        const status = mismatches.length === 0 ? "ok" : "mismatch";
        await tx.query(
          `INSERT INTO reconciliation_run (id, chain_id, block_number, checked, mismatch_count, mismatches, status,
                                           suspense_balance, frozen_agents, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::text[], $10)`,
          [
            id,
            cfg.chainId,
            BigInt(req.block_number),
            req.checked,
            mismatches.length,
            JSON.stringify(recorded),
            status,
            suspense,
            [...frozen],
            now,
          ],
        );
        if (mismatches.length > 0) {
          logger.error(
            { run_id: id, mismatches: recorded.slice(0, 20) },
            "on-chain balances do not match the ledger",
          );
        }
        return {
          response: {
            run_id: id,
            status,
            mismatches: mismatches.length,
            frozen_agents: [...frozen],
          } as BalanceReportResponse,
          freezes: queued,
        };
      });
      await deliver(freezes);
      return response;
    },

    async retryPendingReversals(): Promise<number> {
      return inTx(async (d, tx) => {
        const r = await retryPending(d, tx, ledgerFor(d, tx), clock.now(), cfg.reversalRetryLimit);
        return r.completed;
      });
    },

    verify(): Promise<ReconciliationReport> {
      return verifyReconciliation(db, ledgerFor(deps, db), cfg.chainId);
    },

    stats(): ReconcilerStats {
      return { ...stats };
    },
  };
}
