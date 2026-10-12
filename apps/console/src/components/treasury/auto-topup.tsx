"use client";

import Link from "next/link";
import { useState } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { OwnerOperationDialog, PendingOperationButton } from "@/components/owner/owner-operation";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { MoneyValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useInvalidate } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { useOwnerInbox, type Agent, type AutoTopUpRule } from "@/lib/api/queries";
import { amountError, compareDecimal } from "@/lib/money";
import { ownerPayloads } from "@/lib/owner/authorize";

const money = (amount: string) => ({ amount, asset: "USDC" as const });

export function AutoTopUpEditor({
  agent,
  initial,
  open,
  onClose,
  onSaved,
}: {
  agent: Agent;
  initial?: { refill_to: string; when_below: string; max_per_day: string };
  open: boolean;
  onClose: () => void;
  /** Receives the saved rule; its `install_operation_id` still needs the owner's signature. */
  onSaved?: (rule: AutoTopUpRule) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [refillTo, setRefillTo] = useState(initial?.refill_to ?? "100.00");
  const [whenBelow, setWhenBelow] = useState(initial?.when_below ?? "20.00");
  const [maxPerDay, setMaxPerDay] = useState(initial?.max_per_day ?? "500.00");
  const [key, rotate] = useIdempotencyKey();

  const errors = {
    refillTo: amountError(refillTo),
    whenBelow: amountError(whenBelow, { allowZero: true }),
    maxPerDay: amountError(maxPerDay),
  };
  const order =
    !errors.refillTo && !errors.whenBelow && compareDecimal(whenBelow, refillTo) >= 0
      ? "Refill only when the balance is below the refill target"
      : null;
  const valid = !Object.values(errors).some(Boolean) && !order;
  const request = valid
    ? ownerPayloads.topUpSet(agent.id, {
        refill_to: money(refillTo),
        when_below: money(whenBelow),
        max_per_day: money(maxPerDay),
      })
    : null;

  return (
    <OwnerActionDialog
      open={open}
      onClose={onClose}
      title={`Auto top-up for ${agent.name}`}
      description="The owner-installed top-up executor refills the agent from the org treasury. Funds only ever move between your own accounts."
      request={request}
      submitLabel="Sign and save rule"
      onSubmit={async (authorization) => {
        try {
          const rule = await apiFetch("putAutoTopUp", {
            params: { id: agent.id },
            body: {
              refill_to: money(refillTo),
              when_below: money(whenBelow),
              max_per_day: money(maxPerDay),
              owner_authorization: authorization,
            },
            idempotencyKey: key,
          });
          rotate();
          void invalidate("getAutoTopUp", "listAutoTopUpRules", "listOwnerOperations");
          toast({
            title: "Auto top-up saved",
            description: "Next, sign the executor install on the treasury with the owner key.",
          });
          if (rule) onSaved?.(rule);
          return { ok: true };
        } catch (error) {
          return { ok: false, problem: ApiProblem.from(error) };
        }
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TextField
          label="When below (USDC)"
          inputMode="decimal"
          value={whenBelow}
          onChange={(e) => setWhenBelow(e.target.value)}
          error={errors.whenBelow ?? order}
        />
        <TextField
          label="Refill to (USDC)"
          inputMode="decimal"
          value={refillTo}
          onChange={(e) => setRefillTo(e.target.value)}
          error={errors.refillTo}
        />
        <TextField
          label="Max per day (USDC)"
          inputMode="decimal"
          value={maxPerDay}
          onChange={(e) => setMaxPerDay(e.target.value)}
          error={errors.maxPerDay}
        />
      </div>
    </OwnerActionDialog>
  );
}

/** Rule state in words, including the on-chain install the owner still has to sign. */
export function RuleStatus({ rule, waiting }: { rule: AutoTopUpRule; waiting: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusBadge status={rule.status} />
      {rule.status === "pending_install" ? (
        <span className="text-xs text-muted">
          {waiting ? "Waiting for the owner's signature" : "Installing on-chain"}
        </span>
      ) : null}
    </span>
  );
}

export function AutoTopUpSummary({
  agent,
  treasuryAccountId,
}: {
  agent: Agent;
  treasuryAccountId: string | null;
}) {
  const rule = useApi("getAutoTopUp", { params: { id: agent.id } });
  const inbox = useOwnerInbox();
  const [editing, setEditing] = useState(false);
  const [installId, setInstallId] = useState<string | null>(null);
  // No rule is either `null` or a 404, depending on the API version.
  if (rule.error && rule.error.code !== "not_found") {
    return <ProblemAlert problem={rule.error} onRetry={() => void rule.mutate()} />;
  }
  if (rule.isLoading) return <LoadingState label="Loading top-up rule" rows={1} className="px-0 py-0" />;
  const current = rule.error ? null : (rule.data ?? null);
  const waiting = Boolean(current?.install_operation_id && inbox.byId.has(current.install_operation_id));
  return (
    <div className="space-y-3">
      {current ? (
        <DescriptionList
          columns={3}
          items={[
            { term: "When below", detail: <MoneyValue money={current.when_below} /> },
            { term: "Refill to", detail: <MoneyValue money={current.refill_to} /> },
            { term: "Max per day", detail: <MoneyValue money={current.max_per_day} /> },
            { term: "Status", detail: <RuleStatus rule={current} waiting={waiting} /> },
          ]}
        />
      ) : (
        <p className="text-sm text-muted">No auto top-up rule. The agent is only funded by deposits.</p>
      )}
      {treasuryAccountId ? (
        <div className="flex flex-wrap gap-2">
          {current?.status === "pending_install" ? (
            <PendingOperationButton
              operationId={current.install_operation_id}
              title="Install the auto top-up executor"
              label="Sign install…"
            />
          ) : null}
          <Button size="sm" variant="owner" onClick={() => setEditing(true)}>
            {current ? "Change rule…" : "Set up auto top-up…"}
          </Button>
        </div>
      ) : (
        <Callout tone="info">
          Set an org treasury account first on the{" "}
          <Link href="/treasury" className="underline">
            Treasury
          </Link>{" "}
          page.
        </Callout>
      )}
      {editing && treasuryAccountId ? (
        <AutoTopUpEditor
          agent={agent}
          initial={
            current
              ? {
                  refill_to: current.refill_to.amount,
                  when_below: current.when_below.amount,
                  max_per_day: current.max_per_day.amount,
                }
              : undefined
          }
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={(saved) => setInstallId(saved.install_operation_id)}
        />
      ) : null}
      <OwnerOperationDialog
        id={installId}
        open={installId !== null}
        onClose={() => setInstallId(null)}
        title="Install the auto top-up executor"
        description="The treasury's executor refills this agent; installing or updating it is an owner operation."
      />
    </div>
  );
}
