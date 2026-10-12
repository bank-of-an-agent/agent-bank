/**
 * `@agentbank/sdk`: the TypeScript SDK for Agent Bank, a non-custodial bank
 * for AI agents (USDC on Base Sepolia).
 *
 * - {@link AgentBankClient}: typed client over the REST API (route registry
 *   of `@agentbank/core`), with retries, idempotency, RFC 9421 request
 *   signing and RFC 9457 error mapping.
 * - {@link AgentClient}: an agent's view (session key): `pay`, escrows,
 *   streams, and an x402-aware `fetch`.
 * - {@link PrincipalClient}: a principal's view (API key + owner key):
 *   `setupAgentAccount` (account → spend key + float-recovery permit →
 *   first session), `grantSession`, policies, mandates, owner rotation and
 *   other owner-signed changes.
 * - Private proofs: `agent.proofs.enroll/prove/reserve`, proof challenges
 *   answered by `fetchWithPayment` ({@link fetchWithProof} standalone),
 *   `principal.proofs.configure`. Verifiers use `@agentbank/sdk/proof-server`.
 * - x402 client helpers ({@link wrapFetch}), webhook verification, key
 *   generation and key stores. Seller middleware lives in
 *   `@agentbank/sdk/x402-server`; the Node file key store in `@agentbank/sdk/node`.
 *
 * Runs in Node ≥ 20 and modern browsers.
 *
 * @packageDocumentation
 */

export { SDK_VERSION } from "./version";

export {
  AgentBankClient,
  type ClientOptions,
  type FetchLike,
  type ListItem,
  type ListOperationId,
  type RequestArgs,
  type RequestArgsTuple,
  type RequestOptions,
  type RetryOptions,
  type SessionCredentials,
} from "./client";

export {
  AgentClient,
  createAgentBankPayer,
  assertAuthorizationMatches,
  normalizeAmount,
  toPaymentTarget,
  type AgentBankPayerOptions,
  type AgentClientOptions,
  type AgentFetchResult,
  type AgentX402Options,
  type CheckSpendInput,
  type CreateEscrowFlowInput,
  type CreateStreamFlowInput,
  type FlowOptions,
  type PayInput,
  type PaymentTarget,
  type WaitOptions,
} from "./agent";

export {
  PrincipalClient,
  type GrantSessionInput,
  type GrantSessionResult,
  type OwnerFlowOptions,
  type PrincipalClientOptions,
  type SessionScopeRequest,
  type SetupAgentAccountInput,
  type SetupAgentAccountResult,
} from "./principal";

export {
  AgentProofs,
  DEFAULT_MAX_PRESENTATIONS_PER_SCOPE_PER_HOUR,
  isProofSecret,
  MAX_RESERVATION_SECONDS,
  MIN_RESERVATION_SECONDS,
  releaseProofResources,
  type AgentProofOptions,
  type AgentProofsConfig,
  type ProofAnswer,
  type ProveOptions,
  type Prover,
  type ProverArtifacts,
  type ProverInput,
  type ReserveInput,
} from "./proofs/agent";
export { PrincipalProofs, type ConfigureProofsInput, type OwnerAuthorizer } from "./proofs/principal";
export {
  createProofFetch,
  fetchWithProof,
  scopeMatchesHost,
  type ProofAnswerer,
  type ProofFetchDetails,
  type ProofFetchOptions,
  type ProofFetchResult,
  type ProofFetchSession,
} from "./proofs/fetch";
export {
  ProofError,
  type ProofErrorContext,
  type ProofErrorReason,
  type ReservationNeeded,
} from "./proofs/errors";
export { generateProofSecret, identityCommitment } from "@agentbank/proofs/tree";
export {
  isOnchainScopeId,
  onchainScopeId,
  parseOnchainScopeId,
  scopeField,
  scopeTagOf,
  type OnchainScopeRef,
} from "@agentbank/proofs/field";
export { parseProofRequest, requestHash } from "@agentbank/proofs/request";

