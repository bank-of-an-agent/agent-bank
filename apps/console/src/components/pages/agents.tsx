"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { CreateAgentButton } from "@/components/agents/create-agent";
import { ProofRootsCard } from "@/components/agents/private-proofs-card";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconAgents } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { DateTimeValue, MinorAmount } from "@/components/ui/values";
import { useApiList } from "@/lib/api/hooks";
import { isBalances, useAccountsIndex, useBalances } from "@/lib/api/queries";
import { formatTime } from "@/lib/format";
import { sumDecimals } from "@/lib/money";

type Filter = "all" | "active" | "frozen";

export function AgentsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const tabsId = useId();
  const list = useApiList("listAgents", {
    query: { limit: 50, ...(filter === "all" ? {} : { status: filter }) },
  });
  const accounts = useAccountsIndex();
  const accountIds = useMemo(
    () => list.items.flatMap((agent) => (accounts.byAgent.get(agent.id) ?? []).map((a) => a.id)),
    [list.items, accounts.byAgent],
  );
  const balances = useBalances(accountIds);

  function balanceOf(agentId: string) {
    const ids = (accounts.byAgent.get(agentId) ?? []).map((a) => a.id);
    if (ids.length === 0) return null;
    const values = ids.map((id) => balances.data?.get(id)).filter(isBalances);
    if (values.length === 0) return undefined;
    return sumDecimals(values.map((b) => b.total));
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent has its own smart account, session keys, policy and mandates."
        actions={<CreateAgentButton />}
      />
      <div className="mb-4">
        <Tabs
          label="Filter agents by status"
          idBase={tabsId}
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "all", label: "All" },
            { id: "active", label: "Active" },
            { id: "frozen", label: "Frozen" },
          ]}
        />
      </div>
      <Card>
        <div role="tabpanel" id={`${tabsId}-panel-${filter}`} aria-labelledby={`${tabsId}-tab-${filter}`}>
          {list.error ? (
            <div className="p-4">
              <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
            </div>
          ) : list.isLoading ? (
            <LoadingState label="Loading agents" rows={5} />
          ) : list.items.length === 0 ? (
            <EmptyState
              icon={<IconAgents size={20} />}
              title={
                filter === "frozen"
                  ? "No frozen agents"
                  : filter === "active"
                    ? "No active agents"
                    : "No agents yet"
              }
              description={
                filter === "all"
                  ? "Create an agent, give it a smart account and a policy, then hand its session key to your runtime."
                  : undefined
              }
              action={filter === "all" ? <CreateAgentButton /> : undefined}
            />
          ) : (
            <>
              <Table caption="Agents">
                <THead>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Status</Th>
                    <Th align="right">Balance</Th>
                    <Th>Accounts</Th>
                    <Th>Created</Th>
                  </tr>
                </THead>
                <tbody>
                  {list.items.map((agent) => {
                    const balance = balanceOf(agent.id);
                    const accountCount = accounts.byAgent.get(agent.id)?.length ?? 0;
                    return (
                      <Tr key={agent.id}>
                        <Td>
                          <Link
                            href={`/agents/${agent.id}`}
                            className="font-medium text-blue-fg hover:underline"
                          >
                            {agent.name}
                          </Link>
                          {agent.description ? (
                            <p className="max-w-xs truncate text-xs text-muted">{agent.description}</p>
                          ) : null}
                        </Td>
                        <Td>
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge status={agent.status} />
                            {agent.pending_unfreeze_at ? (
                              <span className="text-xs text-muted">
                                Unfreezes at {formatTime(agent.pending_unfreeze_at)}
                              </span>
                            ) : null}
                          </div>
                        </Td>
                        <Td align="right">
                          {balance === null ? (
                            <span className="text-muted">No account</span>
                          ) : balance === undefined ? (
                            <span className="text-muted">{balances.isLoading ? "Loading…" : "—"}</span>
                          ) : (
                            <MinorAmount minor={balance} round={2} />
                          )}
                        </Td>
                        <Td className="tabular">{accountCount}</Td>
                        <Td className="text-muted">
                          <DateTimeValue value={agent.created_at} />
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
              {list.hasMore ? (
                <div className="border-t border-line p-3 text-center">
                  <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                    Load more agents
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>
      <div className="mt-6">
        <ProofRootsCard />
      </div>
    </>
  );
}
