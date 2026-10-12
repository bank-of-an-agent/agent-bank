"use client";

import { PAYMENT_KINDS } from "@agentbank/core";
import { PaymentStatus } from "@agentbank/core/api";
import { useMemo, useState } from "react";
import { kindLabel } from "@/components/payments/payment-bits";
import { PaymentsTable } from "@/components/payments/payments-table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/field";
import { IconPayments } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { useApiList } from "@/lib/api/hooks";
import { accountLabel, useAccountsIndex, useAgentsIndex } from "@/lib/api/queries";
import { humanize } from "@/lib/format";

const STATUSES = PaymentStatus.options;

export function PaymentsPage() {
  const [status, setStatus] = useState("");
  const [accountId, setAccountId] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const agents = useAgentsIndex();
  const accounts = useAccountsIndex();
  const list = useApiList("listPayments", {
    query: {
      limit: 50,
      ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return list.items.filter((p) => {
      if (kind && p.kind !== kind) return false;
      if (!needle) return true;
      const agentName = p.counterparty.agent_id ? (agents.byId.get(p.counterparty.agent_id)?.name ?? "") : "";
      return [
        p.id,
        p.memo ?? "",
        p.counterparty.address,
        p.counterparty.x402_domain ?? "",
        agentName,
        p.amount.amount,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [list.items, kind, search, agents.byId]);

  const filtering = Boolean(status || accountId || kind || search);

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment your agents made or tried to make, with its policy decision."
      />
      <Card className="mb-4">
        <form
          className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Filter payments"
          onSubmit={(e) => e.preventDefault()}
        >
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </SelectField>
          <SelectField label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a, agents.byId)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            hint="Filters loaded results"
          >
            <option value="">All kinds</option>
            {PAYMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Id, memo, counterparty"
            hint="Searches loaded results"
          />
        </form>
      </Card>
      <Card>
        {list.error ? (
          <div className="p-4">
            <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
          </div>
        ) : list.isLoading ? (
          <LoadingState label="Loading payments" rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<IconPayments size={20} />}
            title={filtering ? "No payments match these filters" : "No payments yet"}
            description={
              filtering
                ? list.hasMore
                  ? "Load more to search further back."
                  : "Try another status, account or search."
                : "Payments your agents make (transfers, x402, escrow, streams) appear here."
            }
            action={
              filtering && list.hasMore ? (
                <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                  Load more
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <PaymentsTable payments={filtered} agents={agents.byId} accounts={accounts.byId} />
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <span>
                {filtered.length} shown{filtering ? ` of ${list.items.length} loaded` : ""}
              </span>
              {list.hasMore ? (
                <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                  Load more
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
