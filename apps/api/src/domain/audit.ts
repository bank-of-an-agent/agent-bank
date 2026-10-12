import { appendAudit, type AuditRecord } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Hex } from "viem";
import type { AuthContext } from "../http/auth";
import { one } from "../db/sql";

/**
 * Hash-chained audit log (`audit_log`, append-only by trigger) of admin actions, policy
 * changes, approvals and authority grants. Each record commits to the previous record's hash,
 * so editing or deleting history is detectable with `verifyAuditChain` from core.
 */

interface AuditRow {
  seq: bigint;
  at: Date;
  actor: string;
  action: string;
  subject: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export function actorOf(auth: AuthContext): string {
  switch (auth.kind) {
    case "principal":
      return auth.via === "api_key" ? `api_key:${auth.apiKeyId}` : `member:${auth.memberId}`;
    case "agent":
      return `agent:${auth.agentId}`;
    case "staff":
      return "staff";
    case "public":
      return "public";
  }
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    seq: Number(row.seq),
    at: row.at.toISOString(),
    actor: row.actor,
    action: row.action,
    subject: row.subject,
    payload: row.payload,
    prevHash: row.prev_hash as Hex,
    hash: row.hash as Hex,
  };
}

/** Append one record. Must run inside the transaction that makes the audited change. */
export async function audit(
  tx: SqlClient,
  now: Date,
  input: { actor: string; action: string; subject: string; payload?: unknown },
): Promise<void> {
  const prev = await one<AuditRow>(tx, "SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1");
  const record = appendAudit(prev ? toRecord(prev) : undefined, {
    at: now.toISOString(),
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    payload: JSON.parse(
      JSON.stringify(input.payload ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  });
  await tx.query(
    `INSERT INTO audit_log (seq, at, actor, action, subject, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      BigInt(record.seq),
      new Date(record.at),
      record.actor,
      record.action,
      record.subject,
      record.payload as object,
      record.prevHash,
      record.hash,
    ],
  );
}

/** All audit records in order (tests and the nightly verification). */
export async function loadAuditChain(db: SqlClient): Promise<AuditRecord[]> {
  const { rows } = await db.query<AuditRow>("SELECT * FROM audit_log ORDER BY seq");
  return rows.map(toRecord);
}
