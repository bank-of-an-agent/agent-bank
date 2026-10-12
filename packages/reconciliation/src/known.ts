import type { SqlClient } from "@agentbank/db";
import { addressOf, lower, type TxGroup } from "./parse";
import { all, type AccountRow } from "./rows";

/**
 * Who an address is to Agent Bank. Every party except `external` has funds the ledger tracks
 * at that address (see the "Location of the funds" column in docs/architecture.md).
 */
export type ContractKind = "escrow" | "streams" | "vaults" | "topup" | "sweep";

export type Party =
  | { kind: "account"; account: AccountRow }
  | { kind: "spend_key"; account: AccountRow }
  | { kind: "revenue" }
  | { kind: "contract"; contract: ContractKind };

/** Static addresses from the configuration (lowercase keys). */
export interface StaticParties {
  revenue: string;
  contracts: Map<string, ContractKind>;
}

export class KnownIndex {
  private readonly byAddress = new Map<string, Party>();

  constructor(
    readonly statics: StaticParties,
    accounts: readonly AccountRow[],
  ) {
    for (const account of accounts) this.add(account);
  }

  add(account: AccountRow): void {
    this.byAddress.set(lower(account.address), { kind: "account", account });
    if (account.spend_key_address) {
      this.byAddress.set(lower(account.spend_key_address), { kind: "spend_key", account });
    }
  }

  /** The party at `address`, or `null` for addresses outside Agent Bank. */
  partyOf(address: string): Party | null {
    const key = lower(address);
    const account = this.byAddress.get(key);
    if (account) return account;
    if (key === this.statics.revenue) return { kind: "revenue" };
    const contract = this.statics.contracts.get(key);
    return contract ? { kind: "contract", contract } : null;
  }
}

const ADDRESS_ARGS = ["from", "to", "authorizer", "payer", "payee", "account", "agent", "treasury", "sender"];

/** Every address named by the groups' events (checksummed). */
export function addressesOf(groups: readonly TxGroup[]): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    for (const event of group.events) {
      for (const name of ADDRESS_ARGS) {
        const address = addressOf(event.args[name]);
        if (address) out.add(address);
      }
    }
  }
  return [...out];
}

/** Load the accounts at (or with spend keys at) `addresses` on `chainId`. */
export async function loadAccounts(
  db: SqlClient,
  chainId: number,
  addresses: readonly string[],
): Promise<AccountRow[]> {
  if (addresses.length === 0) return [];
  return all<AccountRow>(
    db,
    `SELECT id, org_id, agent_id, role, chain_id, address, spend_key_address FROM account
      WHERE chain_id = $1 AND (address = ANY($2::text[]) OR spend_key_address = ANY($2::text[]))`,
    [chainId, [...addresses]],
  );
}
