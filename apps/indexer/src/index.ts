/**
 * `@agentbank/indexer` building blocks (the service entry point is `src/main.ts`, built to
 * `dist/index.js`). Exported for tests and in-process simulations: the loop, its database, the
 * transports and the log normalization.
 */
export { buildApp, BALANCE_CHECK_PATH, type AppOptions } from "./app";
export { ConfigError, loadConfig, type IndexerConfig } from "./config";
export {
  Indexer,
  type BalanceCheckResult,
  type IndexerLogger,
  type IndexerOptions,
  type TickResult,
} from "./indexer";
export { IndexerMetrics, type MetricsOptions } from "./metrics";
export { batchByTransaction, eventIdOf, normalizeLogs, txKeyOf, type NormalizeOptions } from "./normalize";
export { IndexerStore, INDEXER_MIGRATIONS_DIR, migrateIndexer, type StoredBlock } from "./store";
export { HttpReconcilerTransport, type HttpTransportOptions, type ReconcilerTransport } from "./transport";
