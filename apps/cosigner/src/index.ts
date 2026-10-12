/**
 * `@agentbank/cosigner` as a library: the service, its HTTP app and an
 * in-process client, for end-to-end tests and the local sandbox. The
 * deployable server is `src/main.ts` (built to `dist/index.js`).
 */
export { buildApp, type AppOptions } from "./app";
export { InjectCosignerClient } from "./client";
export { loadConfig, type CosignerConfig } from "./config";
export { createCosigner, type Cosigner, type CreateCosignerOptions } from "./create";
export { COSIGNER_MIGRATIONS_DIR, migrateCosigner, openCosignerDatabase } from "./database";
export {
  LATENCY_BUCKETS_SECONDS,
  Metrics,
  type DecisionResult,
  type DecisionRoute,
  type MetricsOptions,
} from "./metrics";
export {
  matchCalls,
  type MatchResult,
  type MatchRules,
  type OperationCodec,
  type StatedIntent,
  type VerifiedSpend,
} from "./operation";
export { verifyOwnerAction, type VerifiedAuthorization } from "./owner-auth";
export { noopAuditExporter, type AuditExporter, type Logger, type ServiceConfig } from "./context";
export { applyApproval, type FinalDecision } from "./decision";
export { counterpartyKeys, PolicyEvaluator } from "./evaluator";
export { CosignerService, type CosignerServiceDeps } from "./service";
export { contractsFor, createOperationCodec, operationCodec } from "./chain";
export * from "./signer";
