import { AgentBankError, canonicalSha256 } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { FastifyRequest } from "fastify";
import { one } from "../db/sql";

/**
 * API-level idempotency (`idempotency_record`). Every write route requires an
 * `Idempotency-Key`; the scope is the caller (org, agent or public) plus the operation id.
 *
 * - First request: the record is claimed (in flight), the handler runs, and the final status
 *   and body are stored (2xx and deterministic 4xx). 5xx and 429 release the claim so the
 *   client can retry.
 * - Same key, same request, completed: the stored response is replayed with
 *   `Idempotent-Replayed: true`.
 * - Same key, same request, still in flight: 409 `conflict`. A claim older than
 *   `IDEMPOTENCY_STALE_SECONDS` is considered abandoned and is taken over.
 * - Same key, different request: 409 `idempotency_conflict`.
 *
 * Secrets in responses (API keys, webhook secrets) are never stored: replays return them as
 * an empty string.
 */

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAYED_HEADER = "Idempotent-Replayed";
const KEY_RE = /^[\x21-\x7e]{8,255}$/;

export interface IdempotencyClaim {
  scope: string;
  key: string;
}

export type ClaimResult =
  | { kind: "claimed"; claim: IdempotencyClaim }
  | { kind: "replay"; status: number; body: unknown; contentType: string };

interface StoredResponse {
  content_type: string;
  body: unknown;
}

interface RecordRow {
  request_hash: string;
  status_code: number | null;
  response: StoredResponse | null;
  created_at: Date;
}

export function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined || key === "") {
    throw new AgentBankError("invalid_request", "The Idempotency-Key header is required for this operation");
  }
  if (!KEY_RE.test(key)) {
    throw new AgentBankError(
      "invalid_request",
      "Idempotency-Key must be 8 to 255 printable ASCII characters without spaces",
    );
  }
  return key;
}

/** Hash of what makes two requests "the same": method, URL (path and query) and JSON body. */
export function requestHash(request: FastifyRequest): string {
  return canonicalSha256({ method: request.method, url: request.url, body: request.body ?? null });
}

export async function claimIdempotency(
  db: SqlClient,
  input: { scope: string; key: string; requestHash: string; now: Date; staleSeconds: number },
): Promise<ClaimResult> {
  const claim = { scope: input.scope, key: input.key };
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await db.query<{ key: string }>(
      `INSERT INTO idempotency_record (scope, key, request_hash, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING key`,
      [input.scope, input.key, input.requestHash, input.now],
    );
    if (inserted.rows.length > 0) return { kind: "claimed", claim };

    const existing = await one<RecordRow>(
      db,
      "SELECT request_hash, status_code, response, created_at FROM idempotency_record WHERE scope = $1 AND key = $2",
      [input.scope, input.key],
    );
    if (!existing) continue; // released between our insert and select: try again
    if (existing.request_hash !== input.requestHash) {
      throw new AgentBankError(
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request",
      );
    }
    if (existing.status_code === null || existing.response === null) {
      const ageMs = input.now.getTime() - existing.created_at.getTime();
      if (ageMs > input.staleSeconds * 1000) {
        const taken = await db.query<{ key: string }>(
          `UPDATE idempotency_record SET created_at = $3
            WHERE scope = $1 AND key = $2 AND status_code IS NULL AND created_at = $4 RETURNING key`,
          [input.scope, input.key, input.now, existing.created_at],
        );
        if (taken.rows.length > 0) return { kind: "claimed", claim };
      }
      throw new AgentBankError("conflict", "A request with this Idempotency-Key is still being processed");
    }
    return {
      kind: "replay",
      status: existing.status_code,
      body: existing.response.body,
      contentType: existing.response.content_type,
    };
  }
  throw new AgentBankError("conflict", "Could not claim the Idempotency-Key; retry");
}

export async function completeIdempotency(
  db: SqlClient,
  claim: IdempotencyClaim,
  status: number,
  body: unknown,
  contentType: string,
): Promise<void> {
  const stored: StoredResponse = { content_type: contentType, body };
  await db.query(
    "UPDATE idempotency_record SET status_code = $3, response = $4 WHERE scope = $1 AND key = $2",
    [claim.scope, claim.key, status, stored as unknown as object],
  );
}

export async function releaseIdempotency(db: SqlClient, claim: IdempotencyClaim): Promise<void> {
  await db.query("DELETE FROM idempotency_record WHERE scope = $1 AND key = $2 AND status_code IS NULL", [
    claim.scope,
    claim.key,
  ]);
}

/** Replace every `secret` field with an empty string before a response is stored for replay. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "secret" && typeof v === "string" ? "" : redactSecrets(v);
    }
    return out;
  }
  return value;
}
