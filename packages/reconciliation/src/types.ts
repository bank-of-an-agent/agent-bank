import type {
  BalanceReportRequest,
  Clock,
  CosignerClient,
  ExpectedBalancesRequest,
  ExpectedBalancesResponse,
  IngestEventsRequest,
  IngestEventsResponse,
  ReorgRequest,
  ReorgResponse,
  WatchlistResponse,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Ledger } from "@agentbank/ledger";

/**
 * A ledger bound to a database transaction. Pass `(tx) => new PostgresLedger(tx)` in production:
 * every ledger write then joins the reconciler's serializable transaction, so chain evidence,
 * row changes and journal entries commit (or roll back and retry) together.
 */
export type LedgerFactory = (tx: SqlClient) => Ledger;

/** Agent Bank contracts on the chain (absent until deployed there). */
export interface ReconcilerContracts {
  escrow?: string | null | undefined;
  streams?: string | null | undefined;
  vaults?: string | null | undefined;
  topUpExecutor?: string | null | undefined;
  sweepExecutor?: string | null | undefined;
}

export interface ReconcilerConfig {
  /** The (testnet) chain this reconciler accepts evidence for. */
  chainId: number;
  /** USDC on that chain. */
  usdc: string;
  /** Address that receives Agent Bank fees (`sys:revenue`). */
  revenueAddress: string;
  contracts: ReconcilerContracts;
  /**
   * Blocks an unexplained outflow waits for its payment record before it is posted to suspense
   * (default 20, design § Reconciliation).
   */
  windowBlocks?: number;
  /** Amount (minor units) at or above which a movement posts only once finalized (default $100). */
  finalityThreshold?: bigint;
  /** x402 receive fee in basis points charged to registered sellers (default 50 = 0.5%). */
  x402ReceiveFeeBps?: bigint;
  /** Largest number of blocked reorg reversals retried per call (default 200). */
  reversalRetryLimit?: number;
}

/** Structured logger (pino-compatible subset). */
export interface ReconcilerLogger {
  info?(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface CreateReconcilerOptions {
  /** The API database (0002_core, 0003_chain, 0005_api). */
  db: SqlClient;
  /** A shared ledger (e.g. `InMemoryLedger` in simulations) or a per-transaction factory (production). */
  ledger: Ledger | LedgerFactory;
  /** Only `freeze` is used: an unexplained outflow pauses the agent's sessions. */
  cosigner: Pick<CosignerClient, "freeze">;
  clock?: Clock;
  config: ReconcilerConfig;
  logger?: ReconcilerLogger;
}

/** Response of `report` (the internal API leaves its shape to the reconciler). */
export interface BalanceReportResponse {
  run_id: string;
  status: "ok" | "mismatch";
  mismatches: number;
  frozen_agents: string[];
}

/** One broken reconciliation invariant. */
export interface ReconciliationViolation {
  invariant:
    | "event_matches_one_entry"
    | "entry_matches_one_event"
    | "matched_entry_exists"
    | "orphaned_entries_reversed"
    | "settled_payment_authorized"
    | "settled_payment_posted";
  subject: string;
  detail: string;
}

/** Result of {@link Reconciler.verify}. */
export interface ReconciliationReport {
  ok: boolean;
  events: number;
  matchedEvents: number;
  transactions: number;
  violations: ReconciliationViolation[];
}

/** Counters since the reconciler was created (exported to the API's metrics). */
export interface ReconcilerStats {
  ingestedEvents: number;
  duplicates: number;
  deferred: number;
  suspense: number;
  deposits: number;
  matched: number;
  rebound: number;
  reversedEntries: number;
  pendingReversals: number;
  freezes: number;
  freezeFailures: number;
  errors: number;
}

/** What `createReconciler` returns: the five internal routes plus maintenance helpers. */
export interface Reconciler {
  /** `GET /internal/v1/watchlist` */
  watchlist(): Promise<WatchlistResponse>;
  /** `POST /internal/v1/chain-events` */
  ingest(request: IngestEventsRequest): Promise<IngestEventsResponse>;
  /** `POST /internal/v1/chain-events/reorg` */
  reorg(request: ReorgRequest): Promise<ReorgResponse>;
  /** `POST /internal/v1/reconciliation/expected-balances` */
  expectedBalances(request: ExpectedBalancesRequest): Promise<ExpectedBalancesResponse>;
  /** `POST /internal/v1/reconciliation/report` */
  report(request: BalanceReportRequest): Promise<BalanceReportResponse>;
  /** Retry reorg reversals that were blocked by held funds. Returns how many completed. */
  retryPendingReversals(): Promise<number>;
  /** Check the reconciliation invariants against the database and the ledger. */
  verify(): Promise<ReconciliationReport>;
  /** Counters since creation. */
  stats(): ReconcilerStats;
}
