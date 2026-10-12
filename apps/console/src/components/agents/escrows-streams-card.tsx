"use client";

import { useId, useState } from "react";
import { CounterpartyLabel } from "@/components/payments/payment-bits";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { IconClock, IconLock } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { DateTimeValue, IdValue, MoneyValue } from "@/components/ui/values";
import { useApiList } from "@/lib/api/hooks";
import { useAgentsIndex, type Account, type Escrow, type Stream } from "@/lib/api/queries";
import { describeInterval, humanize } from "@/lib/format";

const ESCROW_ACTIONS: Record<NonNullable<Escrow["pending_action"]>, string> = {
  lock: "Lock",
  release: "Release",
  refund: "Refund",
  dispute: "Dispute",
};

const STREAM_ACTIONS: Record<NonNullable<Stream["pending_action"]>, string> = {
  create: "Start",
  cancel: "Cancel",
  top_up: "Top up",
};

/** An on-chain step waiting for the agent's session key, which the agent's runtime signs. */
function PendingAction({ action }: { action: string | null }) {
  if (!action) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-col gap-1">
      <Badge tone="blue" icon={<IconClock size={12} />}>
        {action}
      </Badge>
      <span className="text-xs text-muted">Waiting for the agent&apos;s session signature</span>
    </span>
  );
}

function MoreButton({ list }: { list: { hasMore: boolean; loadMore: () => void; isLoadingMore: boolean } }) {
  if (!list.hasMore) return null;
  return (
    <div className="border-t border-line p-3 text-center">
      <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
        Load more
      </Button>
    </div>
  );
}

function Escrows({ account }: { account: Account }) {
  const agents = useAgentsIndex();
  const list = useApiList("listEscrows", { query: { account_id: account.id, limit: 25 } });
  if (list.error) {
    return (
      <div className="p-4 sm:px-5">
        <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
      </div>
    );
  }
  if (list.isLoading) return <LoadingState label="Loading escrows" rows={2} />;
  if (list.items.length === 0) {
    return (
      <EmptyState
        icon={<IconLock size={20} />}
        title="No escrows"
        description="Escrows lock funds in the Escrow contract until the payer, an arbiter or a validator releases them."
      />
    );
  }
  return (
    <>
      <Table caption="Escrows">
        <THead>
          <tr>
            <Th>Escrow</Th>
            <Th>Payee</Th>
            <Th align="right">Amount</Th>
            <Th>Status</Th>
            <Th>Released by</Th>
            <Th>Expires</Th>
            <Th>On-chain step</Th>
          </tr>
        </THead>
        <tbody>
          {list.items.map((escrow) => {
            const paying = escrow.payer_account_id === account.id;
            return (
              <Tr key={escrow.id}>
                <Td>
                  <span className="flex flex-col gap-1">
                    <IdValue value={escrow.id} />
                    <span className="text-xs text-muted">{paying ? "Paying" : "Receiving"}</span>
                    {escrow.memo ? <span className="text-xs">{escrow.memo}</span> : null}
                  </span>
                </Td>
                <Td>
                  <CounterpartyLabel counterparty={escrow.payee} agents={agents.byId} chain={account.chain} />
                </Td>
                <Td align="right">
                  <span className="flex flex-col items-end">
                    <MoneyValue money={escrow.amount} />
                    <span className="text-xs text-muted">
                      fee <MoneyValue money={escrow.fee} />
                    </span>
                  </span>
                </Td>
                <Td>
                  <StatusBadge status={escrow.status} />
                </Td>
                <Td>{humanize(escrow.release)}</Td>
                <Td className="whitespace-nowrap">
                  <DateTimeValue value={escrow.expires_at} />
                </Td>
                <Td>
                  <PendingAction
                    action={escrow.pending_action ? ESCROW_ACTIONS[escrow.pending_action] : null}
                  />
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <MoreButton list={list} />
    </>
  );
}

function Streams({ account }: { account: Account }) {
  const agents = useAgentsIndex();
  const list = useApiList("listStreams", { query: { account_id: account.id, limit: 25 } });
  if (list.error) {
    return (
      <div className="p-4 sm:px-5">
        <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
      </div>
    );
  }
  if (list.isLoading) return <LoadingState label="Loading streams" rows={2} />;
  if (list.items.length === 0) {
    return (
      <EmptyState
        icon={<IconClock size={20} />}
        title="No streams"
        description="Streams pay a fixed rate from a deposit, settled on-chain at intervals; recurring streams pay once per interval."
      />
    );
  }
  return (
    <>
      <Table caption="Streams">
        <THead>
          <tr>
            <Th>Stream</Th>
            <Th>Payee</Th>
            <Th align="right">Rate</Th>
            <Th align="right">Deposit / settled</Th>
            <Th>Status</Th>
            <Th>Runs</Th>
            <Th>On-chain step</Th>
          </tr>
        </THead>
        <tbody>
          {list.items.map((stream) => (
            <Tr key={stream.id}>
              <Td>
                <span className="flex flex-col gap-1">
                  <IdValue value={stream.id} />
                  <span className="text-xs text-muted">
                    {stream.kind === "recurring" ? "Recurring" : "Streaming"} ·{" "}
                    {stream.payer_account_id === account.id ? "paying" : "receiving"}
                  </span>
                </span>
              </Td>
              <Td>
                <CounterpartyLabel counterparty={stream.payee} agents={agents.byId} chain={account.chain} />
              </Td>
              <Td align="right">
                <span className="flex flex-col items-end">
                  <MoneyValue money={stream.amount_per_interval} />
                  <span className="text-xs text-muted">{describeInterval(stream.interval_seconds)}</span>
                </span>
              </Td>
              <Td align="right">
                <span className="flex flex-col items-end">
                  <MoneyValue money={stream.deposit} />
                  <span className="text-xs text-muted">
                    <MoneyValue money={stream.settled} /> settled
                  </span>
                </span>
              </Td>
              <Td>
                <StatusBadge status={stream.status} />
              </Td>
              <Td className="whitespace-nowrap text-xs">
                <DateTimeValue value={stream.start_at} />
                {stream.stop_at ? (
                  <>
                    {" "}
                    to <DateTimeValue value={stream.stop_at} />
                  </>
                ) : (
                  " onwards"
                )}
              </Td>
              <Td>
                <PendingAction
                  action={stream.pending_action ? STREAM_ACTIONS[stream.pending_action] : null}
                />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <MoreButton list={list} />
    </>
  );
}

/**
 * The agent's escrows and streams, with any on-chain step that waits for the
 * agent's session key (`pending_action`).
 */
export function EscrowsStreamsCard({ accounts }: { accounts: Account[] }) {
  const { features } = useConsoleConfig();
  const tabsId = useId();
  const [tab, setTab] = useState<"escrows" | "streams">("escrows");
  const account = accounts[0];
  if (!account || (features.escrow === false && features.streams === false)) return null;
  return (
    <Card aria-labelledby="escrows-streams-title">
      <CardHeader
        id="escrows-streams-title"
        title="Escrows and streams"
        description="Conditional and continuous payments held in Agent Bank's contracts, not by Agent Bank."
        actions={
          <Tabs
            label="Escrows or streams"
            idBase={tabsId}
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "escrows", label: "Escrows" },
              { id: "streams", label: "Streams" },
            ]}
          />
        }
      />
      <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`}>
        {tab === "escrows" ? <Escrows account={account} /> : <Streams account={account} />}
      </div>
    </Card>
  );
}
