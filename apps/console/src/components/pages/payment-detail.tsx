"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EntriesTable } from "@/components/ledger/entries-table";
import { OwnerOperationCard } from "@/components/owner/owner-operation";
import { CounterpartyLabel, DecisionView, kindLabel } from "@/components/payments/payment-bits";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { IconLedger } from "@/components/ui/icons";
import { DescriptionList, PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, HexValue, IdValue, MoneyValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { accountLabel, useAccountsIndex, useAgentsIndex, type Payment } from "@/lib/api/queries";
import { formatMoney } from "@/lib/money";

const CANCELABLE = new Set(["requires_approval", "requires_signature"]);
const LIVE = new Set(["requires_approval", "requires_signature", "submitted"]);

function LedgerLines({ payment }: { payment: Payment }) {
  const entries = useApi("listEntries", { params: { id: payment.account_id }, query: { limit: 200 } });
  const mine = useMemo(
    () => (entries.data?.data ?? []).filter((e) => e.payment_id === payment.id || e.ref_id === payment.id),
    [entries.data, payment.id],
  );
  return (
    <Card aria-labelledby="ledger-lines-title">
      <CardHeader
        id="ledger-lines-title"
        title="Ledger lines"
        description="Double-entry journal entries for this payment: the hold, then the posting or the void."
      />
      {entries.error ? (
        <CardBody>
          <ProblemAlert problem={entries.error} onRetry={() => void entries.mutate()} />
        </CardBody>
      ) : entries.isLoading ? (
        <LoadingState label="Loading ledger entries" rows={3} />
      ) : mine.length === 0 ? (
        <EmptyState
          icon={<IconLedger size={20} />}
          title="No ledger entries"
          description={
            payment.status === "denied"
              ? "Denied payments never place a hold."
              : "No entries for this payment among the account's latest 200."
          }
        />
      ) : (
        <EntriesTable entries={mine} caption="Ledger entries for this payment" />
      )}
    </Card>
  );
}

function ApprovalSummary({ approvalId }: { approvalId: string }) {
  const approval = useApi("getApproval", { params: { id: approvalId } });
  if (approval.error) return <ProblemAlert problem={approval.error} />;
  if (!approval.data) return <LoadingState label="Loading approval" rows={1} className="px-0 py-0" />;
  const a = approval.data;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <StatusBadge status={a.status} />
      <span>
        {a.decisions.filter((d) => d.decision === "approve").length} of {a.required_approvers} approvers
      </span>
      {a.status === "pending" ? <Countdown to={a.expires_at} /> : null}
      <Link href="/approvals" className="text-blue-fg hover:underline">
        Open approvals
      </Link>
    </div>
  );
}

