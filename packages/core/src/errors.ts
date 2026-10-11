/**
 * Errors follow RFC 9457 (Problem Details for HTTP APIs).
 *
 * Every error the bank can return has a stable machine-readable `code`. The
 * problem `type` is a URN derived from the code so clients never depend on a
 * documentation host being reachable.
 */

export const ERROR_CATALOG = {
  invalid_request: { status: 400, title: "Invalid request" },
  invalid_amount: { status: 400, title: "Invalid amount" },
  unsupported_asset: { status: 400, title: "Unsupported asset" },
  unsupported_chain: { status: 400, title: "Unsupported chain" },
  unauthorized: { status: 401, title: "Authentication required" },
  signature_invalid: { status: 401, title: "Signature invalid" },
  forbidden: { status: 403, title: "Forbidden" },
  owner_signature_required: { status: 403, title: "Owner signature required" },
  feature_gated: { status: 403, title: "Feature not enabled" },
  mainnet_locked: { status: 403, title: "Mainnet is locked" },
  not_found: { status: 404, title: "Not found" },
  conflict: { status: 409, title: "Conflict" },
  idempotency_conflict: { status: 409, title: "Idempotency key reused with a different request" },
  invalid_state: { status: 409, title: "Invalid state transition" },
  insufficient_funds: { status: 422, title: "Insufficient funds" },
  policy_denied: { status: 422, title: "Payment denied by policy" },
  agent_frozen: { status: 423, title: "Agent is frozen" },
  org_frozen: { status: 423, title: "Organization is frozen" },
  session_expired: { status: 401, title: "Session key expired" },
  session_revoked: { status: 401, title: "Session key revoked" },
  mandate_invalid: { status: 422, title: "Mandate invalid" },
  mandate_expired: { status: 422, title: "Mandate expired" },
  approval_expired: { status: 409, title: "Approval expired" },
  rate_limited: { status: 429, title: "Too many requests" },
  cosigner_unavailable: { status: 503, title: "Co-signer unavailable; failing closed" },
  screening_unavailable: { status: 503, title: "Screening unavailable; failing closed" },
  chain_error: { status: 502, title: "Chain or bundler error" },
  internal: { status: 500, title: "Internal error" },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const PROBLEM_TYPE_PREFIX = "urn:agentbank:problem:";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  [extension: string]: unknown;
}

export class AgentBankError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly extensions: Record<string, unknown>;

  constructor(code: ErrorCode, detail?: string, extensions: Record<string, unknown> = {}) {
    const entry = ERROR_CATALOG[code];
    super(detail ?? entry.title);
    this.name = "AgentBankError";
    this.code = code;
    this.status = entry.status;
    this.title = entry.title;
    this.extensions = extensions;
  }

  toProblem(instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      ...this.extensions,
      type: problemType(this.code),
      title: this.title,
      status: this.status,
      detail: this.message,
      code: this.code,
    };
    if (instance !== undefined) problem.instance = instance;
    return problem;
  }
}

export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_PREFIX}${code}`;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}

export function isAgentBankError(error: unknown): error is AgentBankError {
  return error instanceof AgentBankError;
}

/** Rebuild an error from a problem document received over the wire. */
export function errorFromProblem(problem: Partial<ProblemDetails>): AgentBankError {
  const code = isErrorCode(problem.code) ? problem.code : "internal";
  const { type: _t, title: _ti, status: _s, detail, code: _c, instance: _i, ...extensions } = problem;
  return new AgentBankError(code, typeof detail === "string" ? detail : undefined, extensions);
}

export function assert(condition: unknown, code: ErrorCode, detail?: string): asserts condition {
  if (!condition) throw new AgentBankError(code, detail);
}
