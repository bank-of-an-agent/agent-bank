import {
  verifyWebhook,
  WEBHOOK_EVENT_TYPES,
  type VerifyWebhookOptions,
  type WebhookEventType,
} from "@agentbank/core";
import { AuthenticationError, InvalidRequestError } from "./errors";
import type { Agent, Approval, Escrow, Org, Payment, Session, Statement, Stream } from "./types";

/**
 * Webhook receivers: verify the `AgentBank-Signature` header (HMAC-SHA256
 * over `${timestamp}.${rawBody}`, timestamp within 5 minutes) and parse the
 * event into a typed union.
 *
 * Always verify against the **raw** request body (before any JSON parsing or
 * re-serialization), and deduplicate on the event id: deliveries are retried
 * with backoff for 72 hours.
 *
 * @packageDocumentation
 */

export {
  verifyWebhook,
  signWebhook,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
} from "@agentbank/core";
export type { VerifyWebhookOptions, WebhookEventType } from "@agentbank/core";

/**
 * `data` payload per event type: the resource the event is about. Events
 * whose payload has no dedicated resource schema are typed loosely.
 */
export interface WebhookEventDataMap {
  "payment.created": Payment;
  "payment.requires_approval": Payment;
  "payment.submitted": Payment;
  "payment.settled": Payment;
  "payment.failed": Payment;
  "payment.denied": Payment;
  "approval.requested": Approval;
  "approval.decided": Approval;
  "escrow.locked": Escrow;
  "escrow.released": Escrow;
  "escrow.refunded": Escrow;
  "escrow.disputed": Escrow;
  "stream.created": Stream;
  "stream.settled": Stream;
  "stream.canceled": Stream;
  "deposit.received": Record<string, unknown>;
  "reconciliation.mismatch": Record<string, unknown>;
  "agent.frozen": Agent;
  "agent.unfrozen": Agent;
  "org.frozen": Org;
  "policy.updated": Record<string, unknown>;
  "session.revoked": Session;
  "balance.low": Record<string, unknown>;
  "statement.ready": Statement | Record<string, unknown>;
}

/** A verified webhook event, discriminated on `type`. */
export type WebhookEvent = {
  [T in WebhookEventType]: {
    id: string;
    type: T;
    data: T extends keyof WebhookEventDataMap ? WebhookEventDataMap[T] : Record<string, unknown>;
    org_id?: string;
    created_at?: string;
    [field: string]: unknown;
  };
}[WebhookEventType];

/** Input of {@link parseWebhookEvent}. */
export interface ParseWebhookInput {
  /** The endpoint's signing secret (`whsec_…`), from `webhooks.createEndpoint`. */
  secret: string;
  /** The raw request body, exactly as received. */
  body: string | Uint8Array;
  /** Value of the `AgentBank-Signature` header. */
  signature: string | null | undefined;
}

/**
 * Verify a webhook delivery and parse it into a typed {@link WebhookEvent}.
 *
 * @throws {@link AuthenticationError} (`signature_invalid`) if the signature
 *   or timestamp does not verify.
 * @throws {@link InvalidRequestError} if the verified body is not an event.
 *
 * @example Express
 * ```ts
 * app.post("/webhooks/agentbank", express.raw({ type: "application/json" }), (req, res) => {
 *   const event = parseWebhookEvent({ secret, body: req.body, signature: req.get("agentbank-signature") });
 *   if (event.type === "payment.settled") console.log(event.data.amount.amount);
 *   res.sendStatus(204);
 * });
 * ```
 */
export function parseWebhookEvent(
  input: ParseWebhookInput,
  options: VerifyWebhookOptions = {},
): WebhookEvent {
  const body = typeof input.body === "string" ? input.body : new TextDecoder().decode(input.body);
  try {
    verifyWebhook(input.secret, body, input.signature ?? undefined, options);
  } catch (error) {
    throw new AuthenticationError(
      "signature_invalid",
      error instanceof Error ? error.message : "Webhook signature invalid",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidRequestError("invalid_request", "Webhook body is not JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { type?: unknown }).type !== "string" ||
    typeof (parsed as { data?: unknown }).data !== "object" ||
    (parsed as { data?: unknown }).data === null
  ) {
    throw new InvalidRequestError("invalid_request", "Webhook body is not an Agent Bank event");
  }
  return parsed as WebhookEvent;
}

/** True if `type` is an event type this SDK version knows. */
export function isKnownWebhookEventType(type: string): type is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}
