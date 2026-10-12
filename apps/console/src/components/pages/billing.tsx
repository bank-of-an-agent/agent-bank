"use client";

import type { ResponseOf } from "@agentbank/core/api";
import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/field";
import { IconBilling, IconCheck } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Amount, DateTimeValue, MoneyValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { cn } from "@/lib/cn";
import { formatPeriod, humanize, recentPeriods } from "@/lib/format";
import { formatMoney } from "@/lib/money";

type Plan = ResponseOf<"listPlans">["data"][number];

const FEE_LABELS: Record<string, string> = {
  subscription: "Subscription",
  outbound_payment: "Outbound payments (0.20%, capped)",
  x402_receive: "x402 receive (0.50%)",
  escrow: "Escrow (1%, $1 minimum)",
  stream: "Streams (0.50%)",
  treasury_sweep: "Treasury sweep (0.15% a year)",
  gas: "Gas (at cost)",
};

function ChangePlanDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const toast = useToast();
  const [key, rotate] = useIdempotencyKey();
  const change = useMutation(
    () => apiFetch("changePlan", { body: { plan: plan.code }, idempotencyKey: key }),
    {
      invalidates: ["getSubscription", "getCurrentOrg"],
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Switch to ${plan.name}`}
      dismissible={!change.pending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={change.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={change.pending}
            onClick={async () => {
              const result = await change.run();
              if (result.ok) {
                rotate();
                toast({ title: `Plan changed to ${plan.name}` });
                onClose();
              }
            }}
          >
            Switch plan
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          {formatMoney(plan.monthly_price)} a month, billed monthly in USDC from the org treasury&apos;s fee
          pocket. Agent Bank never pulls funds: the fee is swept with the treasury&apos;s next outgoing
          operation.
        </p>
        {change.error ? <ProblemAlert problem={change.error} /> : null}
      </div>
    </Dialog>
  );
}

function Plans() {
  const subscription = useApi("getSubscription");
  const plans = useApi("listPlans");
  const [changing, setChanging] = useState<Plan | null>(null);
  const current = subscription.data?.plan.code;

  return (
    <Card aria-labelledby="plan-title">
      <CardHeader
        id="plan-title"
        title="Plan"
        description="Agent Bank earns from subscriptions and payment fees, never from your deposits."
      />
      <CardBody className="space-y-4">
        {subscription.error ? (
          <ProblemAlert problem={subscription.error} onRetry={() => void subscription.mutate()} />
        ) : subscription.data ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-lg font-semibold">{subscription.data.plan.name}</span>
            <StatusBadge status={subscription.data.status} />
            <span className="text-muted">
              Current period <DateTimeValue value={subscription.data.current_period_start} /> –{" "}
              <DateTimeValue value={subscription.data.current_period_end} />
            </span>
          </div>
        ) : (
          <LoadingState label="Loading subscription" rows={1} className="px-0 py-0" />
        )}
        {plans.error ? (
          <ProblemAlert problem={plans.error} onRetry={() => void plans.mutate()} />
        ) : !plans.data ? (
          <LoadingState label="Loading plans" rows={3} className="px-0" />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {plans.data.data.map((plan) => {
              const active = plan.code === current;
              return (
                <li
                  key={plan.code}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border p-4",
                    active ? "border-blue bg-blue-bg/50" : "border-line",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold">{plan.name}</p>
                    {active ? <Badge tone="blue">Current</Badge> : null}
                  </div>
                  <p className="text-2xl font-semibold tabular">
                    <MoneyValue money={plan.monthly_price} round={0} />
                    <span className="text-sm font-normal text-muted"> / month</span>
                  </p>
                  <p className="text-sm text-muted">
                    {plan.max_agents === null ? "Unlimited agents" : `Up to ${plan.max_agents} agents`}
                  </p>
                  <ul className="space-y-1 text-sm">
                    {plan.features.map((f) => (
                      <li key={f} className="flex gap-1.5">
                        <IconCheck size={14} className="mt-0.5 shrink-0 text-teal-fg" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {!active ? (
                    <Button size="sm" className="mt-auto" onClick={() => setChanging(plan)}>
                      Switch to {plan.name}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {changing ? <ChangePlanDialog plan={changing} onClose={() => setChanging(null)} /> : null}
      </CardBody>
    </Card>
  );
}

function Fees() {
  const [periods] = useState(() => recentPeriods(12));
  const [period, setPeriod] = useState(periods[0] ?? "");
  const fees = useApi("getFees", { query: { period } });
  const rows = Object.entries(fees.data?.by_kind ?? {});
  return (
    <Card aria-labelledby="fees-title">
      <CardHeader
        id="fees-title"
        title="Fees by kind"
        description="Every fee is a ledger entry into Agent Bank's revenue account, so it reconciles like any other movement."
        actions={
          <div className="w-48">
            <SelectField label="Month" hideLabel value={period} onChange={(e) => setPeriod(e.target.value)}>
              {periods.map((p) => (
                <option key={p} value={p}>
                  {formatPeriod(p)}
                </option>
              ))}
            </SelectField>
          </div>
        }
      />
      {fees.error ? (
        <CardBody>
          <ProblemAlert problem={fees.error} onRetry={() => void fees.mutate()} />
        </CardBody>
      ) : fees.isLoading ? (
        <LoadingState label="Loading fees" rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<IconBilling size={20} />} title={`No fees in ${formatPeriod(period)}`} />
      ) : (
        <Table caption={`Fees charged in ${formatPeriod(period)}`}>
          <THead>
            <tr>
              <Th>Kind</Th>
              <Th align="right">Amount</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map(([kind, amount]) => (
              <Tr key={kind}>
                <Td>{FEE_LABELS[kind] ?? humanize(kind)}</Td>
                <Td align="right">
                  <Amount value={amount} />
                </Td>
              </Tr>
            ))}
            <Tr className="font-semibold">
              <Td>Total</Td>
              <Td align="right">
                <Amount value={fees.data?.total ?? "0"} />
              </Td>
            </Tr>
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function BillingPage() {
  return (
    <>
      <PageHeader title="Billing" description="Your plan and the fees charged on money movement." />
      <div className="space-y-6">
        <Plans />
        <Fees />
        <Callout tone="info">
          Gas is passed through at cost: the paymaster sponsors it and the cost accrues to each account&apos;s
          fee pocket.
        </Callout>
      </div>
    </>
  );
}
