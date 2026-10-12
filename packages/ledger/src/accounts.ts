import { AgentBankError, assertTestnet, isId } from "@agentbank/core";
import {
  STANDARD_POCKETS,
  SYSTEM_OWNER,
  type FundsLocation,
  type HoldSource,
  type LedgerAccountRef,
  type Pocket,
  type StandardPocket,
  type VaultPocket,
} from "./types";

/**
 * Ledger account codes, refs and funds locations.
 *
 * | Code                          | Owner   | Location                                    |
 * | ----------------------------- | ------- | ------------------------------------------- |
 * | `pocket:operating`            | account | `smart_account`                             |
 * | `pocket:reserved`             | account | `smart_account`                             |
 * | `pocket:fees`                 | account | `smart_account`                             |
 * | `pocket:savings`              | account | `smart_account`                             |
 * | `pocket:vault:<vlt_id>`       | account | `smart_account` (goal) or `vault_contract`  |
 * | `pocket:escrow`               | account | `escrow_contract`                           |
 * | `pocket:stream`               | account | `stream_contract`                           |
 * | `pocket:spend`                | account | `spend_key`                                 |
 * | `pocket:spend_reserved`       | account | `spend_key`                                 |
 * | `sys:chain:<chainId>:<asset>` | system  | `external`                                  |
 * | `sys:revenue`                 | system  | `revenue_address`                           |
 * | `sys:suspense`                | system  | `none`                                      |
 */

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const ASSET_RE = /^[A-Z0-9]{2,16}$/;
const POCKET_RE = new RegExp(`^pocket:(${STANDARD_POCKETS.join("|")}|vault:(vlt_${ULID}))$`);
const SYSTEM_RE = /^sys:(revenue|suspense|chain:([1-9][0-9]{0,14}):([A-Z0-9]{2,16}))$/;

/** Funds location of each standard pocket. */
export const POCKET_LOCATIONS: Readonly<Record<StandardPocket, FundsLocation>> = {
  operating: "smart_account",
  reserved: "smart_account",
  fees: "smart_account",
  savings: "smart_account",
  escrow: "escrow_contract",
  stream: "stream_contract",
  spend: "spend_key",
  spend_reserved: "spend_key",
};

/** The reserve pocket each hold source moves funds into. */
export const HOLD_RESERVES: Readonly<Record<HoldSource, StandardPocket>> = {
  operating: "reserved",
  spend: "spend_reserved",
};

/** Pockets that only hold operations may change, so they always equal their pending holds. */
export const RESERVE_POCKETS: readonly StandardPocket[] = ["reserved", "spend_reserved"];

/** A parsed ledger account code. */
export type ParsedCode =
  | { kind: "pocket"; pocket: Pocket; vaultId: string | null }
  | { kind: "revenue" | "suspense" }
  | { kind: "chain"; chainId: number; asset: string };

/** The ledger account code of a pocket, e.g. `pocket:operating`. */
export function pocketCode(pocket: Pocket): string {
  return `pocket:${pocket}`;
}

/** The pocket name of a goal or locked vault. */
export function vaultPocket(vaultId: string): VaultPocket {
  return `vault:${vaultId}`;
}

/** Ref of a bank account's pocket. */
export function pocketRef(accountId: string, pocket: Pocket, asset: string): LedgerAccountRef {
  return { ownerRef: accountId, code: pocketCode(pocket), asset };
}

/** Ref of a bank account's vault pocket (`pocket:vault:<vlt_id>`). */
export function vaultRef(accountId: string, vaultId: string, asset: string): LedgerAccountRef {
  return pocketRef(accountId, vaultPocket(vaultId), asset);
}

/** Ref of the chain mirror account `sys:chain:<chainId>:<asset>`. */
export function chainRef(chainId: number, asset: string): LedgerAccountRef {
  return { ownerRef: SYSTEM_OWNER, code: `sys:chain:${chainId}:${asset}`, asset };
}

/** Ref of the fee income account `sys:revenue`. */
export function revenueRef(asset: string): LedgerAccountRef {
  return { ownerRef: SYSTEM_OWNER, code: "sys:revenue", asset };
}

/** Ref of the suspense account `sys:suspense` (unmatched chain movements awaiting review). */
export function suspenseRef(asset: string): LedgerAccountRef {
  return { ownerRef: SYSTEM_OWNER, code: "sys:suspense", asset };
}

