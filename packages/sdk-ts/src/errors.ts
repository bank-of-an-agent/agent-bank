import {
  AgentBankError,
  ERROR_CATALOG,
  errorFromProblem,
  isErrorCode,
  type ErrorCode,
  type ProblemDetails,
} from "@agentbank/core";
import type { Escrow, Payment, PolicyDecision, Stream } from "./types";

/**
 * Errors thrown by the SDK.
 *
 * Every error is an {@link AgentBankError} (from `@agentbank/core`), so a
 * single `instanceof AgentBankError` check (or {@link isAgentBankError})
 * catches everything, and `error.code` is always one of the stable codes of
 * the API's error catalog. RFC 9457 problem documents returned by the API
 * are mapped to the subclasses below by `code` (falling back to the HTTP
 * status for codes this SDK version does not know); the raw problem document
 * is kept on {@link AgentBankApiError.problem}.
 *
 * @packageDocumentation
 */

/** Context attached to errors produced while talking to the API. */
export interface ApiErrorMeta {
  /** HTTP status of the response, when one was received. */
  httpStatus?: number;
  /** The raw RFC 9457 problem document, when the API sent one. */
  problem?: Readonly<Record<string, unknown>>;
  /** Operation id from the route registry, e.g. `"createPayment"`. */
  operationId?: string;
  /** Value of the `x-request-id` response header, if any; quote it in support requests. */
  requestId?: string;
  /** Delay the server asked for (from `Retry-After`), in milliseconds. */
  retryAfterMs?: number;
  /** Underlying cause (network error, abort reason, …). */
  cause?: unknown;
}

/**
 * Base class for errors raised while calling the Agent Bank API, including
 * transport failures. `code`, `status`, `title` and `extensions` come from
 * the core {@link AgentBankError}; `httpStatus` is the status actually received.
 */
export class AgentBankApiError extends AgentBankError {
  /** HTTP status actually received, or `undefined` if no response arrived. */
  readonly httpStatus: number | undefined;
  /** The raw problem document, when the API sent one. */
  readonly problem: Readonly<Record<string, unknown>> | undefined;
  /** Operation that failed, e.g. `"createPayment"`. */
  readonly operationId: string | undefined;
  /** `x-request-id` of the failed response, if the API sent one. */
  readonly requestId: string | undefined;

