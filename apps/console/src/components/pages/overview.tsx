"use client";

import Link from "next/link";
import { useMemo } from "react";
import { FreezeOrgButton, OrgFreezeDetails, UnfreezeOrgButton } from "@/components/agents/freeze-controls";
import { CounterpartyLabel, kindLabel } from "@/components/payments/payment-bits";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { IconAlert, IconApprovals, IconFreeze, IconPayments, IconSignature } from "@/components/ui/icons";
import { PageHeader, Stat, StatGrid } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState, Skeleton } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { DateTimeValue, MinorAmount, MoneyValue } from "@/components/ui/values";
import { useApi } from "@/lib/api/hooks";
import {
  isBalances,
  useAccountsIndex,
  useAgentsIndex,
  useBalances,
  useOwnerInbox,
  type Agent,
} from "@/lib/api/queries";
import { formatRelative, humanize } from "@/lib/format";
import { sumDecimals } from "@/lib/money";

function BalanceStats() {
  const accounts = useAccountsIndex();
  const agentAccountIds = useMemo(
    () => accounts.accounts.filter((a) => a.role === "agent").map((a) => a.id),
    [accounts.accounts],
  );
  const treasuryIds = useMemo(() => accounts.treasury.map((a) => a.id), [accounts.treasury]);
  const all = useMemo(() => [...agentAccountIds, ...treasuryIds], [agentAccountIds, treasuryIds]);
  const balances = useBalances(all);

  if (accounts.error) return <ProblemAlert problem={accounts.error} onRetry={() => void accounts.mutate()} />;
  if (accounts.isLoading || (all.length > 0 && balances.isLoading)) {
    return (
      <StatGrid>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface px-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-32" />
          </div>
        ))}
      </StatGrid>
    );
  }

  const values = (ids: string[]) => ids.map((id) => balances.data?.get(id)).filter(isBalances);
  const agentBalances = values(agentAccountIds);
  const treasury = values(treasuryIds);
  const failed = all.length - agentBalances.length - treasury.length;

  return (
    <div className="space-y-2">
      <StatGrid>
        <Stat
          label="Agent balances"
          value={<MinorAmount minor={sumDecimals(agentBalances.map((b) => b.total))} round={2} />}
          hint={`${agentAccountIds.length} agent account${agentAccountIds.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Available to spend"
          value={<MinorAmount minor={sumDecimals(agentBalances.map((b) => b.available))} round={2} />}
          hint="Operating pockets"
        />
        <Stat
          label="Held or locked"
          value={
            <MinorAmount
              minor={
                sumDecimals(agentBalances.map((b) => b.reserved)) +
                sumDecimals(agentBalances.map((b) => b.escrow))
              }
              round={2}
            />
          }
          hint="Reserved for pending payments and escrow"
        />
        <Stat
          label="Treasury"
          value={
            treasury.length ? (
              <MinorAmount minor={sumDecimals(treasury.map((b) => b.total))} round={2} />
            ) : (
              "—"
            )
          }
          hint={treasury.length ? "Org treasury account" : "No treasury account yet"}
        />
      </StatGrid>
      {failed > 0 ? (
        <p className="text-xs text-warn-fg">
          {failed} account balance{failed === 1 ? "" : "s"} could not be loaded and{" "}
          {failed === 1 ? "is" : "are"} not included.
        </p>
      ) : null}
    </div>
  );
}

function Alerts() {
  const org = useApi("getCurrentOrg");
  const frozen = useApi("listAgents", { query: { status: "frozen", limit: 50 } });
  const mismatches = useApi("listEvents", { query: { type: "reconciliation.mismatch", limit: 5 } });
  const lowBalance = useApi("listEvents", { query: { type: "balance.low", limit: 3 } });
  const inbox = useOwnerInbox();

  const items: React.ReactNode[] = [];
  if (inbox.operations.length > 0) {
    const n = inbox.operations.length;
    items.push(
      <Callout
        key="owner-operations"
        tone="owner"
        icon={<IconSignature size={16} />}
        title={`${inbox.truncated ? `${n}+` : n} owner operation${n === 1 ? "" : "s"} waiting for your signature`}
      >
        On-chain steps only the owner key can authorize, such as installing a session or an executor.{" "}
        <Link href="/owner-operations" className="font-medium underline underline-offset-2">
          Review and sign
        </Link>
      </Callout>,
    );
  }
  if (org.data?.status === "frozen") {
    items.push(
      <Callout key="org" tone="danger" icon={<IconFreeze size={16} />} title="The organization is frozen">
        <div className="space-y-2">
          <p>The co-signer refuses every operation for every agent.</p>
          <OrgFreezeDetails org={org.data} />
          <UnfreezeOrgButton org={org.data} size="sm" />
        </div>
      </Callout>,
    );
  }
  if (org.data && org.data.kyc_status !== "approved") {
    items.push(
      <Callout key="kyb" tone="warn" title={`Verification ${humanize(org.data.kyc_status).toLowerCase()}`}>
        KYC/KYB must be approved before agents can move money.{" "}
        <Link href="/settings#verification" className="font-medium underline underline-offset-2">
          Open verification
        </Link>
      </Callout>,
    );
  }
  for (const agent of frozen.data?.data ?? []) {
    items.push(
      <Callout key={agent.id} tone="danger" icon={<IconFreeze size={16} />} title={`${agent.name} is frozen`}>
        {agent.frozen_reason ? <p>Reason: {agent.frozen_reason}</p> : null}
        {agent.pending_unfreeze_at ? (
          <p>
            Unfreezes <Countdown to={agent.pending_unfreeze_at} label="Unfreezes" expiredText="Unfreezing" />
          </p>
        ) : null}
        <Link href={`/agents/${agent.id}`} className="font-medium underline underline-offset-2">
          Open agent
        </Link>
      </Callout>,
    );
  }
  for (const event of mismatches.data?.data ?? []) {
    items.push(
      <Callout key={event.id} tone="danger" icon={<IconAlert size={16} />} title="Reconciliation mismatch">
        <p>
          An on-chain movement did not match the ledger {formatRelative(event.created_at)}. The agent&apos;s
          sessions are paused until it is reviewed.
        </p>
        <Link href="/webhooks#events" className="font-medium underline underline-offset-2">
          View event
        </Link>
      </Callout>,
    );
  }
  for (const event of lowBalance.data?.data ?? []) {
    items.push(
      <Callout key={event.id} tone="warn" title="Low balance">
        An agent ran low on funds {formatRelative(event.created_at)}. Consider an{" "}
        <Link href="/treasury" className="font-medium underline underline-offset-2">
          auto top-up rule
        </Link>
        .
      </Callout>,
    );
  }

  const errors = [org.error, frozen.error, mismatches.error, lowBalance.error].filter(Boolean);
  const loading = org.isLoading || frozen.isLoading || mismatches.isLoading;

  return (
    <Card aria-labelledby="alerts-title">
      <CardHeader
        id="alerts-title"
        title="Alerts"
        description="Owner signatures, frozen agents, reconciliation and verification."
      />
      <CardBody className="space-y-3">
        {errors[0] ? <ProblemAlert problem={errors[0]} /> : null}
        {loading ? (
          <LoadingState label="Loading alerts" rows={2} className="px-0 py-0" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">Nothing needs your attention.</p>
        ) : (
          items
        )}
      </CardBody>
    </Card>
  );
}

function PendingApprovals({ agents }: { agents: Map<string, Agent> }) {
  const approvals = useApi(
    "listApprovals",
    { query: { status: "pending", limit: 5 } },
    { refreshInterval: 15_000 },
  );
  return (
    <Card aria-labelledby="pending-title">
      <CardHeader
        id="pending-title"
        title="Pending approvals"
        description="Approvals expire 15 minutes after the payment is queued."
        actions={
          <ButtonLink href="/approvals" size="sm">
            Open queue
          </ButtonLink>
        }
      />
      {approvals.error ? (
        <CardBody>
          <ProblemAlert problem={approvals.error} onRetry={() => void approvals.mutate()} />
        </CardBody>
      ) : approvals.isLoading ? (
        <LoadingState label="Loading approvals" rows={3} />
      ) : (approvals.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<IconApprovals size={20} />}
          title="No payments waiting"
          description="Queued payments appear here."
        />
      ) : (
        <ul className="divide-y divide-line">
          {approvals.data?.data.map((approval) => (
            <li
              key={approval.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <MoneyValue money={approval.amount} />{" "}
                  <span className="font-normal text-muted">
                    from {agents.get(approval.agent_id)?.name ?? approval.agent_id}
                  </span>
                </p>
                <p className="text-xs text-muted">
                  {approval.decisions.length} of {approval.required_approvers} approvals
                </p>
              </div>
              <Countdown to={approval.expires_at} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentPayments({ agents }: { agents: Map<string, Agent> }) {
  const payments = useApi("listPayments", { query: { limit: 10 } });
  return (
    <Card aria-labelledby="recent-title">
      <CardHeader
        id="recent-title"
        title="Recent payments"
        actions={
          <ButtonLink href="/payments" size="sm">
            All payments
          </ButtonLink>
        }
      />
      {payments.error ? (
        <CardBody>
          <ProblemAlert problem={payments.error} onRetry={() => void payments.mutate()} />
        </CardBody>
      ) : payments.isLoading ? (
        <LoadingState label="Loading payments" rows={4} />
      ) : (payments.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<IconPayments size={20} />}
          title="No payments yet"
          description="Payments your agents make show up here."
        />
      ) : (
        <Table caption="Recent payments">
          <THead>
            <tr>
              <Th>Payment</Th>
              <Th>Counterparty</Th>
              <Th align="right">Amount</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </THead>
          <tbody>
            {payments.data?.data.map((payment) => (
              <Tr key={payment.id}>
                <Td>
                  <Link href={`/payments/${payment.id}`} className="font-medium text-blue-fg hover:underline">
                    {kindLabel(payment.kind)}
                  </Link>
                  {payment.memo ? (
                    <p className="max-w-[16rem] truncate text-xs text-muted">{payment.memo}</p>
                  ) : null}
                </Td>
                <Td>
                  <CounterpartyLabel counterparty={payment.counterparty} agents={agents} />
                </Td>
                <Td align="right">
                  <MoneyValue money={payment.amount} />
                </Td>
                <Td>
                  <StatusBadge status={payment.status} />
                </Td>
                <Td className="text-muted">
                  <DateTimeValue value={payment.created_at} relative />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function OverviewPage() {
  const org = useApi("getCurrentOrg");
  const agents = useAgentsIndex();
  return (
    <>
      <PageHeader
        title="Overview"
        description={org.data ? `${org.data.legal_name} · ${humanize(org.data.tier)} plan` : undefined}
        badges={org.data?.status === "frozen" ? <Badge tone="danger">Frozen</Badge> : null}
        actions={org.data?.status === "frozen" ? null : <FreezeOrgButton />}
      />
      <div className="space-y-6">
        <BalanceStats />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <PendingApprovals agents={agents.byId} />
          <Alerts />
        </div>
        <RecentPayments agents={agents.byId} />
      </div>
    </>
  );
}
