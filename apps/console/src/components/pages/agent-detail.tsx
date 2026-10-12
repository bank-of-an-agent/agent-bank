"use client";

import { AccountsCard } from "@/components/agents/accounts-card";
import { EscrowsStreamsCard } from "@/components/agents/escrows-streams-card";
import { FreezeAgentButton, UnfreezeAgentButton } from "@/components/agents/freeze-controls";
import { MandatesCard } from "@/components/agents/mandates-card";
import { PolicySummaryCard } from "@/components/agents/policy-summary";
import { PrivateProofsCard } from "@/components/agents/private-proofs-card";
import { SessionsCard } from "@/components/agents/sessions-card";
import { PaymentsTable } from "@/components/payments/payments-table";
import { AutoTopUpSummary } from "@/components/treasury/auto-topup";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { IconFreeze, IconPayments } from "@/components/ui/icons";
import { DescriptionList, PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { DateTimeValue, IdValue } from "@/components/ui/values";
import { useApi, useApiList } from "@/lib/api/hooks";
import { useAccountsIndex, useAgentsIndex, type Account, type Agent } from "@/lib/api/queries";
import { formatTime } from "@/lib/format";

function AgentPayments({ agentId, accounts }: { agentId: string; accounts: Account[] }) {
  const agents = useAgentsIndex();
  const index = useAccountsIndex();
  const primary = accounts[0];
  const list = useApiList(primary ? "listPayments" : null, { query: { agent_id: agentId, limit: 25 } });
  return (
    <Card aria-labelledby="agent-payments-title">
      <CardHeader
        id="agent-payments-title"
        title="Payments"
        description="Payments from this agent's accounts."
      />
      {!primary ? (
        <EmptyState icon={<IconPayments size={20} />} title="No account, no payments" />
      ) : list.error ? (
        <CardBody>
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </CardBody>
      ) : list.isLoading ? (
        <LoadingState label="Loading payments" rows={4} />
      ) : list.items.length === 0 ? (
        <EmptyState icon={<IconPayments size={20} />} title="No payments yet" />
      ) : (
        <>
          <PaymentsTable
            payments={list.items}
            agents={agents.byId}
            accounts={index.byId}
            showAccount={false}
            caption="Payments from this agent"
          />
          {list.hasMore ? (
            <div className="border-t border-line p-3 text-center">
              <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function FrozenNotice({ agent }: { agent: Agent }) {
  if (agent.status !== "frozen") return null;
  return (
    <Callout tone="danger" icon={<IconFreeze size={16} />} title="This agent is frozen">
      <div className="space-y-2">
        <p>The co-signer refuses every operation this agent attempts.</p>
        {agent.frozen_reason ? <p>Reason: {agent.frozen_reason}</p> : null}
        {agent.pending_unfreeze_at ? (
          <p className="flex flex-wrap items-center gap-2">
            The owner signed an unfreeze. It takes effect at {formatTime(agent.pending_unfreeze_at)} after the
            1-hour delay:
            <Countdown to={agent.pending_unfreeze_at} label="Unfreezes" expiredText="Unfreezing" />
          </p>
        ) : null}
      </div>
    </Callout>
  );
}

export function AgentDetailPage({ id }: { id: string }) {
  const agent = useApi("getAgent", { params: { id } }, { refreshInterval: 30_000 });
  const accounts = useAccountsIndex();
  const org = useApi("getCurrentOrg");

  if (agent.error) {
    return (
      <>
        <PageHeader title="Agent" crumbs={[{ href: "/agents", label: "Agents" }, { label: id }]} />
        <ProblemAlert problem={agent.error} onRetry={() => void agent.mutate()} />
      </>
    );
  }
  if (!agent.data) {
    return (
      <>
        <PageHeader title="Agent" crumbs={[{ href: "/agents", label: "Agents" }, { label: "Loading" }]} />
        <LoadingState label="Loading agent" rows={6} />
      </>
    );
  }
  const a = agent.data;
  const agentAccounts = accounts.byAgent.get(a.id) ?? [];

  return (
    <>
      <PageHeader
        title={a.name}
        description={a.description ?? undefined}
        crumbs={[{ href: "/agents", label: "Agents" }, { label: a.name }]}
        badges={<StatusBadge status={a.status} />}
        actions={a.status === "active" ? <FreezeAgentButton agent={a} /> : <UnfreezeAgentButton agent={a} />}
      />
      <div className="space-y-6">
        <FrozenNotice agent={a} />
        <Card aria-labelledby="identity-title">
          <CardHeader id="identity-title" title="Identity" />
          <CardBody>
            <DescriptionList
              columns={3}
              items={[
                { term: "Agent id", detail: <IdValue value={a.id} /> },
                {
                  term: "DID",
                  detail: a.did ? <code className="font-mono text-xs break-all">{a.did}</code> : "—",
                },
                { term: "ERC-8004 id", detail: a.erc8004_id ?? "—" },
                {
                  term: "Agent card",
                  detail: a.agent_card_url ? (
                    <a
                      href={a.agent_card_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-fg hover:underline break-all"
                    >
                      {a.agent_card_url}
                    </a>
                  ) : (
                    "—"
                  ),
                },
                { term: "Created", detail: <DateTimeValue value={a.created_at} /> },
                {
                  term: "Metadata",
                  detail: Object.keys(a.metadata).length ? (
                    <code className="font-mono text-xs">{JSON.stringify(a.metadata)}</code>
                  ) : (
                    "—"
                  ),
                },
              ]}
            />
          </CardBody>
        </Card>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <AccountsCard agent={a} accounts={agentAccounts} loading={accounts.isLoading} />
          <div className="space-y-6">
            <PolicySummaryCard agentId={a.id} />
            <Card aria-labelledby="topup-title">
              <CardHeader
                id="topup-title"
                title="Auto top-up"
                description="Refill from the org treasury when the balance runs low (owner-signed rule)."
              />
              <CardBody>
                <AutoTopUpSummary agent={a} treasuryAccountId={org.data?.treasury_account_id ?? null} />
              </CardBody>
            </Card>
          </div>
        </div>
        <SessionsCard agent={a} accounts={agentAccounts} />
        <MandatesCard agent={a} />
        <PrivateProofsCard agent={a} accounts={agentAccounts} />
        <AgentPayments agentId={a.id} accounts={agentAccounts} />
        <EscrowsStreamsCard accounts={agentAccounts} />
      </div>
    </>
  );
}
