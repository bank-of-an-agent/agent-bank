import {
  signWebhook,
  unixSeconds,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "@agentbank/core";
import type { EventRow, WebhookDeliveryRow, WebhookEndpointRow } from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import { emitMetric } from "../metrics";
import { serializeEvent } from "../serializers";
import { openSecret } from "../util/secrets";

/**
 * Webhook delivery (worker). Each due delivery is claimed with a short lease (so several
 * workers never send the same delivery at once and a crashed worker's claim expires), POSTed
 * as the event JSON with `AgentBank-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` (core
 * `signWebhook`), and retried on the `WEBHOOK_RETRY_SCHEDULE_SECONDS` schedule (offsets from
 * the first attempt, up to 72 hours). After the last attempt the delivery is dead-lettered
 * and `AgentBank/Webhooks DeadLetteredDeliveries` is emitted.
 */

const LEASE_SECONDS = 60;
const MAX_ERROR_LENGTH = 500;

export interface DeliveryOptions {
  fetch?: typeof fetch;
  limit?: number;
}

interface Claimed extends WebhookDeliveryRow {
  url: string;
  secret: string;
  endpoint_status: WebhookEndpointRow["status"];
}

export async function deliverWebhooks(deps: AppDeps, options: DeliveryOptions = {}): Promise<number> {
  const now = deps.clock.now();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const lease = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const claimed = await all<Claimed>(
    deps.db,
    `WITH due AS (
       SELECT id FROM webhook_delivery
        WHERE status = 'pending' AND next_attempt_at <= $1
        ORDER BY next_attempt_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_delivery d SET next_attempt_at = $2
       FROM due, webhook_endpoint e
      WHERE d.id = due.id AND e.id = d.endpoint_id
      RETURNING d.*, e.url, e.secret, e.status AS endpoint_status`,
    [now, lease, options.limit ?? 50],
  );
  let delivered = 0;
  for (const delivery of claimed) {
    if (delivery.endpoint_status !== "enabled") {
      await deps.db.query(
        "UPDATE webhook_delivery SET status = 'dead', last_error = 'endpoint disabled', updated_at = $2 WHERE id = $1",
        [delivery.id, now],
      );
      continue;
    }
    const event = await one<EventRow>(deps.db, "SELECT * FROM event WHERE id = $1", [delivery.event_id]);
    if (!event) continue;
    const body = JSON.stringify(serializeEvent(event));
    let status: number | null = null;
    let error: string | null = null;
    try {
      const secret = openSecret(delivery.secret, deps.config.webhookSigningKey);
      const res = await fetchImpl(delivery.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "AgentBank-Webhooks/1",
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body, unixSeconds(deps.clock.now())),
          [WEBHOOK_EVENT_HEADER]: event.type,
          [WEBHOOK_ID_HEADER]: delivery.id,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(deps.config.webhookTimeoutMs),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      error =
        (e as Error)?.name === "TimeoutError"
          ? "timeout"
          : `network error: ${(e as Error)?.message ?? "unknown"}`;
    }
    const attempt = delivery.attempt + 1;
    if (!error) {
      await deps.db.query(
        `UPDATE webhook_delivery SET status = 'succeeded', attempt = $2, last_status_code = $3, last_error = NULL, updated_at = $4
          WHERE id = $1`,
        [delivery.id, attempt, status, deps.clock.now()],
      );
      delivered++;
      continue;
    }
    const schedule = deps.config.webhookRetryScheduleSeconds;
    const nextOffset = schedule[attempt];
    if (nextOffset === undefined) {
      await deps.db.query(
        `UPDATE webhook_delivery SET status = 'dead', attempt = $2, last_status_code = $3, last_error = $4, updated_at = $5
          WHERE id = $1`,
        [delivery.id, attempt, status, error.slice(0, MAX_ERROR_LENGTH), deps.clock.now()],
      );
      deps.logger.warn(
        { deliveryId: delivery.id, endpointId: delivery.endpoint_id, attempts: attempt },
        "webhook delivery dead-lettered",
      );
      emitMetric(
        deps.logger,
        deps.config.metricsNamespace !== undefined,
        "AgentBank/Webhooks",
        "DeadLetteredDeliveries",
        1,
      );
      continue;
    }
    const next = new Date(Math.max(delivery.created_at.getTime() + nextOffset * 1000, now.getTime()));
    await deps.db.query(
      `UPDATE webhook_delivery SET attempt = $2, next_attempt_at = $3, last_status_code = $4, last_error = $5, updated_at = $6
        WHERE id = $1`,
      [delivery.id, attempt, next, status, error.slice(0, MAX_ERROR_LENGTH), deps.clock.now()],
    );
  }
  return delivered;
}
