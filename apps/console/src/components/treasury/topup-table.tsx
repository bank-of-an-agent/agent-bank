"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { OwnerOperationDialog, PendingOperationButton } from "@/components/owner/owner-operation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { IconRefresh } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { MoneyValue } from "@/components/ui/values";
import { useApi } from "@/lib/api/hooks";
import { useAgentsIndex, useOwnerInbox, type Agent } from "@/lib/api/queries";
import { AutoTopUpEditor, RuleStatus } from "./auto-topup";

export function TopUpRulesCard() {
  const org = useApi("getCurrentOrg");
  const agents = useAgentsIndex();
  const inbox = useOwnerInbox();
  const list = useApi("listAutoTopUpRules", { query: { limit: 200 } });
  const byAgent = useMemo(
    () => new Map((list.data?.data ?? []).map((rule) => [rule.agent_id, rule])),
    [list.data],
  );
  const [editing, setEditing] = useState<Agent | null>(null);
  const [installId, setInstallId] = useState<string | null>(null);
  const treasuryId = org.data?.treasury_account_id ?? null;
  const loadError = agents.error ?? list.error;

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
            onClick={() => void list.mutate()}
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
      {loadError ? (
        <CardBody>
          <ProblemAlert
            problem={loadError}
            onRetry={() => void (agents.error ? agents.mutate() : list.mutate())}
          />
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
              const rule = byAgent.get(agent.id);
              const waiting = Boolean(
                rule?.install_operation_id && inbox.byId.has(rule.install_operation_id),
              );
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
                    {list.isLoading ? (
                      <span className="text-muted">Loading…</span>
                    ) : rule ? (
                      <RuleStatus rule={rule} waiting={waiting} />
                    ) : (
                      <span className="text-muted">No rule</span>
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-2">
                      {rule?.status === "pending_install" ? (
                        <PendingOperationButton
                          operationId={rule.install_operation_id}
                          title={`Install the top-up executor for ${agent.name}`}
                          label="Sign install…"
                        />
                      ) : null}
                      <Button
                        size="sm"
                        variant="owner"
                        disabled={!treasuryId}
                        onClick={() => setEditing(agent)}
                      >
                        {rule ? "Change…" : "Set up…"}
                      </Button>
                    </div>
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
            const rule = byAgent.get(editing.id);
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
          onSaved={(saved) => setInstallId(saved.install_operation_id)}
        />
      ) : null}
      <OwnerOperationDialog
        id={installId}
        open={installId !== null}
        onClose={() => setInstallId(null)}
        title="Install the auto top-up executor"
        description="Installing or updating the treasury's top-up executor is an owner operation."
      />
    </Card>
  );
}
