"use client";

import type { PolicyDocument } from "@agentbank/core";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { IconLock } from "@/components/ui/icons";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Amount, DateTimeValue } from "@/components/ui/values";
import { useApi } from "@/lib/api/hooks";
import { humanize } from "@/lib/format";

const CHANGE_KIND_LABELS: Record<string, string> = {
  initial: "Initial version",
  tighten: "Tightened",
  loosen: "Loosened",
  mixed: "Mixed change",
  unchanged: "Unchanged",
};

function limit(value: string | undefined, asset: string) {
  return value === undefined ? (
    <span className="text-muted">No limit</span>
  ) : (
    <Amount value={value} asset={asset} />
  );
}

export function PolicyHighlights({ rules }: { rules: PolicyDocument }) {
  const cp = rules.counterparties;
  const listed =
    (cp.addresses?.length ?? 0) +
    (cp.agent_ids?.length ?? 0) +
    (cp.erc8004_ids?.length ?? 0) +
    (cp.x402_domains?.length ?? 0);
  return (
    <DescriptionList
      columns={3}
      items={[
        { term: "Per payment", detail: limit(rules.limits.per_tx, rules.asset) },
        { term: "Per day", detail: limit(rules.limits.per_day, rules.asset) },
        { term: "Per month", detail: limit(rules.limits.per_month, rules.asset) },
        {
          term: "Counterparties",
          detail:
            cp.mode === "open"
              ? "Open"
              : `${humanize(cp.mode)} · ${listed} entr${listed === 1 ? "y" : "ies"}`,
        },
        {
          term: "Approvals",
          detail: rules.approvals?.length ? (
            <ul className="space-y-0.5">
              {rules.approvals.map((a) => (
                <li key={`${a.above}-${a.approvers}`}>
                  above <Amount value={a.above} asset={rules.asset} />: {a.approvers} approver
                  {a.approvers === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">None</span>
          ),
        },
        { term: "Owner signs above", detail: limit(rules.require_owner_above, rules.asset) },
      ]}
    />
  );
}

export function PolicySummaryCard({ agentId }: { agentId: string }) {
  const policy = useApi("getPolicy", { params: { id: agentId } });
  return (
    <Card aria-labelledby="policy-title">
      <CardHeader
        id="policy-title"
        title="Spending policy"
        description="Enforced by the co-signer and, for hard caps, on-chain in the session scope."
        actions={
          <ButtonLink href={`/agents/${agentId}/policy`} size="sm" variant="primary">
            Edit policy
          </ButtonLink>
        }
      />
      <CardBody className="space-y-4">
        {policy.error ? (
          <ProblemAlert problem={policy.error} onRetry={() => void policy.mutate()} />
        ) : !policy.data ? (
          <LoadingState label="Loading policy" rows={3} className="px-0 py-0" />
        ) : !policy.data.current ? (
          <EmptyState
            icon={<IconLock size={20} />}
            title="No policy yet"
            description="An agent without a policy can spend nothing. The first policy needs the owner key."
            action={
              <ButtonLink href={`/agents/${agentId}/policy`} variant="primary">
                Write the first policy
              </ButtonLink>
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="neutral">Version {policy.data.current.version}</Badge>
              <StatusBadge
                status={policy.data.current.change_kind}
                label={CHANGE_KIND_LABELS[policy.data.current.change_kind]}
              />
              <span className="text-muted">
                effective <DateTimeValue value={policy.data.current.effective_at} />
              </span>
            </div>
            <PolicyHighlights rules={policy.data.current.rules} />
          </>
        )}
        {policy.data?.pending ? (
          <Callout
            tone="owner"
            title={`Pending version ${policy.data.pending.version} (owner-signed loosening)`}
          >
            <p>
              Takes effect when the 1-hour delay ends{" "}
              <Countdown
                to={policy.data.pending.effective_at}
                label="Takes effect"
                expiredText="Taking effect"
              />
              .
            </p>
          </Callout>
        ) : null}
      </CardBody>
    </Card>
  );
}
