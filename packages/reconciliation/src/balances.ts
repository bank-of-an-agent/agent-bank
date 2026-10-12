import {
  AgentBankError,
  canonicalSha256,
  type WatchedAddress,
  type WatchlistResponse,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { revenueRef, type Ledger, type LocationBalances } from "@agentbank/ledger";
import { getAddress } from "viem";
import type { ResolvedConfig } from "./context";
import type { ContractKind } from "./known";
import { ASSET } from "./plan";
import { all, type AccountRow } from "./rows";

/**
 * Read side of reconciliation: what the indexer must watch, and what each watched address must
 * hold on-chain according to the ledger (the sum of the pockets located there).
 */

const CONTRACT_KINDS: Record<ContractKind, WatchedAddress["kind"]> = {
  escrow: "escrow_contract",
  streams: "streams_contract",
  vaults: "vaults_contract",
  topup: "topup_executor",
  sweep: "sweep_executor",
};

export async function accountsOnChain(db: SqlClient, chainId: number): Promise<AccountRow[]> {
  return all<AccountRow>(
    db,
    `SELECT id, org_id, agent_id, role, chain_id, address, spend_key_address FROM account
      WHERE chain_id = $1 ORDER BY created_at, id`,
    [chainId],
  );
}

export async function watchlist(db: SqlClient, cfg: ResolvedConfig): Promise<WatchlistResponse> {
  const addresses: WatchedAddress[] = [];
  for (const account of await accountsOnChain(db, cfg.chainId)) {
    addresses.push({
      address: getAddress(account.address),
      kind: account.role === "treasury" ? "treasury" : "account",
      account_id: account.id,
      since_block: null,
    });
    if (account.spend_key_address) {
      addresses.push({
        address: getAddress(account.spend_key_address),
        kind: "spend_key",
        account_id: account.id,
        since_block: null,
      });
    }
  }
  addresses.push({ address: cfg.revenueChecksum, kind: "revenue", account_id: null, since_block: null });
  for (const [kind, address] of Object.entries(cfg.contractsChecksum) as [ContractKind, string | null][]) {
    if (address) addresses.push({ address, kind: CONTRACT_KINDS[kind], account_id: null, since_block: null });
  }
  return {
    chain_id: cfg.chainId,
    usdc: cfg.usdcChecksum,
    addresses,
    version: canonicalSha256(addresses.map((a) => [a.address, a.kind, a.account_id])).slice(2, 18),
  };
}

async function locations(ledger: Ledger, accountId: string): Promise<LocationBalances> {
  try {
    return await ledger.locationBalances(accountId, ASSET);
  } catch (error) {
    if (error instanceof AgentBankError && error.code === "not_found") return {};
    throw error;
  }
}

/**
 * Expected on-chain USDC balance of each address: a smart account holds operating + reserved +
 * fees + savings + goal vaults, a spend key spend + spend_reserved, the revenue address
 * `sys:revenue`, and each shared contract the matching pockets of every account.
 */
export async function expectedBalances(
  db: SqlClient,
  ledger: Ledger,
  cfg: ResolvedConfig,
  requested: readonly string[],
): Promise<Map<string, bigint>> {
  const addresses = requested.map((a) => getAddress(a));
  const accounts = await all<AccountRow>(
    db,
    `SELECT id, org_id, agent_id, role, chain_id, address, spend_key_address FROM account
      WHERE chain_id = $1 AND (address = ANY($2::text[]) OR spend_key_address = ANY($2::text[]))`,
    [cfg.chainId, addresses],
  );
  const bySmart = new Map(accounts.map((a) => [a.address.toLowerCase(), a]));
  const bySpend = new Map(
    accounts
      .filter((a) => a.spend_key_address)
      .map((a) => [(a.spend_key_address as string).toLowerCase(), a]),
  );
  const contractOf = new Map<string, ContractKind>();
  for (const [kind, address] of Object.entries(cfg.contracts) as [ContractKind, string | null][]) {
    if (address) contractOf.set(address, kind);
  }
  let contractTotals: { escrow: bigint; streams: bigint; vaults: bigint } | null = null;
  if (addresses.some((a) => contractOf.has(a.toLowerCase()))) {
    contractTotals = { escrow: 0n, streams: 0n, vaults: 0n };
    for (const account of await accountsOnChain(db, cfg.chainId)) {
      const l = await locations(ledger, account.id);
      contractTotals.escrow += l.escrow_contract ?? 0n;
      contractTotals.streams += l.stream_contract ?? 0n;
      contractTotals.vaults += l.vault_contract ?? 0n;
    }
  }
  const out = new Map<string, bigint>();
  for (const address of addresses) {
    const key = address.toLowerCase();
    let expected = 0n;
    const smart = bySmart.get(key);
    const spend = bySpend.get(key);
    const contract = contractOf.get(key);
    if (smart) expected += (await locations(ledger, smart.id)).smart_account ?? 0n;
    if (spend) expected += (await locations(ledger, spend.id)).spend_key ?? 0n;
    if (key === cfg.revenue) expected += await ledger.balance(revenueRef(ASSET));
    if (contract && contractTotals) {
      if (contract === "escrow") expected += contractTotals.escrow;
      if (contract === "streams") expected += contractTotals.streams;
      if (contract === "vaults") expected += contractTotals.vaults;
    }
    out.set(address, expected);
  }
  return out;
}
