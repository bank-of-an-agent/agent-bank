/**
 * Reason codes the facilitator returns as x402 `invalidReason` (verify) and `errorReason`
 * (settle). Codes from the x402 specification are used where one exists; Agent Bank adds codes
 * for its stricter checks. Codes are stable: sellers and the SDK may branch on them.
 */
export const REASONS = {
  // --- request shape (HTTP 400: the body does not match the core contract) -------------------
  invalid_payload: "The request body or payment payload is malformed",
  invalid_payment_requirements: "The payment requirements are malformed",

  // --- what this facilitator serves ------------------------------------------------------------
  invalid_x402_version: "Only x402 version 2 is supported",
  unsupported_scheme: "Only the exact scheme is supported",
  invalid_network: "The network is not served by this facilitator",
  unsupported_asset: "Only USDC on the served network is supported",
  accepted_requirements_mismatch: "paymentPayload.accepted does not match paymentRequirements",
  unsupported_payload_type: "Only EIP-3009 transferWithAuthorization payloads are supported",

  // --- the EIP-3009 authorization ----------------------------------------------------------------
  invalid_exact_evm_payload_nonce: "The authorization nonce must be 32 bytes",
  invalid_exact_evm_payload_recipient_mismatch: "authorization.to does not match payTo",
  invalid_exact_evm_payload_authorization_value: "authorization.value does not equal the required amount",
  invalid_exact_evm_payload_authorization_valid_after: "The authorization is not valid yet",
  invalid_exact_evm_payload_authorization_valid_before:
    "The authorization has expired or expires within 6 seconds",
  invalid_exact_evm_payload_authorization_validity_too_long:
    "The authorization stays valid longer than maxTimeoutSeconds + 60 seconds",
  invalid_exact_evm_payload_signature: "The signature is not a valid authorization by the payer",
  payer_not_deployed: "The payer is an undeployed (counterfactual) contract wallet; USDC cannot verify it",
  payer_has_code:
    "The payer has code (a contract wallet or an EIP-7702 delegated EOA) and its ERC-1271 isValidSignature rejects this ECDSA signature",
  amount_exceeds_max_settlement: "The amount exceeds this facilitator's maximum settlement",

  // --- who may be paid ---------------------------------------------------------------------------
  payee_not_registered:
    "payTo is not an Agent Bank account registered as an x402 payee (FACILITATOR_PAYEE_MODE=registered)",

  // --- state (local single-use table, chain, screening) -----------------------------------------
  authorization_already_used: "This authorization was already submitted for settlement",
  invalid_exact_evm_nonce_already_used: "The authorization nonce is already used or canceled on-chain",
  insufficient_funds: "The payer's balance is below the amount",
  payer_blocked_by_screening: "The payer is blocked by wallet screening",
  payee_blocked_by_screening: "The payee is blocked by wallet screening",

  // --- settlement --------------------------------------------------------------------------------
  settlement_in_progress: "Another request is settling this authorization",
  settlement_pending: "The settlement transaction was submitted but is not confirmed yet; retry settle",
  invalid_transaction_state: "The settlement transaction reverted",

  // --- load: retry later --------------------------------------------------------------------------
  rate_limited: "Too many requests from this client; retry after the Retry-After interval",
  facilitator_busy: "Too many settlements in flight; retry shortly",

  // --- infrastructure: fail closed (HTTP 5xx) ---------------------------------------------------
  screening_unavailable: "Wallet screening is unavailable; failing closed",
  chain_unavailable: "The chain RPC is unavailable; failing closed",
  facilitator_unavailable:
    "The facilitator cannot settle right now (database or relayer gas); failing closed",
  unexpected_verify_error: "Unexpected error during verification",
  unexpected_settle_error: "Unexpected error during settlement",
} as const;

export type ReasonCode = keyof typeof REASONS;

/** HTTP status for a rejection. Everything not listed is a regular x402 answer (200). */
const STATUS: Partial<Record<ReasonCode, number>> = {
  rate_limited: 429,
  facilitator_busy: 503,
  screening_unavailable: 503,
  facilitator_unavailable: 503,
  chain_unavailable: 502,
  unexpected_verify_error: 500,
  unexpected_settle_error: 500,
};

/** Reasons that mean the facilitator could not decide (fail closed), not that the payment is bad. */
export function isInfrastructureReason(reason: ReasonCode): boolean {
  return (STATUS[reason] ?? 200) >= 500;
}

/** A refused payment: the reason code, a human-readable message and the HTTP status to answer with. */
export interface Rejection {
  reason: ReasonCode;
  message: string;
  status: number;
  /** Payer address, when the payload was parsed far enough to know it. */
  payer?: string;
}

export function reject(reason: ReasonCode, message?: string, payer?: string): Rejection {
  return {
    reason,
    message: message ?? REASONS[reason],
    status: STATUS[reason] ?? 200,
    ...(payer !== undefined ? { payer } : {}),
  };
}

/** Body-shape rejections are answered with HTTP 400 (still in the x402 response shape). */
export function malformed(
  reason: "invalid_payload" | "invalid_payment_requirements",
  message: string,
): Rejection {
  return { reason, message, status: 400 };
}

export function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rejection).reason === "string" &&
    typeof (value as Rejection).status === "number" &&
    Object.hasOwn(REASONS, (value as Rejection).reason)
  );
}
