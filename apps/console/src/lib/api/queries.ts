"use client";

import type { ResponseOf } from "@agentbank/core/api";
import { useMemo } from "react";
import useSWR from "swr";
import { apiFetch } from "./client";
import { useApi } from "./hooks";
import type { ApiProblem } from "./problem";

/** Composite reads shared by several pages. */

export type Agent = ResponseOf<"getAgent">;
export type Account = ResponseOf<"getAccount">;
export type Balances = ResponseOf<"getBalances">;
export type Payment = ResponseOf<"getPayment">;
export type Approval = ResponseOf<"getApproval">;
export type Org = ResponseOf<"getCurrentOrg">;
export type OwnerOperation = ResponseOf<"getOwnerOperation">;
export type Session = ResponseOf<"getSession">;
export type Mandate = ResponseOf<"getMandate">;
export type Escrow = ResponseOf<"getEscrow">;
export type Stream = ResponseOf<"getStream">;
export type Vault = ResponseOf<"getVault">;
export type AutoTopUpRule = NonNullable<ResponseOf<"getAutoTopUp">>;
export type SweepRule = NonNullable<ResponseOf<"getSweepRule">>;
export type ProofSettings = ResponseOf<"getProofSettings">;
export type ProofRoot = ResponseOf<"getProofRoot">;
export type ProofReservation = ResponseOf<"getProofReservation">;

const LIST_LIMIT = 200;

export function useAgentsIndex() {
  const query = useApi("listAgents", { query: { limit: LIST_LIMIT } });
  const byId = useMemo(() => new Map((query.data?.data ?? []).map((a) => [a.id, a])), [query.data]);
  return { ...query, agents: query.data?.data ?? [], byId, truncated: Boolean(query.data?.next_cursor) };
}

export function useAccountsIndex() {
  const query = useApi("listAccounts", { query: { limit: LIST_LIMIT } });
  const accounts = useMemo(() => query.data?.data ?? [], [query.data]);
  const index = useMemo(() => {
    const byId = new Map<string, Account>();
    const byAgent = new Map<string, Account[]>();
    let treasury: Account[] = [];
    for (const account of accounts) {
      byId.set(account.id, account);
      if (account.agent_id)
        byAgent.set(account.agent_id, [...(byAgent.get(account.agent_id) ?? []), account]);
      if (account.role === "treasury") treasury = [...treasury, account];
    }
    return { byId, byAgent, treasury };
  }, [accounts]);
  return { ...query, accounts, ...index, truncated: Boolean(query.data?.next_cursor) };
}

/** Balances for many accounts in one SWR entry (invalidated with "getBalances"). */
export function useBalances(accountIds: readonly string[]) {
  const ids = useMemo(() => [...accountIds].sort(), [accountIds]);
  const key = ids.length > 0 ? (["getBalances", `many:${ids.join(",")}`] as const) : null;
  const query = useSWR<Map<string, Balances | ApiProblem>, ApiProblem>(
    key,
    async () => {
      const results = await Promise.allSettled(ids.map((id) => apiFetch("getBalances", { params: { id } })));
      const map = new Map<string, Balances | ApiProblem>();
      results.forEach((result, i) => {
        const id = ids[i];
        if (!id) return;
        map.set(id, result.status === "fulfilled" ? result.value : (result.reason as ApiProblem));
      });
      return map;
    },
    { refreshInterval: 30_000 },
  );
  return query;
}

/**
 * Owner operations waiting for the owner key's signature, shared by the nav
 * badge, the inbox and every card that offers "Sign" for an operation id.
 */
export function useOwnerInbox() {
  const query = useApi(
    "listOwnerOperations",
    { query: { status: "requires_signature", limit: LIST_LIMIT } },
    { refreshInterval: 15_000 },
  );
  const operations = useMemo(() => query.data?.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(operations.map((op) => [op.id, op])), [operations]);
  return { ...query, operations, byId, truncated: Boolean(query.data?.next_cursor) };
}

export function isBalances(value: Balances | ApiProblem | undefined): value is Balances {
  return typeof value === "object" && value !== null && "object" in value && value.object === "balances";
}

/** "research-bot" for an agent id, the treasury label for treasury accounts. */
export function accountLabel(account: Account | undefined, agents: Map<string, Agent>): string {
  if (!account) return "Unknown account";
  if (account.role === "treasury") return "Org treasury";
  return (account.agent_id && agents.get(account.agent_id)?.name) || account.agent_id || account.id;
}
