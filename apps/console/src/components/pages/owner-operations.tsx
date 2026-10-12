"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { SignOperationButton } from "@/components/owner/owner-operation";
import { OwnerSignerPanel } from "@/components/owner/owner-signer-panel";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { SelectField } from "@/components/ui/field";
import { IconSignature } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, HexValue } from "@/components/ui/values";
import { useApiList } from "@/lib/api/hooks";
import type { ApiProblem } from "@/lib/api/problem";
import { accountLabel, useAccountsIndex, useAgentsIndex, useOwnerInbox } from "@/lib/api/queries";
import { shortHex, shortId } from "@/lib/format";
import { operationHref, purposeLabel, type OwnerOperation } from "@/lib/owner/operations";

type HistoryStatus = "" | "submitted" | "succeeded" | "failed" | "expired";

function useLabels() {
  const accounts = useAccountsIndex();
  const agents = useAgentsIndex();
  return {
    account: (id: string) => accountLabel(accounts.byId.get(id), agents.byId),
    href: (op: OwnerOperation) => operationHref(op, (accountId) => accounts.byId.get(accountId)?.agent_id),
  };
}

function Purpose({ op }: { op: OwnerOperation }) {
  return (
    <span className="flex min-w-40 flex-col gap-1">
      <Link href={`/owner-operations/${op.id}`} className="font-medium text-blue-fg hover:underline">
        {purposeLabel(op.purpose)}
      </Link>
      <span>
        <Badge tone="amber">
          <code className="font-mono">{op.purpose}</code>
        </Badge>
      </span>
    </span>
  );
}

function Subject({ op, href }: { op: OwnerOperation; href: string | null }) {
  // Subjects are resource ids, or the new owner's address for an owner swap.
  const short = op.subject_id.startsWith("0x") ? shortHex(op.subject_id) : shortId(op.subject_id);
  const text = <code className="font-mono text-xs whitespace-nowrap">{short}</code>;
  return href ? (
    <Link href={href} className="text-blue-fg hover:underline" title={op.subject_id}>
      {text}
    </Link>
  ) : (
    <span title={op.subject_id}>{text}</span>
  );
}

function Waiting() {
  const inbox = useOwnerInbox();
  const labels = useLabels();
  const toast = useToast();
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  if (inbox.error) return <ProblemAlert problem={inbox.error} onRetry={() => void inbox.mutate()} />;
  if (inbox.isLoading) return <LoadingState label="Loading owner operations" rows={4} />;
  if (inbox.operations.length === 0) {
    return (
      <EmptyState
        icon={<IconSignature size={20} />}
        title="Nothing to sign"
        description="Session installs and revocations, executor installs, locked-vault operations and owner swaps wait here until the owner key signs them."
      />
    );
  }
  return (
    <div className="space-y-3">
      {walletError ? (
        <div className="px-4 pt-4">
          <Callout tone="danger" title="Not signed">
            {walletError}
          </Callout>
        </div>
      ) : null}
      {problem ? (
        <div className="px-4 pt-4">
          <ProblemAlert problem={problem} />
        </div>
      ) : null}
      <Table caption="Owner operations waiting for a signature">
        <THead>
          <tr>
            <Th>What it does</Th>
            <Th>Account and subject</Th>
            <Th>Expires</Th>
            <Th className="sticky right-0 bg-subtle">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <tbody>
          {inbox.operations.map((op) => (
            <Tr key={op.id}>
              <Td>
                <Purpose op={op} />
              </Td>
              <Td>
                <span className="flex flex-col gap-0.5">
                  <span className="whitespace-nowrap">{labels.account(op.account_id)}</span>
                  <Subject op={op} href={labels.href(op)} />
                </span>
              </Td>
              <Td>
                <Countdown to={op.expires_at} />
              </Td>
              {/* Pinned to the right so "Sign" stays in reach while the table scrolls on a phone. */}
              <Td align="right" className="sticky right-0 bg-surface max-sm:border-l max-sm:border-line">
                <div className="flex justify-end">
                  <SignOperationButton
                    operation={op}
                    onResult={(result) => {
                      if (result.ok) {
                        setProblem(null);
                        setWalletError(null);
                        toast({
                          title: "Signed",
                          description: "Submitted to the bundler; it confirms on-chain shortly.",
                        });
                      } else {
                        setProblem(result.problem);
                        setWalletError(result.walletError);
                      }
                    }}
                  />
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {inbox.truncated ? (
        <p className="px-4 pb-4 text-xs text-muted">Showing the first 200 operations.</p>
      ) : null}
    </div>
  );
}

function History() {
  const [status, setStatus] = useState<HistoryStatus>("");
  const labels = useLabels();
  const list = useApiList("listOwnerOperations", {
    query: { limit: 50, ...(status ? { status } : {}) },
  });
  return (
    <div>
      <div className="max-w-xs p-4">
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as HistoryStatus)}
        >
          <option value="">All statuses</option>
          <option value="submitted">Submitted</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="expired">Expired</option>
        </SelectField>
      </div>
      {list.error ? (
        <div className="px-4 pb-4">
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </div>
      ) : list.isLoading ? (
        <LoadingState label="Loading owner operations" rows={4} />
      ) : list.items.length === 0 ? (
        <EmptyState icon={<IconSignature size={20} />} title="No owner operations" />
      ) : (
        <>
          <Table caption="Owner operations">
            <THead>
              <tr>
                <Th>What it does</Th>
                <Th>Status</Th>
                <Th>Account</Th>
                <Th>Applies to</Th>
                <Th>Transaction</Th>
                <Th>Created</Th>
              </tr>
            </THead>
            <tbody>
              {list.items.map((op) => (
                <Tr key={op.id}>
                  <Td>
                    <Link href={`/owner-operations/${op.id}`} className="text-blue-fg hover:underline">
                      {purposeLabel(op.purpose)}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={op.status} />
                  </Td>
                  <Td className="whitespace-nowrap">{labels.account(op.account_id)}</Td>
                  <Td>
                    <Subject op={op} href={labels.href(op)} />
                  </Td>
                  <Td>
                    {op.tx_hash ? (
                      <HexValue value={op.tx_hash} kind="tx" chain={op.chain_id} />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <DateTimeValue value={op.created_at} relative />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {list.hasMore ? (
            <div className="border-t border-line p-3 text-center">
              <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function OwnerOperationsPage() {
  const tabsId = useId();
  const [tab, setTab] = useState<"waiting" | "all">("waiting");
  const inbox = useOwnerInbox();
  const count = inbox.operations.length;
  return (
    <>
      <PageHeader
        title="Owner operations"
        description="On-chain operations only your owner key can authorize. Agent Bank prepares them and submits your signature; it can never sign them itself."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Tabs
            label="Owner operations"
            idBase={tabsId}
            value={tab}
            onChange={setTab}
            tabs={[
              {
                id: "waiting",
                label:
                  count > 0
                    ? `Waiting for signature (${inbox.truncated ? `${count}+` : count})`
                    : "Waiting for signature",
              },
              { id: "all", label: "All operations" },
            ]}
          />
          <Card
            role="tabpanel"
            id={`${tabsId}-panel-${tab}`}
            aria-labelledby={`${tabsId}-tab-${tab}`}
            className="overflow-hidden"
          >
            {tab === "waiting" ? <Waiting /> : <History />}
          </Card>
        </div>
        <aside aria-label="Signing key" className="xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader
              title="Signing key"
              description="Each signature is EIP-191 over the operation's raw 32-byte hash, checked on-chain by your account's owner validator."
            />
            <CardBody>
              <OwnerSignerPanel />
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}
