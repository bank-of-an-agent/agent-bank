/**
 * `@agentbank/facilitator`: Agent Bank's x402 facilitator (verify and settle payer-signed
 * EIP-3009 payments for sellers). `src/main.ts` is the server entry point (`dist/index.js`);
 * this module exports the pieces for tests and embedding.
 */
export { buildApp, DEFAULT_RATE_LIMITS, type AppOptions, type RateLimits } from "./app";
export { createChainRuntime, settlementAsset, type ChainRuntime } from "./chain";
export {
  ConfigError,
  DEFAULT_RELAYER_MIN_BALANCE_WEI,
  loadConfig,
  parseTrustProxy,
  type FacilitatorConfig,
} from "./config";
export {
  contractSignatureVerifierFor,
  ERC1271_MAGIC_WORD,
  erc1271ViaCall,
  isErc1271Accepted,
  type ContractSignatureVerifier,
} from "./erc1271";
export {
  Facilitator,
  safeErrorMessage,
  type FacilitatorDeps,
  type FacilitatorLogger,
  type FacilitatorOptions,
  type FacilitatorReply,
  type HealthReport,
  type PayeeMode,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "./facilitator";
export { RelayerGasGuard, type RelayerGasCheck, type RelayerGasGuardOptions } from "./gas";
export { createLogger, REDACT_PATHS, type Logger } from "./logger";
export { Metrics, type MetricsOptions, type SettleOutcome, type VerifyOutcome } from "./metrics";
export { REASONS, type ReasonCode, type Rejection } from "./reasons";
export { evmReceipts, simulatedReceipts, type ReceiptSource, type TransactionOutcome } from "./receipts";
export {
  isBlocked,
  SANDBOX_HIGH_RISK_ADDRESSES,
  SANDBOX_SANCTIONED_ADDRESSES,
  SandboxScreening,
  screenOrFail,
  type ScreeningProvider,
  type ScreeningResult,
} from "./screening";
export { AuthorizationStore, type AuthorizationRow, type AuthorizationStatus } from "./store";
export * from "./verification";
