"use client";

import { useId, useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconApprovals } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useApiList } from "@/lib/api/hooks";
import { useAgentsIndex } from "@/lib/api/queries";

type Status = "pending" | "approved" | "denied" | "expired";

const EMPTY: Record<Status, { title: string; description: string }> = {
  pending: {
    title: "No payments waiting for approval",
    description:
      "When a payment crosses an approval threshold in an agent's policy, it waits here for 15 minutes.",
  },
  approved: {
    title: "No approved payments",
    description: "Approved payments continue to signing and co-signing.",
  },
  denied: { title: "No denied payments", description: "Denied approvals release the payment's hold." },
  expired: {
    title: "No expired approvals",
    description: "Approvals expire 15 minutes after the payment is queued.",
  },
};

export function ApprovalsPage() {
  const [status, setStatus] = useState<Status>("pending");
  const tabsId = useId();
  const list = useApiList(
    "listApprovals",
    { query: { status, limit: 25 } },
    { refreshInterval: status === "pending" ? 10_000 : 0 },
  );
  const agents = useAgentsIndex();

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Payments above a policy's approval threshold wait for human approvers. Decide with your passkey; each approval expires 15 minutes after the payment is queued."
      />
      <div className="mb-4">
        <Tabs
          label="Approval status"
          idBase={tabsId}
          value={status}
          onChange={setStatus}
          tabs={[
            { id: "pending", label: "Pending" },
            { id: "approved", label: "Approved" },
            { id: "denied", label: "Denied" },
            { id: "expired", label: "Expired" },
          ]}
        />
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-panel-${status}`}
        aria-labelledby={`${tabsId}-tab-${status}`}
        className="space-y-4"
      >
        {list.error ? (
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        ) : list.isLoading ? (
          <Card>
            <LoadingState label="Loading approvals" rows={5} />
          </Card>
        ) : list.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={<IconApprovals size={20} />}
              title={EMPTY[status].title}
              description={EMPTY[status].description}
            />
          </Card>
        ) : (
          <>
            {list.items.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} agents={agents.byId} />
            ))}
            {list.hasMore ? (
              <div className="text-center">
                <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
