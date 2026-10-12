"use client";

import { canonicalJson, type OwnerAuthorization, type PolicyDocument } from "@agentbank/core";
import type { ResponseOf } from "@agentbank/core/api";
import { useId, useMemo, useState } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { IconKey } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout } from "@/components/ui/states";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { apiFetch, useIdempotencyKey } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { formatTime } from "@/lib/format";
import { diffPolicy, type PolicyDiff } from "@/lib/policy/diff";
import {
  issuesByPath,
  parseJsonText,
  prune,
  starterPolicy,
  toPrettyJson,
  validateDraft,
  type Draft,
} from "@/lib/policy/draft";
import { ownerPayloads } from "@/lib/owner/authorize";
import { diffBadge, PolicyDiffPanel } from "./policy-diff";
import { PolicyForm } from "./policy-form";
import { PolicyJsonEditor } from "./policy-json";

type AgentPolicy = ResponseOf<"getPolicy">;

function safeDiff(
  prev: PolicyDocument | null,
  next: PolicyDocument,
): { diff: PolicyDiff | null; error: string | null } {
  try {
    return { diff: diffPolicy(prev, next), error: null };
  } catch (error) {
    return {
      diff: null,
      error: error instanceof Error ? error.message : "Could not compare with the current policy.",
    };
  }
}

