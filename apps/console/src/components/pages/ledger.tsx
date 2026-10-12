"use client";

import { useId, useState } from "react";
import { EntriesTable } from "@/components/ledger/entries-table";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField } from "@/components/ui/field";
import { IconDownload, IconLedger } from "@/components/ui/icons";
import { PageHeader, Stat, StatGrid } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { Amount, DateTimeValue } from "@/components/ui/values";
import { apiUrl } from "@/lib/api/client";
import { useApi, useApiList } from "@/lib/api/hooks";
import { accountLabel, useAccountsIndex, useAgentsIndex } from "@/lib/api/queries";
import { formatPeriod, humanize, recentPeriods } from "@/lib/format";
import { tryMinor } from "@/lib/money";

function Entries({ accountId }: { accountId: string }) {
  const list = useApiList("listEntries", { params: { id: accountId }, query: { limit: 50 } });
  if (list.error) return <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />;
  if (list.isLoading) return <LoadingState label="Loading entries" rows={5} className="px-0" />;
  if (list.items.length === 0) {
    return (
      <EmptyState
        icon={<IconLedger size={20} />}
        title="No ledger entries yet"
        description="Deposits, holds, payments and fees post here."
      />
    );
  }
  return (
    <div className="space-y-3">
      <EntriesTable entries={list.items} caption="Ledger entries for this account" />
      {list.hasMore ? (
        <div className="text-center">
          <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
            Load older entries
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Statement({ accountId, period }: { accountId: string; period: string }) {
  const statement = useApi("getStatement", { query: { account_id: accountId, period, format: "json" } });
  const csv = apiUrl("getStatement", { query: { account_id: accountId, period, format: "csv" } });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{formatPeriod(period)}</h3>
        <a
          href={csv}
          download={`statement-${accountId}-${period}.csv`}
          className={buttonClasses("secondary", "sm")}
        >
          <IconDownload size={14} />
          Download CSV
        </a>
      </div>
      {statement.error ? (
        <ProblemAlert problem={statement.error} onRetry={() => void statement.mutate()} />
      ) : !statement.data ? (
        <LoadingState label="Loading statement" rows={4} className="px-0" />
      ) : (
        <>
          <StatGrid className="xl:grid-cols-5">
            <Stat
              label="Opening balance"
              value={<Amount value={statement.data.opening_balance} asset={statement.data.asset} />}
            />
            <Stat
              label="Money in"
              value={<Amount value={statement.data.total_in} asset={statement.data.asset} />}
            />
            <Stat
              label="Money out"
              value={<Amount value={statement.data.total_out} asset={statement.data.asset} />}
            />
            <Stat label="Fees" value={<Amount value={statement.data.fees} asset={statement.data.asset} />} />
            <Stat
              label="Closing balance"
              value={<Amount value={statement.data.closing_balance} asset={statement.data.asset} />}
              hint={`${statement.data.entry_count} entr${statement.data.entry_count === 1 ? "y" : "ies"}`}
            />
          </StatGrid>
          {statement.data.lines.length === 0 ? (
            <EmptyState title="No activity this month" />
          ) : (
            <Table caption={`Statement lines for ${formatPeriod(period)}`}>
              <THead>
                <tr>
                  <Th>Date</Th>
                  <Th>Description</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">Balance</Th>
                </tr>
              </THead>
              <tbody>
                {statement.data.lines.map((line) => {
                  const minor = tryMinor(line.amount, statement.data?.asset ?? "USDC");
                  return (
                    <Tr key={line.entry_id}>
                      <Td className="text-muted">
                        <DateTimeValue value={line.date} />
                      </Td>
                      <Td>
                        <p>{line.description}</p>
                        <p className="text-xs text-muted">{humanize(line.ref_type)}</p>
                      </Td>
                      <Td align="right">
                        <Amount
                          value={line.amount}
                          asset={statement.data?.asset}
                          signed
                          className={minor !== null && minor < 0n ? "text-danger-fg" : "text-teal-fg"}
                        />
                      </Td>
                      <Td align="right">
                        <Amount value={line.balance} asset={statement.data?.asset} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <p className="text-xs text-muted">
            Generated <DateTimeValue value={statement.data.generated_at} /> from the append-only ledger.
          </p>
        </>
      )}
    </div>
  );
}

export function LedgerPage() {
  const accounts = useAccountsIndex();
  const agents = useAgentsIndex();
  const org = useApi("getCurrentOrg");
  const [accountId, setAccountId] = useState("");
  const [tab, setTab] = useState<"entries" | "statement">("entries");
  const [periods] = useState(() => recentPeriods(12));
  const [period, setPeriod] = useState(periods[0] ?? "");
  const tabsId = useId();
  const selected = accountId || org.data?.treasury_account_id || accounts.accounts[0]?.id || "";

  return (
    <>
      <PageHeader
        title="Ledger & statements"
        description="The append-only, double-entry ledger records why money moved; the indexer reconciles it with the chain."
      />
      <Card>
        <CardHeader
          title="Account"
          actions={
            accounts.accounts.length > 0 ? (
              <div className="w-full min-w-56 sm:w-72">
                <SelectField
                  label="Account"
                  hideLabel
                  value={selected}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {accounts.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a, agents.byId)} · {a.id}
                    </option>
                  ))}
                </SelectField>
              </div>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {accounts.error ? (
            <ProblemAlert problem={accounts.error} onRetry={() => void accounts.mutate()} />
          ) : accounts.isLoading ? (
            <LoadingState label="Loading accounts" rows={2} className="px-0" />
          ) : !selected ? (
            <EmptyState
              icon={<IconLedger size={20} />}
              title="No accounts yet"
              description="Create an agent account or the org treasury first."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <Tabs
                  label="Ledger view"
                  idBase={tabsId}
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: "entries", label: "Entries" },
                    { id: "statement", label: "Monthly statement" },
                  ]}
                />
                {tab === "statement" ? (
                  <div className="w-48">
                    <SelectField label="Month" value={period} onChange={(e) => setPeriod(e.target.value)}>
                      {periods.map((p) => (
                        <option key={p} value={p}>
                          {formatPeriod(p)}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                ) : null}
              </div>
              <TabPanel idBase={tabsId} tabId="entries" active={tab === "entries"}>
                <Entries accountId={selected} />
              </TabPanel>
              <TabPanel idBase={tabsId} tabId="statement" active={tab === "statement"}>
                <Statement accountId={selected} period={period} />
              </TabPanel>
            </>
          )}
        </CardBody>
      </Card>
    </>
  );
}
