import type { ErrorCode } from "@agentbank/core";
import { AgentBankApiError } from "../errors";
import type { DisclosureClass, ProofAttribute, ProofRequest } from "../types";

/**
 * Why the SDK did not (or could not) produce or deliver a proof:
 *
 * - `proof_secret_missing`: the client has no `proofSecret`.
 * - `invalid_request`: the proof request (or the `AGENT-PROOF-REQUIRED` header) is malformed.
 * - `request_expired`: the request expired before it could be proved.
 * - `scope_mismatch`: a server asked for a proof for another verifier's scope than its own
 *   host name (a relayed challenge); nothing was proved.
 * - `rate_limited`: the probing guard refused (`maxPresentationsPerScopePerHour`).
 * - `reservation_required`: the request asks for reserved funds and no matching active
 *   reservation exists: call `agent.proofs.reserve(...)` first.
 * - `reservation_pending`: a matching reservation exists but no root includes it yet.
 * - `unsatisfiable`, `undisclosed`, `witness_mismatch`, `chain_mismatch`: the prover refused
 *   before proving (attested values outside the bounds, classes the owner did not disclose,
 *   wrong secret or stale witness, another chain or registry).
 * - `invalid_witness`: Agent Bank returned a witness the prover cannot use.
 * - `proof_rejected`: the verifier answered a fresh proof with another challenge.
 * - `prover_unavailable`: the prover or its circuit files could not be loaded.
 */
export type ProofErrorReason =
  | "proof_secret_missing"
  | "invalid_request"
  | "request_expired"
  | "scope_mismatch"
  | "rate_limited"
  | "reservation_required"
  | "reservation_pending"
  | "unsatisfiable"
  | "undisclosed"
  | "witness_mismatch"
  | "chain_mismatch"
  | "invalid_witness"
  | "proof_rejected"
  | "prover_unavailable";

const CODE_BY_REASON: Record<ProofErrorReason, ErrorCode> = {
  proof_secret_missing: "invalid_request",
  invalid_request: "invalid_request",
  request_expired: "invalid_request",
  scope_mismatch: "forbidden",
  rate_limited: "rate_limited",
  reservation_required: "invalid_state",
  reservation_pending: "invalid_state",
  unsatisfiable: "forbidden",
  undisclosed: "forbidden",
  witness_mismatch: "conflict",
  chain_mismatch: "unsupported_chain",
  invalid_witness: "internal",
  proof_rejected: "unauthorized",
  prover_unavailable: "internal",
};

/** What a request needs reserved, for `reservation_required` / `reservation_pending`. */
export interface ReservationNeeded {
  /** Smallest amount the verifier accepts, decimal USDC. */
  amount: string;
  /** The verifier's scope, when the request's reservation tag is its own scope's. */
  scope: string | undefined;
  /** The 64-bit tag the reservation must carry, base-10 (`scope_tag`). */
  scopeTag: string | undefined;
  /** Earliest expiry the verifier accepts, unix seconds (0 when unconstrained). */
  until: number;
}

/** Context of a {@link ProofError}. */
export interface ProofErrorContext {
  /** Attributes outside the requested bounds (or constrained but undisclosed). */
  attributes?: readonly ProofAttribute[];
  /** Classes the request constrains that the owner did not disclose. */
  undisclosedClasses?: readonly DisclosureClass[];
  /** The proof request concerned, when it parsed. */
  request?: ProofRequest;
  /** The verifier's response, for `proof_rejected`. */
  response?: Response;
  /** The verifier's failure reason (`invalid_proof`, `nonce_reused`, …), for `proof_rejected`. */
  verifierReason?: string | null;
  /** For `rate_limited`: when the next presentation to this scope is allowed. */
  retryAfterMs?: number;
  /** For `reservation_required` / `reservation_pending`. */
  reservationNeeded?: ReservationNeeded;
  cause?: unknown;
}

/**
 * The SDK did not prove (or the verifier refused a proof). `reason` says why; `code` is the
 * closest code of the API's error catalog. Messages never contain the proof secret.
 */
export class ProofError extends AgentBankApiError {
  readonly reason: ProofErrorReason;
  readonly attributes: readonly ProofAttribute[];
  readonly undisclosedClasses: readonly DisclosureClass[];
  readonly request: ProofRequest | undefined;
  readonly response: Response | undefined;
  readonly verifierReason: string | null;
  readonly retryAfterMs: number | undefined;
  readonly reservationNeeded: ReservationNeeded | undefined;

  constructor(reason: ProofErrorReason, detail: string, context: ProofErrorContext = {}) {
    super(
      CODE_BY_REASON[reason],
      detail,
      { reason },
      context.cause !== undefined ? { cause: context.cause } : {},
    );
    this.reason = reason;
    this.attributes = context.attributes ?? [];
    this.undisclosedClasses = context.undisclosedClasses ?? [];
    this.request = context.request;
    this.response = context.response;
    this.verifierReason = context.verifierReason ?? null;
    this.retryAfterMs = context.retryAfterMs;
    this.reservationNeeded = context.reservationNeeded;
  }
}