function isObject(value: unknown): value is Draft {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pending (owner-signed, delayed) version, with what it changes. */
export function PendingPolicy({ policy }: { policy: AgentPolicy }) {
  const pending = policy.pending;
  const currentRules = policy.current?.rules ?? null;
  const result = useMemo(
    () => (pending ? safeDiff(currentRules, pending.rules) : null),
    [pending, currentRules],
  );
  if (!pending) return null;
  return (
    <Card aria-labelledby="pending-policy-title" className="border-amber/60">
      <CardHeader
        id="pending-policy-title"
        title={`Pending version ${pending.version}`}
        description={`Signed by the owner key; takes effect at ${formatTime(pending.effective_at)} after the 1-hour loosening delay.`}
        actions={<Countdown to={pending.effective_at} label="Takes effect" expiredText="Taking effect" />}
      />
      <CardBody>
        {result?.diff ? (
          <PolicyDiffPanel diff={result.diff} title="What the pending version changes" variant="compact" />
        ) : result?.error ? (
          <Callout tone="warn">{result.error}</Callout>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function PolicyEditor({
  agentId,
  agentName,
  policy,
  onSaved,
}: {
  agentId: string;
  agentName: string;
  policy: AgentPolicy;
  onSaved: (next: AgentPolicy) => void;
}) {
  const toast = useToast();
  const tabsId = useId();
  // The API classifies a change against the latest version: the pending one when a loosening is waiting.
  const baseline = policy.pending?.rules ?? policy.current?.rules ?? null;
  const initial = useMemo<Draft>(
    () => structuredClone((baseline ?? starterPolicy(agentId)) as Draft),
    [baseline, agentId],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState(() => toPrettyJson(initial));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [idempotencyKey, rotateKey] = useIdempotencyKey();

  const pruned = useMemo(() => prune(draft), [draft]);
  const validation = useMemo(() => validateDraft(pruned), [pruned]);
  const issues = useMemo(() => issuesByPath(validation.issues), [validation]);
  const compared = useMemo(
    () => (validation.ok ? safeDiff(baseline, validation.document) : { diff: null, error: null }),
    [validation, baseline],
  );
  const diff = compared.diff;
  const dirty = useMemo(() => canonicalJson(pruned) !== canonicalJson(prune(initial)), [pruned, initial]);
  const nothingToSave = baseline !== null && diff?.kind === "unchanged" && diff.items.length === 0;

  function switchMode(next: "form" | "json") {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(toPrettyJson(pruned));
      setJsonError(null);
    } else if (jsonError) {
      return;
    }
    setMode(next);
  }

  function onJsonChange(text: string) {
    setJsonText(text);
    const parsed = parseJsonText(text);
    if (!parsed.ok) {
      setJsonError(parsed.message);
      return;
    }
    if (!isObject(parsed.value)) {
      setJsonError("The policy must be a JSON object.");
      return;
    }
    setJsonError(null);
    setDraft(parsed.value);
  }

  function discard() {
    setDraft(initial);
    setJsonText(toPrettyJson(initial));
    setJsonError(null);
    setProblem(null);
  }

  async function put(document: PolicyDocument, authorization?: OwnerAuthorization) {
    return apiFetch("putPolicy", {
      params: { id: agentId },
      body: { policy: document, ...(authorization ? { owner_authorization: authorization } : {}) },
      idempotencyKey,
    });
  }

  function announce(next: AgentPolicy) {
    if (next.pending && next.pending.effective_at) {
      toast({
        title: `Version ${next.pending.version} is pending`,
        description: `It takes effect at ${formatTime(next.pending.effective_at)} (1-hour loosening delay).`,
        tone: "info",
      });
    } else {
      toast({
        title: `Policy saved${next.current ? ` (version ${next.current.version})` : ""}`,
        description: "Applied immediately.",
      });
    }
  }

  async function save() {
    if (!validation.ok || !diff) return;
    setProblem(null);
    if (diff.requiresOwner) {
      setOwnerOpen(true);
      return;
    }
    setSaving(true);
    try {
      const next = await put(validation.document);
      rotateKey();
      announce(next);
      onSaved(next);
    } catch (error) {
      const p = ApiProblem.from(error);
      // The server is authoritative on classification: escalate to the owner key when it asks.
      if (p.code === "owner_signature_required") setOwnerOpen(true);
      else setProblem(p);
    }
    setSaving(false);
  }

  const valid = validation.ok && !jsonError;
  const problems = jsonError ? [] : validation.issues;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            label="Editor view"
            idBase={tabsId}
            value={mode}
            onChange={switchMode}
            tabs={[
              { id: "form", label: "Form" },
              { id: "json", label: "JSON" },
            ]}
          />
          {jsonError && mode === "json" ? (
            <p className="text-xs text-danger-fg">Fix the JSON to switch back to the form.</p>
          ) : null}
        </div>
        <TabPanel idBase={tabsId} tabId="form" active={mode === "form"}>
          <PolicyForm draft={draft} onChange={setDraft} issues={issues} />
        </TabPanel>
        <TabPanel idBase={tabsId} tabId="json" active={mode === "json"}>
          <PolicyJsonEditor value={jsonText} onChange={onJsonChange} syntaxError={jsonError} />
        </TabPanel>
        {/* Below xl the review panel sits after the form; keep its verdict in view while editing. */}
        <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 xl:hidden">
          <span className="text-sm">
            {problems.length > 0 ? (
              <span className="font-medium text-danger-fg">
                {problems.length} problem{problems.length === 1 ? "" : "s"} to fix
              </span>
            ) : diff ? (
              <Badge tone={diffBadge(diff).tone}>{diffBadge(diff).label}</Badge>
            ) : (
              <span className="text-muted">Checking the draft…</span>
            )}
          </span>
          <a href="#policy-review" className="text-sm font-medium text-blue-fg hover:underline">
            Review and save
          </a>
        </div>
      </div>

      <aside
        id="policy-review"
        className="scroll-mt-20 space-y-4 xl:sticky xl:top-20 xl:self-start"
        aria-label="Review and save"
      >
        <Card>
          <CardBody className="space-y-4">
            {problems.length > 0 ? (
              <div
                id="policy-problems"
                className="space-y-1 rounded-lg border border-danger/50 bg-danger-bg px-3 py-2.5 text-sm"
              >
                <p className="font-semibold">
                  {problems.length} problem{problems.length === 1 ? "" : "s"} to fix before saving
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {problems.slice(0, 8).map((issue, i) => (
                    <li key={`${issue.path}-${i}`}>
                      {issue.path ? <code className="font-mono text-xs">{issue.path}</code> : null}
                      {issue.path ? ": " : null}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {compared.error ? <Callout tone="warn">{compared.error}</Callout> : null}
            {diff ? (
              <PolicyDiffPanel
                diff={diff}
                title={policy.pending ? `Changes vs pending version ${policy.pending.version}` : "Changes"}
              />
            ) : valid ? null : (
              <p className="text-sm text-muted">The diff appears once the draft is valid.</p>
            )}
            {problem ? <ProblemAlert problem={problem} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant={diff?.requiresOwner ? "owner" : "primary"}
                icon={diff?.requiresOwner ? <IconKey size={16} /> : undefined}
                loading={saving}
                disabled={!valid || !diff || nothingToSave || saving}
                aria-describedby={problems.length > 0 ? "policy-problems" : undefined}
                onClick={() => void save()}
              >
                {diff?.requiresOwner ? "Sign and save…" : "Save policy"}
              </Button>
              <Button variant="ghost" onClick={discard} disabled={!dirty || saving}>
                Discard changes
              </Button>
            </div>
          </CardBody>
        </Card>
      </aside>

      {validation.ok ? (
        <OwnerActionDialog
          open={ownerOpen}
          onClose={() => setOwnerOpen(false)}
          title={`Sign the policy change for ${agentName}`}
          description={
            diff?.delayed
              ? "Loosening needs the owner key. The new version takes effect 1 hour after it is saved."
              : "The owner key must sign this policy."
          }
          request={ownerPayloads.policyLoosen(agentId, validation.document)}
          submitLabel="Sign and save policy"
          onSubmit={async (authorization, signed) => {
            try {
              const next = await put(signed.payload as PolicyDocument, authorization);
              rotateKey();
              announce(next);
              onSaved(next);
              return { ok: true };
            } catch (error) {
              return { ok: false, problem: ApiProblem.from(error) };
            }
          }}
        >
          {diff ? (
            <PolicyDiffPanel diff={diff} title="You are signing these changes" variant="compact" />
          ) : null}
        </OwnerActionDialog>
      ) : null}
    </div>
  );
}
