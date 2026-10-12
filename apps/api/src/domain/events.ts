import { newId, type WebhookEventType } from "@agentbank/core";
import { emitEvent as emitOutboxEvent, type SqlClient } from "@agentbank/db";

/**
 * Event outbox. Every state change that clients may care about writes an `event` row and one
 * `webhook_delivery` row per enabled, subscribed endpoint, in the same database transaction as
 * the change itself, so an event is published if and only if the change committed. The rows are
 * written by `emitEvent` from `@agentbank/db` (shared with the reconciler): `event.payload` is the
 * wire `Event` resource `{ id, object: "event", type, org_id, created_at, data }`, exactly what
 * webhook receivers get. The worker delivers pending deliveries (see `jobs/webhooks.ts`).
 */

export interface EmitEventInput {
  orgId: string;
  type: WebhookEventType;
  /** JSON-safe payload (usually the affected resource as returned by the API). */
  data: Record<string, unknown>;
}

export async function emitEvent(tx: SqlClient, now: Date, input: EmitEventInput): Promise<string> {
  const { eventId } = await emitOutboxEvent(tx, {
    id: newId("event", now.getTime()),
    deliveryId: () => newId("webhookDelivery", now.getTime()),
    orgId: input.orgId,
    type: input.type,
    data: input.data,
    at: now,
  });
  return eventId;
}

/** The resource carried by an event row (`payload.data`; older rows stored the bare resource). */
export function eventData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  if (data !== null && typeof data === "object" && typeof payload.type === "string") {
    return data as Record<string, unknown>;
  }
  return payload;
}