/** Parse a ledger account code; `invalid_request` if it is not one the ledger knows. */
export function parseCode(code: string): ParsedCode {
  const pocket = POCKET_RE.exec(code);
  if (pocket) {
    return { kind: "pocket", pocket: pocket[1] as Pocket, vaultId: pocket[2] ?? null };
  }
  const system = SYSTEM_RE.exec(code);
  if (!system) throw new AgentBankError("invalid_request", `Unknown ledger account code "${code}"`);
  if (system[1] === "revenue" || system[1] === "suspense") return { kind: system[1] };
  return { kind: "chain", chainId: Number(system[2]), asset: system[3] as string };
}

/** Locations a ledger account with this code may have; the first is the default. */
export function allowedLocations(parsed: ParsedCode): readonly FundsLocation[] {
  switch (parsed.kind) {
    case "pocket":
      return parsed.vaultId === null
        ? [POCKET_LOCATIONS[parsed.pocket as StandardPocket]]
        : ["smart_account", "vault_contract"];
    case "chain":
      return ["external"];
    case "revenue":
      return ["revenue_address"];
    case "suspense":
      return ["none"];
  }
}

/** Whether a code names one of the hold-managed {@link RESERVE_POCKETS}. */
export function isReserveCode(code: string): boolean {
  return RESERVE_POCKETS.some((pocket) => code === pocketCode(pocket));
}

/** Map key of a ref. */
export function refKey(ref: LedgerAccountRef): string {
  return `${ref.ownerRef}|${ref.code}|${ref.asset}`;
}

/** A validated ref together with its parsed code. */
export interface ResolvedRef {
  ref: LedgerAccountRef;
  parsed: ParsedCode;
  key: string;
}

/**
 * Validate a ref against the ledger's assets and code rules. Throws `invalid_request` for a
 * malformed ref, `unsupported_asset`, and `mainnet_locked` / `unsupported_chain` for chain
 * accounts outside the supported testnets.
 */
export function resolveRef(value: unknown, assets: ReadonlySet<string>): ResolvedRef {
  if (typeof value !== "object" || value === null) {
    throw new AgentBankError("invalid_request", "A ledger account ref must be an object");
  }
  const { ownerRef, code, asset } = value as Partial<Record<keyof LedgerAccountRef, unknown>>;
  if (typeof ownerRef !== "string" || typeof code !== "string" || typeof asset !== "string") {
    throw new AgentBankError(
      "invalid_request",
      "A ledger account ref needs ownerRef, code and asset strings",
    );
  }
  assertAsset(asset, assets);
  const parsed = parseCode(code);
  if (parsed.kind === "pocket") {
    if (!isId("account", ownerRef)) {
      throw new AgentBankError("invalid_request", `Pocket owner "${ownerRef}" is not an account id`);
    }
  } else {
    if (ownerRef !== SYSTEM_OWNER) {
      throw new AgentBankError(
        "invalid_request",
        `System account ${code} must be owned by "${SYSTEM_OWNER}"`,
      );
    }
    if (parsed.kind === "chain") {
      if (parsed.asset !== asset) {
        throw new AgentBankError("invalid_request", `Ledger account ${code} does not hold ${asset}`);
      }
      assertTestnet(parsed.chainId);
    }
  }
  const ref = { ownerRef, code, asset };
  return { ref, parsed, key: refKey(ref) };
}

/** `unsupported_asset` unless the ledger accepts `asset`. */
export function assertAsset(asset: unknown, assets: ReadonlySet<string>): asserts asset is string {
  if (typeof asset !== "string" || !ASSET_RE.test(asset) || !assets.has(asset)) {
    throw new AgentBankError("unsupported_asset", `Asset ${String(asset)} is not supported by this ledger`);
  }
}

/** `invalid_request` unless `accountId` is a bank account id (`acct_…`). */
export function assertAccountId(accountId: unknown): asserts accountId is string {
  if (!isId("account", accountId)) {
    throw new AgentBankError("invalid_request", `"${String(accountId)}" is not an account id`);
  }
}

/** Pocket name of a pocket code (`pocket:vault:vlt_…` → `vault:vlt_…`). */
export function pocketOf(code: string): Pocket {
  return code.slice("pocket:".length) as Pocket;
}
