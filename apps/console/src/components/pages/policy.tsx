"use client";

import { PendingPolicy, PolicyEditor } from "@/components/policy/policy-editor";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { useApi } from "@/lib/api/hooks";

export function PolicyPage({ agentId }: { agentId: string }) {
  const agent = useApi("getAgent", { params: { id: agentId } });
  const policy = useApi("getPolicy", { params: { id: agentId } });
  const name = agent.data?.name ?? agentId;
  const crumbs = [
    { href: "/agents", label: "Agents" },
    { href: `/agents/${agentId}`, label: name },
    { label: "Policy" },
  ];

  return (
    <>
      <PageHeader
        title={`Policy for ${name}`}
        description="Tightening applies immediately. Loosening needs the owner key and takes effect after a 1-hour delay, so a stolen admin session cannot quietly raise limits."
        crumbs={crumbs}
      />
      {policy.error ? (
        <ProblemAlert problem={policy.error} onRetry={() => void policy.mutate()} />
      ) : !policy.data ? (
        <LoadingState label="Loading policy" rows={8} />
      ) : (
        <div className="space-y-6">
          {policy.data.pending ? <PendingPolicy policy={policy.data} /> : null}
          {policy.data.pending ? (
            <Callout tone="info">
              The editor starts from the pending version and compares your changes with it, as the API does.
              Any further loosening waits its own 1-hour delay.
            </Callout>
          ) : null}
          <PolicyEditor
            key={`${policy.data.current?.version ?? 0}:${policy.data.pending?.version ?? 0}`}
            agentId={agentId}
            agentName={name}
            policy={policy.data}
            onSaved={(next) => void policy.mutate(next, { revalidate: true })}
          />
        </div>
      )}
    </>
  );
}