  constructor(
    code: ErrorCode,
    detail?: string,
    extensions: Record<string, unknown> = {},
    meta: ApiErrorMeta = {},
  ) {
    super(code, detail, extensions);
    this.name = new.target.name;
    this.httpStatus = meta.httpStatus;
    this.problem = meta.problem;
    this.operationId = meta.operationId;
    this.requestId = meta.requestId;
    if (meta.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: meta.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

/** 400: malformed request, invalid amount, unsupported asset or chain. Also raised client-side before sending. */
export class InvalidRequestError extends AgentBankApiError {}
/** 401: missing/invalid credentials, bad request signature, expired or revoked session key. */
export class AuthenticationError extends AgentBankApiError {}
/** 403: not allowed, owner signature required, feature gated, mainnet locked. */
export class PermissionDeniedError extends AgentBankApiError {}
/** 404: the resource does not exist (or is not visible to these credentials). */
export class NotFoundError extends AgentBankApiError {}
/** 409: conflicting state, idempotency key reused with a different request, expired approval. */
export class ConflictError extends AgentBankApiError {}
/** 422 `insufficient_funds`: the account cannot cover amount plus fee. */
export class InsufficientFundsError extends AgentBankApiError {}

/**
 * 422 `policy_denied`: the policy engine (or the co-signer) refused the
 * payment. Also thrown by the high-level helpers when the API answers a
 * payment with status `denied`. `decision.rule_hits` explains why.
 */
export class PolicyDeniedError extends AgentBankApiError {
  /** The policy decision, when known. */
  readonly decision: PolicyDecision | undefined;
  /** The denied payment, escrow or stream, when the denial came back as a resource. */
  readonly resource: Payment | Escrow | Stream | undefined;

  constructor(
    code: ErrorCode,
    detail?: string,
    extensions: Record<string, unknown> = {},
    meta: ApiErrorMeta & { decision?: PolicyDecision; resource?: Payment | Escrow | Stream } = {},
  ) {
    super(code, detail, extensions, meta);
    this.decision = meta.decision ?? asDecision(extensions.decision);
    this.resource = meta.resource;
  }
}

/** 422 `mandate_invalid` / `mandate_expired`: the referenced AP2 mandate cannot authorize this spend. */
export class MandateError extends AgentBankApiError {}
/** 423 `agent_frozen` / `org_frozen`: the co-signer refuses everything until the owner unfreezes. */
export class FrozenError extends AgentBankApiError {}

/** 429 `rate_limited`. `retryAfterMs` is the delay the server asked for, if any. */
export class RateLimitError extends AgentBankApiError {
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    detail?: string,
    extensions: Record<string, unknown> = {},
    meta: ApiErrorMeta = {},
  ) {
    super(code, detail, extensions, meta);
    this.retryAfterMs = meta.retryAfterMs;
  }
}

/** 500 `internal`: unexpected server error (or an unreadable/invalid response). */
export class InternalServerError extends AgentBankApiError {}
/** 502 `chain_error`: the chain or bundler failed; also used when a payment ends `failed`. */
export class ChainError extends AgentBankApiError {}

/**
 * 503 `cosigner_unavailable` / `screening_unavailable`: Agent Bank fails
 * closed when a safety dependency is down. Safe to retry later with the same
 * idempotency key.
 */
export class ServiceUnavailableError extends AgentBankApiError {}

/**
 * No HTTP response was received (DNS, connection refused, TLS, reset).
 * Carries code `internal` because the API's error catalog has no client-side
 * transport code.
 */
export class ConnectionError extends AgentBankApiError {}

/** The request did not complete within the configured timeout. */
export class TimeoutError extends ConnectionError {}

/** A payment, escrow or stream reached status `failed` (on-chain revert, bundler timeout, …). */
export class PaymentFailedError extends ChainError {
  /** The failed resource. */
  readonly resource: Payment | Escrow | Stream;

  constructor(resource: Payment | Escrow | Stream, detail?: string) {
    super(
      "chain_error",
      detail ??
        `${resource.object} ${resource.id} failed${"failure_reason" in resource && resource.failure_reason ? `: ${resource.failure_reason}` : ""}`,
      {},
      {},
    );
    this.resource = resource;
  }
}

type ApiErrorConstructor = new (
  code: ErrorCode,
  detail?: string,
  extensions?: Record<string, unknown>,
  meta?: ApiErrorMeta,
) => AgentBankApiError;

const CLASS_BY_CODE: Partial<Record<ErrorCode, ApiErrorConstructor>> = {
  invalid_request: InvalidRequestError,
  invalid_amount: InvalidRequestError,
  unsupported_asset: InvalidRequestError,
  unsupported_chain: InvalidRequestError,
  unauthorized: AuthenticationError,
  signature_invalid: AuthenticationError,
  session_expired: AuthenticationError,
  session_revoked: AuthenticationError,
  forbidden: PermissionDeniedError,
  owner_signature_required: PermissionDeniedError,
  feature_gated: PermissionDeniedError,
  mainnet_locked: PermissionDeniedError,
  not_found: NotFoundError,
  conflict: ConflictError,
  idempotency_conflict: ConflictError,
  invalid_state: ConflictError,
  approval_expired: ConflictError,
  insufficient_funds: InsufficientFundsError,
  policy_denied: PolicyDeniedError,
  mandate_invalid: MandateError,
  mandate_expired: MandateError,
  agent_frozen: FrozenError,
  org_frozen: FrozenError,
  rate_limited: RateLimitError,
  cosigner_unavailable: ServiceUnavailableError,
  screening_unavailable: ServiceUnavailableError,
  chain_error: ChainError,
  internal: InternalServerError,
};

/** Error code to assume for an HTTP status when the response carried no known code. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "invalid_request";
    case 423:
      return "agent_frozen";
    case 429:
      return "rate_limited";
    case 502:
      return "chain_error";
    case 503:
      return "cosigner_unavailable";
    default:
      return status >= 400 && status < 500 ? "invalid_request" : "internal";
  }
}

function classForStatus(status: number): ApiErrorConstructor {
  if (status === 429) return RateLimitError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 423) return FrozenError;
  if (status === 503) return ServiceUnavailableError;
  if (status === 502) return ChainError;
  if (status >= 500) return InternalServerError;
  return InvalidRequestError;
}

function asDecision(value: unknown): PolicyDecision | undefined {
  if (value && typeof value === "object" && "outcome" in value && "rule_hits" in value) {
    return value as PolicyDecision;
  }
  return undefined;
}

/**
 * Map an HTTP error response to the matching {@link AgentBankApiError}
 * subclass. `problem` is the parsed RFC 9457 document (or `undefined` when
 * the body was not a problem document, e.g. an HTML page from a proxy).
 * Reuses `errorFromProblem` from `@agentbank/core` for code/detail/extension
 * extraction so every SDK interprets problems identically.
 */
export function errorFromResponse(
  httpStatus: number,
  problem: Record<string, unknown> | undefined,
  meta: Omit<ApiErrorMeta, "httpStatus" | "problem"> = {},
): AgentBankApiError {
  const known = problem !== undefined && isErrorCode(problem.code);
  const base = problem ? errorFromProblem(problem as Partial<ProblemDetails>) : undefined;
  const code: ErrorCode = known ? (problem.code as ErrorCode) : codeForStatus(httpStatus);
  const Ctor = (known ? CLASS_BY_CODE[code] : undefined) ?? classForStatus(httpStatus);
  const detail =
    typeof problem?.detail === "string"
      ? problem.detail
      : typeof problem?.title === "string"
        ? problem.title
        : `HTTP ${httpStatus} ${ERROR_CATALOG[code].title}`;
  const extensions = { ...(base?.extensions ?? {}) };
  if (problem && !known && typeof problem.code === "string") extensions.unknown_code = problem.code;
  return new Ctor(code, detail, extensions, { ...meta, httpStatus, ...(problem ? { problem } : {}) });
}

/** Wrap any thrown value as an {@link AgentBankError}, preserving SDK errors as-is. */
export function toAgentBankError(error: unknown): AgentBankError {
  if (error instanceof AgentBankError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AgentBankApiError("internal", detail, {}, { cause: error });
}

export { AgentBankError, isAgentBankError, errorFromProblem, ERROR_CATALOG } from "@agentbank/core";
export type { ErrorCode, ProblemDetails } from "@agentbank/core";