export {
  EARLY_WITHDRAWAL_TYPES,
  earlyWithdrawalTypedData,
  MAX_EARLY_WITHDRAWAL_DEADLINE_SECONDS,
  TIME_LOCK_VAULTS_EIP712,
  type EarlyWithdrawalTypedData,
  type ExpectedEarlyWithdrawal,
} from "./vaults";

export {
  EIP2612_NONCES_ABI,
  EIP2612_PERMIT_TYPES,
  signSpendKeyPermit,
  spendKeyPermitTypedData,
  type SignSpendKeyPermitInput,
  type SpendKeyPermitOptions,
} from "./spend-key";

export {
  DEFAULT_OWNER_AUTHORIZATION_TTL_SECONDS,
  ownerAuthorize,
  ownerPayloads,
  type OwnerActionPayload,
  type OwnerAuthorizeInput,
} from "./owner";

export {
  generateSessionKey,
  generateSpendKey,
  isPrivateKey,
  signerFromPrivateKey,
  signOperationHash,
  type GeneratedKey,
  type OwnerSigner,
  type SessionSigner,
  type SignableMessage,
  type SpendSigner,
  type TypedDataPayload,
} from "./signers";

export {
  AgentBankApiError,
  AgentBankError,
  AuthenticationError,
  ChainError,
  codeForStatus,
  ConflictError,
  ConnectionError,
  ERROR_CATALOG,
  errorFromProblem,
  errorFromResponse,
  FrozenError,
  InsufficientFundsError,
  InternalServerError,
  InvalidRequestError,
  isAgentBankError,
  MandateError,
  NotFoundError,
  PaymentFailedError,
  PermissionDeniedError,
  PolicyDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  toAgentBankError,
  type ApiErrorMeta,
  type ErrorCode,
  type ProblemDetails,
} from "./errors";

export {
  DEFAULT_MAX_AMOUNT_PER_REQUEST,
  DEFAULT_X402_NETWORK,
  fetchWithX402,
  parseChallenge,
  parseX402Cap,
  selectRequirement,
  buildPaymentHeader,
  resolveX402Options,
  wrapFetch,
  x402ChainId,
  X402Error,
  type ResolvedX402Options,
  type SelectedRequirement,
  type WrapFetchOptions,
  type X402Challenge,
  type X402ClientOptions,
  type X402ErrorReason,
  type X402FetchResult,
  type X402Payer,
  type X402PaymentContext,
  type X402PaymentEvent,
} from "./x402/client";

export {
  chainIdOfNetwork,
  decodeHeaderValue,
  encodeHeaderValue,
  readPaymentResponse,
  v1NetworkOf,
  X402_HEADERS,
  type ExactEvmAuthorization,
  type ExactEvmPayload,
  type PaymentPayload,
  type PaymentPayloadV1,
  type PaymentRequired,
  type PaymentRequiredV1,
  type PaymentRequirements,
  type PaymentRequirementsV1,
  type ResourceInfo,
  type SettleResponse,
  type VerifyResponse,
} from "./x402/protocol";

export {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferWithAuthorizationTypedData,
  type Eip3009Domain,
} from "./x402/eip3009";

export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  isKnownWebhookEventType,
  parseWebhookEvent,
  signWebhook,
  verifyWebhook,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type ParseWebhookInput,
  type VerifyWebhookOptions,
  type WebhookEvent,
  type WebhookEventDataMap,
  type WebhookEventType,
} from "./webhooks";

export { loadKey, loadOrCreateKey, MemoryKeyStore, type KeyStore } from "./keystore/memory";

export * from "./types";

export * as resources from "./resources";

export {
  CHAINS,
  formatAmount,
  getAsset,
  OPERATION_HASH_SIGNING,
  OWNER_ACTIONS,
  parseAmount,
  type ChainInfo,
  type ChainName,
  type OwnerAction,
} from "@agentbank/core";
export { routes, type OperationId, type RequestInputOf, type ResponseOf } from "@agentbank/core/api";
