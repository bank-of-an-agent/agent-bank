"use client";

import Link from "next/link";
import { useState } from "react";
import { CounterpartyLabel, RuleHits } from "@/components/payments/payment-bits";
import { useSessionInfo } from "@/components/providers/config";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Countdown, useNow } from "@/components/ui/countdown";
import { IconCheck, IconClose, IconPasskey } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Skeleton } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, MoneyValue } from "@/components/ui/values";
import { apiFetch, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import type { Agent, Approval, Payment } from "@/lib/api/queries";
import { formatMoney } from "@/lib/money";
import { approvalAssertion } from "@/lib/passkey";

/**
 * One queued payment. Approving or denying asks for a passkey assertion bound
 * to this approval and this decision (the API issues a single-use challenge);
 * in sandbox API-key sessions the decision is attributed to the key's member.
 */
export function ApprovalCard({
  approval,
  payment,
  paymentLoading,
  agents,
}: {
  approval: Approval;
  payment: Payment | undefined;
  paymentLoading: boolean;
  /** All agents, to name both the paying agent and an agent counterparty. */
  agents: Map<string, Agent>;
}) {
  const agent = agents.get(approval.agent_id);
  const session = useSessionInfo();
  const toast = useToast();
  const now = useNow(1000);
  const [key, rotate] = useIdempotencyKey();
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const expired = approval.status === "pending" && new Date(approval.expires_at).getTime() <= now;
  const usesPasskey = session?.kind !== "api_key";

  const decide = useMutation(
    async (decision: "approve" | "deny") => {
      const assertion = usesPasskey ? await approvalAssertion(approval.id, decision) : undefined;
      return apiFetch("decideApproval", {
        params: { id: approval.id },
        body: { decision, ...(assertion ? { webauthn_assertion: assertion } : {}) },
        idempotencyKey: key,
      });
    },
    { invalidates: ["listApprovals", "getApproval", "getPayment", "listPayments"] },
  );

  async function run(decision: "approve" | "deny") {
    setPending(decision);
    const result = await decide.run(decision);
    setPending(null);
    if (result.ok) {
      rotate();
      toast({
        title: decision === "approve" ? "Approval recorded" : "Payment denied",
        description:
          result.data.status === "approved"
            ? "The payment continues to signing and co-signing."
            : result.data.status === "denied"
              ? "The hold is released."
              : `${result.data.decisions.length} of ${result.data.required_approvers} approvals so far.`,
      });
    }
  }

  const amount = formatMoney(approval.amount);
  const titleId = `approval-${approval.id}`;

  return (
    <Card as="article" aria-labelledby={titleId} className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="text-lg font-semibold tabular">
            <MoneyValue money={approval.amount} />
            <span className="sr-only"> payment</span>
          </h2>
          <p className="text-sm text-muted">
            from{" "}
            <Link href={`/agents/${approval.agent_id}`} className="font-medium text-blue-fg hover:underline">
              {agent?.name ?? approval.agent_id}
            </Link>{" "}
            · queued <DateTimeValue value={approval.created_at} relative />
          </p>
        </div>
        <div className="flex flex-row flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1">
          {approval.status === "pending" ? (
            <Countdown to={approval.expires_at} />
          ) : (
            <StatusBadge status={approval.status} />
          )}
          <Badge tone={approval.decisions.length > 0 ? "teal" : "neutral"}>
            {approval.decisions.filter((d) => d.decision === "approve").length} of{" "}
            {approval.required_approvers} approver{approval.required_approvers === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-5 md:grid-cols-2">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Counterparty</p>
            <div className="mt-1 text-sm">
              <CounterpartyLabel counterparty={approval.counterparty} agents={agents} />
            </div>
          </div>
          {payment?.memo ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Memo</p>
              <p className="mt-1 text-sm">{payment.memo}</p>
            </div>
          ) : null}
          {approval.decisions.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Decisions</p>
              <ul className="mt-1 space-y-1 text-sm">
                {approval.decisions.map((d) => (
                  <li key={`${d.member_id}-${d.decided_at}`} className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={d.decision === "approve" ? "approved" : "denied"} />
                    <code className="font-mono text-xs">{d.member_id}</code>
                    <span className="text-xs text-muted">
                      <DateTimeValue value={d.decided_at} relative />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Link
            href={`/payments/${approval.payment_id}`}
            className="inline-block text-sm text-blue-fg hover:underline"
          >
            Payment details
          </Link>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Why it needs approval</p>
          <div className="mt-1">
            {payment?.decision ? (
              <RuleHits hits={payment.decision.rule_hits} />
            ) : paymentLoading ? (
              <div className="space-y-2" aria-hidden="true">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <p className="text-sm text-muted">Rule hits unavailable.</p>
            )}
          </div>
        </div>
      </div>
      {approval.status === "pending" ? (
        <div className="space-y-3 border-t border-line bg-subtle/50 px-4 py-3 sm:px-5">
          {decide.error ? <ProblemAlert problem={decide.error} /> : null}
          {expired ? (
            <p className="text-sm text-muted">This approval expired; the payment will not go through.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={usesPasskey ? <IconPasskey size={16} /> : <IconCheck size={16} />}
                loading={pending === "approve"}
                disabled={pending !== null}
                onClick={() => void run("approve")}
                aria-label={`Approve ${amount} payment${usesPasskey ? " with passkey" : ""}`}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                icon={<IconClose size={16} />}
                loading={pending === "deny"}
                disabled={pending !== null}
                onClick={() => void run("deny")}
                aria-label={`Deny ${amount} payment${usesPasskey ? " with passkey" : ""}`}
              >
                Deny
              </Button>
              <span className="text-xs text-muted">
                {usesPasskey
                  ? "Your passkey signs this decision."
                  : "Sandbox API-key session: recorded for the key's member without a passkey."}
              </span>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
