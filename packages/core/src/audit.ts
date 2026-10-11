import { sha256, stringToBytes, type Hex } from "viem";
import { canonicalJson } from "./canonical";

/**
 * Hash-chained audit records. Each record commits to the previous record's
 * hash, so deleting or editing any decision, approval, co-signature or admin
 * action breaks the chain and is detected by `verifyAuditChain`.
 */

export const GENESIS_HASH: Hex = `0x${"0".repeat(64)}`;

export interface AuditRecordBody {
  seq: number;
  at: string;
  actor: string;
  action: string;
  subject: string;
  payload: unknown;
}

export interface AuditRecord extends AuditRecordBody {
  prevHash: Hex;
  hash: Hex;
}

export function hashAuditRecord(prevHash: Hex, body: AuditRecordBody): Hex {
  return sha256(stringToBytes(`${prevHash}|${canonicalJson(body)}`));
}

export function appendAudit(prev: AuditRecord | undefined, body: Omit<AuditRecordBody, "seq">): AuditRecord {
  const prevHash = prev?.hash ?? GENESIS_HASH;
  const full: AuditRecordBody = { ...body, seq: (prev?.seq ?? 0) + 1 };
  return { ...full, prevHash, hash: hashAuditRecord(prevHash, full) };
}

/** Returns the index of the first broken record, or -1 if the chain is intact. */
export function verifyAuditChain(records: readonly AuditRecord[]): number {
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) return i;
    const { prevHash: p, hash, ...body } = r;
    if (p !== prevHash || r.seq !== prevSeq + 1 || hashAuditRecord(p, body) !== hash) return i;
    prevHash = hash;
    prevSeq = r.seq;
  }
  return -1;
}