export function PaymentDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const agents = useAgentsIndex();
  const accounts = useAccountsIndex();
  const [cancelKey, rotate] = useIdempotencyKey();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const payment = useApi(
    "getPayment",
    { params: { id } },
    {
      refreshInterval: (data) => (data && LIVE.has(data.status) ? 5_000 : 0),
    },
  );
  const cancel = useMutation(() => apiFetch("cancelPayment", { params: { id }, idempotencyKey: cancelKey }), {
    invalidates: ["getPayment", "listPayments", "listApprovals"],
  });

  if (payment.error) {
    return (
      <>
        <PageHeader title="Payment" crumbs={[{ href: "/payments", label: "Payments" }, { label: id }]} />
        <ProblemAlert problem={payment.error} onRetry={() => void payment.mutate()} />
      </>
    );
  }
  if (!payment.data) {
    return (
      <>
        <PageHeader
          title="Payment"
          crumbs={[{ href: "/payments", label: "Payments" }, { label: "Loading" }]}
        />
        <LoadingState label="Loading payment" rows={6} />
      </>
    );
  }
  const p = payment.data;
  const account = accounts.byId.get(p.account_id);

  return (
    <>
      <PageHeader
        title={`${kindLabel(p.kind)} of ${formatMoney(p.amount)}`}
        crumbs={[{ href: "/payments", label: "Payments" }, { label: p.id }]}
        badges={<StatusBadge status={p.status} />}
        actions={
          CANCELABLE.has(p.status) ? (
            confirmCancel ? (
              <>
                <Button
                  variant="danger"
                  loading={cancel.pending}
                  onClick={async () => {
                    const result = await cancel.run();
                    if (result.ok) {
                      rotate();
                      setConfirmCancel(false);
                      toast({ title: "Payment canceled", description: "Its hold is released." });
                    }
                  }}
                >
                  Confirm cancel
                </Button>
                <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                  Keep payment
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirmCancel(true)}>Cancel payment</Button>
            )
          ) : null
        }
      />
      <div className="space-y-6">
        {cancel.error ? <ProblemAlert problem={cancel.error} /> : null}
        {p.failure_reason ? (
          <Callout tone="danger" title="Why it did not go through">
            {p.failure_reason}
          </Callout>
        ) : null}
        <Card aria-labelledby="payment-summary-title">
          <CardHeader id="payment-summary-title" title="Summary" />
          <CardBody>
            <DescriptionList
              columns={3}
              items={[
                { term: "Amount", detail: <MoneyValue money={p.amount} /> },
                { term: "Fee", detail: <MoneyValue money={p.fee} /> },
                {
                  term: "From",
                  detail: account?.agent_id ? (
                    <Link href={`/agents/${account.agent_id}`} className="text-blue-fg hover:underline">
                      {accountLabel(account, agents.byId)}
                    </Link>
                  ) : (
                    accountLabel(account, agents.byId)
                  ),
                },
                {
                  term: "To",
                  detail: (
                    <CounterpartyLabel
                      counterparty={p.counterparty}
                      agents={agents.byId}
                      chain={account?.chain}
                    />
                  ),
                },
                { term: "Memo", detail: p.memo ?? "—" },
                { term: "Payment id", detail: <IdValue value={p.id} /> },
                { term: "Mandate", detail: p.mandate_id ? <IdValue value={p.mandate_id} /> : "—" },
                {
                  term: "Payment request",
                  detail: p.payment_request_id ? <IdValue value={p.payment_request_id} /> : "—",
                },
                { term: "Created", detail: <DateTimeValue value={p.created_at} /> },
                { term: "Updated", detail: <DateTimeValue value={p.updated_at} /> },
                { term: "Settled", detail: <DateTimeValue value={p.settled_at} /> },
                {
                  term: "Transaction",
                  detail: (
                    <HexValue value={p.tx_hash} kind="tx" chain={account?.chain} label="transaction hash" />
                  ),
                },
                {
                  term: "User operation",
                  detail: <HexValue value={p.user_op_hash} kind="hash" label="user operation hash" />,
                },
                ...(Object.keys(p.metadata).length
                  ? [
                      {
                        term: "Metadata",
                        detail: <code className="font-mono text-xs">{JSON.stringify(p.metadata)}</code>,
                      },
                    ]
                  : []),
              ]}
            />
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card aria-labelledby="decision-title">
            <CardHeader
              id="decision-title"
              title="Policy decision"
              description="Deterministic decision of the co-signer's policy engine, with every rule that fired."
            />
            <CardBody className="space-y-4">
              <DecisionView decision={p.decision} />
              {p.approval_id ? <ApprovalSummary approvalId={p.approval_id} /> : null}
            </CardBody>
          </Card>
          {p.signing_request ? (
            <Card aria-labelledby="signing-title">
              <CardHeader
                id="signing-title"
                title="Waiting for the agent's signature"
                description="The agent signs this hash with its session key; the co-signer then re-checks policy and co-signs."
              />
              <CardBody>
                <DescriptionList
                  columns={1}
                  items={[
                    {
                      term: "Session",
                      detail: p.signing_request.session_id ? (
                        <IdValue value={p.signing_request.session_id} />
                      ) : (
                        "—"
                      ),
                    },
                    {
                      term: "User operation hash",
                      detail: <HexValue value={p.signing_request.user_op_hash} kind="hash" full />,
                    },
                    {
                      term: "Signature deadline",
                      detail: <Countdown to={p.signing_request.expires_at} label="Deadline" />,
                    },
                  ]}
                />
              </CardBody>
            </Card>
          ) : null}
        </div>

        {p.owner_operation_id ? (
          <OwnerOperationCard id={p.owner_operation_id} title="The owner must sign this payment" />
        ) : null}

        <LedgerLines payment={p} />
      </div>
    </>
  );
}
