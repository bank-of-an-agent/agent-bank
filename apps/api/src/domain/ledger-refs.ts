import type { LedgerAccountRef } from "@agentbank/ledger";

/**
 * Ledger account refs used by the API (see the ledger account table in docs/architecture.md).
 * Codes: `pocket:<pocket>` owned by an account id, and `sys:*` owned by `system`.
 */

export const ASSET = "USDC";

export type ApiPocket =
  | "operating"
  | "reserved"
  | "fees"
  | "savings"
  | "escrow"
  | "stream"
  | "spend"
  | "spend_reserved"
  | `vault:${string}`;

export function pocket(accountId: string, name: ApiPocket): LedgerAccountRef {
  return { ownerRef: accountId, code: `pocket:${name}`, asset: ASSET };
}

export function vaultPocketRef(accountId: string, vaultId: string): LedgerAccountRef {
  return pocket(accountId, `vault:${vaultId}`);
}

/** Mirror of value entering and leaving Agent Bank on a chain. */
export function chainMirror(chainId: number): LedgerAccountRef {
  return { ownerRef: "system", code: `sys:chain:${chainId}:${ASSET}`, asset: ASSET };
}

export function revenue(): LedgerAccountRef {
  return { ownerRef: "system", code: "sys:revenue", asset: ASSET };
}
