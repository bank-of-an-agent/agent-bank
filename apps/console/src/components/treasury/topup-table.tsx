"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { IconRefresh } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { MoneyValue } from "@/components/ui/values";
import { apiFetch, useApi } from "@/lib/api/hooks";
import type { ApiProblem } from "@/lib/api/problem";
import { useAgentsIndex, type Agent } from "@/lib/api/queries";
import type { ResponseOf } from "@agentbank/core/api";
import { AutoTopUpEditor } from "./auto-topup";

type Rule = NonNullable<ResponseOf<"getAutoTopUp">>;

/** Auto top-up rules of every agent (one read per agent: the API has no list endpoint). */
function useTopUpRules(agents: Agent[]) {
  const ids = useMemo(() => agents.map((a) => a.id).sort(), [agents]);
  return useSWR<Map<string, Rule | null>, ApiProblem>(
    ids.length ? (["getAutoTopUp", `many:${ids.join(",")}`] as const) : null,
    async () => {
      const results = await Promise.allSettled(ids.map((id) => apiFetch("getAutoTopUp", { params: { id } })));
      const map = new Map<string, Rule | null>();
      results.forEach((result, i) => {
        const id = ids[i];
        if (!id) return;
        map.set(id, result.status === "fulfilled" ? (result.value ?? null) : null);
      });
      return map;
    },
  );
}

export function TopUpRulesCard() {
  const org = useApi("getCurrentOrg");
  const agents = useAgentsIndex();
  const rules = useTopUpRules(agents.agents);
  const [editing, setEditing] = useState<Agent | null>(null);
  const treasuryId = org.data?.treasury_account_id ?? null;

  return (
    <Card aria-labelledby="topup-rules-title">
      <CardHeader
        id="topup-rules-title"
        title="Auto top-up"
        description="Refill agents from the treasury when they run low. The owner installs the top-up executor; funds only move between your own accounts."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefresh size={14} />}
            onClick={() => void rules.mutate()}
          >
            Refresh
          </Button>
        }
      />
      {!treasuryId && !org.isLoading ? (
        <CardBody>
          <Callout tone="info">Set an org treasury account first; top-ups are drawn from it.</Callout>
        </CardBody>
      ) : null}
      {agents.error ? (
        <CardBody>
          <ProblemAlert problem={agents.error} onRetry={() => void agents.mutate()} />
        </CardBody>
      ) : agents.isLoading ? (
        <LoadingState label="Loading agents" rows={3} />
      ) : agents.agents.length === 0 ? (
        <EmptyState title="No agents yet" description="Create an agent to give it a top-up rule." />
      ) : (
        <Table caption="Auto top-up rules by agent">
          <THead>
            <tr>
              <Th>Agent</Th>
              <Th align="right">When below</Th>
              <Th align="right">Refill to</Th>
              <Th align="right">Max per day</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {agents.agents.map((agent) => {
              const rule = rules.data?.get(agent.id);
              return (
                <Tr key={agent.id}>
                  <Td>
                    <Link href={`/agents/${agent.id}`} className="font-medium text-blue-fg hover:underline">
                      {agent.name}
                    </Link>
                  </Td>
                  <Td align="right">
                    {rule ? <MoneyValue money={rule.when_below} /> : <span className="text-muted">—</span>}
                  </Td>
                  <Td align="right">
                    {rule ? <MoneyValue money={rule.refill_to} /> : <span className="text-muted">—</span>}
                  </Td>
                  <Td align="right">
                    {rule ? <MoneyValue money={rule.max_per_day} /> : <span className="text-muted">—</span>}
                  </Td>
                  <Td>
                    {rules.isLoading ? (
                      <span className="text-muted">Loading…</span>
                    ) : rule ? (
                      <StatusBadge status={rule.status} />
                    ) : (
                      <span className="text-muted">No rule</span>
                    )}
                  </Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="owner"
                      disabled={!treasuryId}
                      onClick={() => setEditing(agent)}
                    >
                      {rule ? "Change…" : "Set up…"}
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {editing ? (
        <AutoTopUpEditor
          agent={editing}
          initial={(() => {
            const rule = rules.data?.get(editing.id);
            return rule
              ? {
                  refill_to: rule.refill_to.amount,
                  when_below: rule.when_below.amount,
                  max_per_day: rule.max_per_day.amount,
                }
              : undefined;
          })()}
          open
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}
