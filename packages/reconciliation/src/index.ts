/**
 * `@agentbank/reconciliation`: the reconciler the API mounts on `/internal/v1/*` for the indexer
 * (contract: `IndexerRoutes` and the schemas in `@agentbank/core`'s `indexer-api.ts`).
 *
 * - {@link createReconciler} matches chain events to expected movements (payments by user
 *   operation or transaction hash, x402 by authorization nonce, escrow/stream/vault/top-up
 *   contract events), posts ledger entries, settles payments, records deposits, raises suspense
 *   and mismatch events, pauses agents, reverses (or rebinds) postings on reorgs, and computes
 *   the expected on-chain balance of every watched address.
 * - {@link createInternalHandler} serves the five routes over any HTTP server that keeps the raw
 *   body (HMAC-verified with `INTERNAL_API_SHARED_SECRET`).
 * - The schema lives in `packages/db/migrations/0003_chain.sql`.
 */
export { createReconciler } from "./reconciler";
export {
  createInternalHandler,
  type InternalHandlerOptions,
  type InternalRequest,
  type InternalResponse,
} from "./http";
export { fingerprintOf, groupEvents, type ChainEvent, type TxGroup } from "./parse";
export { FREEZE_REASON } from "./freeze";
export type {
  BalanceReportResponse,
  CreateReconcilerOptions,
  LedgerFactory,
  Reconciler,
  ReconcilerConfig,
  ReconcilerContracts,
  ReconcilerLogger,
  ReconcilerStats,
  ReconciliationReport,
  ReconciliationViolation,
} from "./types";
