import { newId } from "@agentbank/core";

/**
 * Ids for internal rows that never appear in the public API (outbox items, console sessions,
 * challenges, invites): a short prefix plus the same time-sortable ULID body as public ids.
 */
export function internalId(prefix: "cso" | "csn" | "wch" | "inv" | "pks", now: Date): string {
  return `${prefix}_${newId("audit", now.getTime()).slice("aud_".length)}`;
}
