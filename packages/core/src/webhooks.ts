import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { AgentBankError } from "./errors";
import { bytesToHex, hexToBytes, timingSafeEqual, utf8 } from "./encoding";

/**
 * Webhook signatures: `AgentBank-Signature: t=<unix seconds>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Receivers must verify against
 * the raw request body and reject timestamps outside the tolerance window.
 */

export const WEBHOOK_SIGNATURE_HEADER = "agentbank-signature";
export const WEBHOOK_EVENT_HEADER = "agentbank-event";
export const WEBHOOK_ID_HEADER = "agentbank-delivery";
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export const WEBHOOK_EVENT_TYPES = [
  "payment.created",
  "payment.requires_approval",
  "payment.submitted",
  "payment.settled",
  "payment.failed",
  "payment.denied",
  "approval.requested",
  "approval.decided",
  "escrow.locked",
  "escrow.released",
  "escrow.refunded",
  "escrow.disputed",
  "stream.created",
  "stream.settled",
  "stream.canceled",
  "deposit.received",
  "reconciliation.mismatch",
  "agent.frozen",
  "agent.unfrozen",
  "org.frozen",
  "policy.updated",
  "session.revoked",
  "balance.low",
  "statement.ready",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

function mac(secret: string, timestamp: number, body: string): Uint8Array {
  return hmac(sha256, utf8(secret), utf8(`${timestamp}.${body}`));
}

export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${bytesToHex(mac(secret, timestamp, body)).slice(2)}`;
}

export interface VerifyWebhookOptions {
  toleranceSeconds?: number;
  now?: number;
}

/** Verify a webhook signature header. Returns the signed timestamp. */
export function verifyWebhook(
  secret: string,
  body: string,
  header: string | undefined,
  options: VerifyWebhookOptions = {},
): number {
  if (!header) throw new AgentBankError("signature_invalid", "Missing AgentBank-Signature header");
  const parts = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const list = parts.get(k) ?? [];
    list.push(part.slice(idx + 1).trim());
    parts.set(k, list);
  }
  const t = Number(parts.get("t")?.[0]);
  if (!Number.isInteger(t))
    throw new AgentBankError("signature_invalid", "Webhook signature missing timestamp");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) {
    throw new AgentBankError("signature_invalid", "Webhook timestamp outside tolerance");
  }
  const expected = mac(secret, t, body);
  const candidates = parts.get("v1") ?? [];
  const ok = candidates.some((c) => {
    try {
      return timingSafeEqual(hexToBytes(c), expected);
    } catch {
      return false;
    }
  });
  if (!ok) throw new AgentBankError("signature_invalid", "Webhook signature mismatch");
  return t;
}

/** Retry schedule (seconds after first attempt) covering 72 hours with backoff. */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS: readonly number[] = [
  0, 30, 120, 600, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200, 86_400, 129_600, 172_800, 216_000, 259_200,
];
