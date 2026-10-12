import { money, newId, type WebhookEventType } from "@agentbank/core";
import type { SqlClient, SqlParam } from "@agentbank/db";
import { all, type EscrowRow, type PaymentRow, type StreamRow } from "./rows";

/**
 * Webhook events, written to the API's transactional outbox (`event` + one `webhook_delivery`
 * per enabled, subscribed endpoint) in the same transaction as the change they describe. The row
 * format is exactly that of `emitEvent` in `packages/db/src/outbox.ts` (envelope
 * `{ id, type, created_at, data }`); this batched variant also caches endpoints per org for one
 * reconciler transaction.
 */

export interface PendingEvent {
  orgId: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
}

export class EventWriter {
  private readonly endpoints = new Map<string, { id: string; events: string[] }[]>();

  constructor(private readonly tx: SqlClient) {}

  /** Write events (each at its own time, or `at`) and their deliveries; returns the event ids. */
  async emit(events: readonly (PendingEvent & { at?: Date })[], at?: Date): Promise<string[]> {
    if (events.length === 0) return [];
    const missing = [...new Set(events.map((e) => e.orgId))].filter((org) => !this.endpoints.has(org));
    if (missing.length > 0) {
      const rows = await all<{ id: string; org_id: string; events: string[] }>(
        this.tx,
        "SELECT id, org_id, events FROM webhook_endpoint WHERE org_id = ANY($1::text[]) AND status = 'enabled'",
        [missing],
      );
      for (const org of missing) this.endpoints.set(org, []);
      for (const row of rows) this.endpoints.get(row.org_id)?.push({ id: row.id, events: row.events });
    }
    const ids: string[] = [];
    for (let i = 0; i < events.length; i += 1_000) {
      const chunk = events.slice(i, i + 1_000);
      const eventParams: SqlParam[] = [];
      const deliveryParams: SqlParam[] = [];
      for (const event of chunk) {
        const when = event.at ?? at ?? new Date();
        const id = newId("event", when.getTime());
        ids.push(id);
        eventParams.push(
          id,
          event.orgId,
          event.type,
          JSON.stringify({ id, type: event.type, created_at: when.toISOString(), data: event.data }),
          when,
        );
        for (const endpoint of this.endpoints.get(event.orgId) ?? []) {
          if (endpoint.events.includes(event.type)) {
            deliveryParams.push(newId("webhookDelivery", when.getTime()), endpoint.id, id, when);
          }
        }
      }
      await this.tx.query(
        `INSERT INTO event (id, org_id, type, payload, created_at) VALUES ${tuples(chunk.length, 5, { 3: "jsonb" })}`,
        eventParams,
      );
      if (deliveryParams.length > 0) {
        await this.tx.query(
          `INSERT INTO webhook_delivery (id, endpoint_id, event_id, next_attempt_at, created_at, updated_at)
           VALUES ${tuplesRepeat(deliveryParams.length / 4)}`,
          deliveryParams,
        );
      }
    }
    return ids;
  }
}

/** `($1, …, $n), (…)` for `rows` tuples of `columns` parameters. */
export function tuples(rows: number, columns: number, casts: Record<number, string> = {}): string {
  return Array.from(
    { length: rows },
    (_, row) =>
      `(${Array.from(
        { length: columns },
        (_, column) => `$${row * columns + column + 1}${casts[column] ? `::${casts[column]}` : ""}`,
      ).join(", ")})`,
  ).join(", ");
}

/** Delivery tuples: `(id, endpoint, event, at, at, at)` with the timestamp parameter reused. */
function tuplesRepeat(rows: number): string {
  return Array.from({ length: rows }, (_, row) => {
    const base = row * 4;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 4}, $${base + 4})`;
  }).join(", ");
}

// ---------------------------------------------------------------- resources

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

const WIRE_PAYMENT_KINDS = new Set(["transfer", "x402", "escrow", "stream", "payout", "refill"]);

/** The `Payment` resource (same shape as the API's), as carried by `payment.*` events. */
export function paymentResource(row: PaymentRow): Record<string, unknown> {
  return {
    id: row.id,
    object: "payment",
    account_id: row.account_id,
    kind: WIRE_PAYMENT_KINDS.has(row.kind) ? row.kind : "transfer",
    status: row.status,
    amount: money(row.amount),
    fee: money(row.fee),
    counterparty: {
      type: row.counterparty_type,
      address: row.counterparty_address,
      agent_id: row.counterparty_agent_id,
      x402_domain: row.counterparty_x402_domain,
    },
    memo: row.memo,
    mandate_id: row.mandate_id,
    payment_request_id: row.payment_request_id,
    decision: null,
    approval_id: row.approval_id,
    signing_request: null,
    owner_operation_id: row.owner_operation_id,
    user_op_hash: row.owner_operation_id || row.kind === "x402" ? null : row.user_op_hash,
    tx_hash: row.tx_hash,
    failure_reason: row.failure_reason,
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    settled_at: iso(row.settled_at),
  };
}

function counterpartyOf(address: string, agentId: string | null): Record<string, unknown> {
  return { type: agentId ? "agent" : "address", address, agent_id: agentId, x402_domain: null };
}

/** The `Escrow` resource, as carried by `escrow.*` events. */
export function escrowResource(row: EscrowRow): Record<string, unknown> {
  return {
    id: row.id,
    object: "escrow",
    payer_account_id: row.payer_account_id,
    payee: counterpartyOf(row.payee_address, row.payee_agent_id),
    amount: money(row.amount),
    fee: money(row.fee),
    status: row.status,
    release: row.release_mode,
    arbiter: row.arbiter,
    validator: row.validator_json,
    terms_hash: row.terms_hash,
    contract_address: row.contract_address,
    onchain_id: row.onchain_id,
    expires_at: iso(row.expires_at),
    signing_request: null,
    memo: row.memo,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** The `Stream` resource, as carried by `stream.*` events. */
export function streamResource(row: StreamRow): Record<string, unknown> {
  return {
    id: row.id,
    object: "stream",
    payer_account_id: row.payer_account_id,
    payee: counterpartyOf(row.payee_address, row.payee_agent_id),
    kind: row.kind,
    amount_per_interval: money(row.amount_per_interval),
    interval_seconds: row.interval_seconds,
    deposit: money(row.deposit),
    settled: money(row.settled),
    settle_every_seconds: row.settle_every_seconds,
    start_at: iso(row.start_at),
    stop_at: iso(row.stop_at),
    status: row.status,
    contract_address: row.contract_address,
    onchain_id: row.onchain_id,
    signing_request: null,
    created_at: iso(row.created_at),
  };
}

export interface AgentRowForEvent {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  did: string | null;
  erc8004_id: string | null;
  agent_card_url: string | null;
  status: "active" | "frozen";
  frozen_reason: string | null;
  pending_unfreeze_at: Date | null;
  metadata: Record<string, string> | null;
  created_at: Date;
}

/** The `Agent` resource, as carried by `agent.frozen`. */
export function agentResource(row: AgentRowForEvent): Record<string, unknown> {
  return {
    id: row.id,
    object: "agent",
    org_id: row.org_id,
    name: row.name,
    description: row.description,
    did: row.did,
    erc8004_id: row.erc8004_id,
    agent_card_url: row.agent_card_url,
    status: row.status,
    frozen_reason: row.frozen_reason,
    pending_unfreeze_at: iso(row.pending_unfreeze_at),
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
  };
}
