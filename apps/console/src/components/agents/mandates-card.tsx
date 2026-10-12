"use client";

import {
  formatAmount,
  mandateAmountToUsdcMinor,
  OpenPaymentMandateSchema,
  parseAmount,
  type MandateConstraint,
  type OpenPaymentMandate,
} from "@agentbank/core";
import { useState, type FormEvent } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { IconLedger, IconPlus } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Amount, DateTimeValue, IdValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import type { Agent } from "@/lib/api/queries";
import { formatDateTime } from "@/lib/format";
import { useKnownIds } from "@/lib/known-ids";
import { amountError, groupDigits } from "@/lib/money";
import { ownerPayloads, type OwnerRequest } from "@/lib/owner/authorize";

const FREQUENCIES = ["ON_DEMAND", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"] as const;
const VALIDITY = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

function usdc(minor: number | string, currency: "USD" | "USDC"): string {
  return `${groupDigits(formatAmount(mandateAmountToUsdcMinor(minor, currency), 6))} USDC`;
}

/** Plain-language form of an AP2 mandate constraint. */
export function describeConstraint(c: MandateConstraint): string {
  switch (c.type) {
    case "payment.amount_range":
      return c.min !== undefined
        ? `Each payment between ${usdc(c.min, c.currency)} and ${usdc(c.max, c.currency)}`
        : `Each payment up to ${usdc(c.max, c.currency)}`;
    case "payment.budget":
      return `Total budget ${usdc(c.max, c.currency)}`;
    case "payment.allowed_payees":
      return `Payees: ${c.allowed.map((p) => p.name || p.id).join(", ")}`;
    case "agentbank.x402_domains":
      return `x402 domains: ${c.allowed.join(", ")}`;
    case "payment.agent_recurrence":
      return `Recurrence ${c.frequency.toLowerCase().replace("_", " ")}${c.max_occurrences ? `, at most ${c.max_occurrences} times` : ""}`;
    case "payment.execution_date":
      return `Executes ${c.not_before ? `from ${formatDateTime(c.not_before)}` : ""}${c.not_before && c.not_after ? " " : ""}${c.not_after ? `until ${formatDateTime(c.not_after)}` : ""}`;
  }
}

function lines(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function IssueMandateDialog({
  agent,
  open,
  onClose,
  onIssued,
}: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  onIssued: (id: string) => void;
}) {
  const toast = useToast();
  const [description, setDescription] = useState("");
  const [maxPerPayment, setMaxPerPayment] = useState("");
  const [budget, setBudget] = useState("");
  const [payees, setPayees] = useState("");
  const [domains, setDomains] = useState("");
  const [frequency, setFrequency] = useState("");
  const [validDays, setValidDays] = useState(30);
  const [key, rotate] = useIdempotencyKey();

  const errors = {
    maxPerPayment: maxPerPayment ? amountError(maxPerPayment) : null,
    budget: budget ? amountError(budget) : null,
    domains: lines(domains).some((d) => !/^[a-z0-9.-]+$/.test(d)) ? "Domains are lowercase host names" : null,
  };

  function constraints(): MandateConstraint[] {
    const out: MandateConstraint[] = [];
    if (maxPerPayment && !errors.maxPerPayment) {
      out.push({
        type: "payment.amount_range",
        currency: "USDC",
        max: parseAmount(maxPerPayment, 6).toString(),
      });
    }
    if (budget && !errors.budget) {
      out.push({ type: "payment.budget", currency: "USDC", max: parseAmount(budget, 6).toString() });
    }
    const payeeList = lines(payees);
    if (payeeList.length)
      out.push({ type: "payment.allowed_payees", allowed: payeeList.map((id) => ({ id, name: id })) });
    const domainList = lines(domains);
    if (domainList.length && !errors.domains)
      out.push({ type: "agentbank.x402_domains", allowed: domainList });
    if (frequency) {
      out.push({ type: "payment.agent_recurrence", frequency: frequency as (typeof FREQUENCIES)[number] });
    }
    return out;
  }

  const draft = constraints();
  const valid = draft.length > 0 && !Object.values(errors).some(Boolean);
  const request: OwnerRequest | null = valid
    ? ownerPayloads.mandateIssue(agent.id, { constraints: draft })
    : null;

  return (
    <OwnerActionDialog
      open={open}
      onClose={onClose}
      title={`Issue a mandate to ${agent.name}`}
      description="An AP2 open payment mandate: signed proof that you authorized this spending. The bank compiles it into session scope and policy rules."
      request={request}
      submitLabel="Sign and issue"
      finalize={() => {
        const iat = Math.floor(Date.now() / 1000);
        const mandate: OpenPaymentMandate = OpenPaymentMandateSchema.parse({
          vct: "mandate.payment.open.1",
          constraints: draft,
          iat,
          exp: iat + validDays * 86_400,
          agent_id: agent.id,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        return ownerPayloads.mandateIssue(agent.id, mandate);
      }}
      onSubmit={async (authorization, signed) => {
        try {
          const created = await apiFetch("createMandate", {
            body: {
              agent_id: agent.id,
              mandate: signed.payload as OpenPaymentMandate,
              owner_authorization: authorization,
            },
            idempotencyKey: key,
          });
          rotate();
          onIssued(created.id);
          toast({ title: "Mandate issued", description: "Payments under it record the mandate id." });
          return { ok: true };
        } catch (error) {
          return { ok: false, problem: ApiProblem.from(error) };
        }
      }}
    >
      <div className="space-y-4">
        <TextAreaField
          label="Intent"
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          hint="What you are authorizing, in words. Shown to auditors and counterparties."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Max per payment (USDC)"
            inputMode="decimal"
            value={maxPerPayment}
            onChange={(e) => setMaxPerPayment(e.target.value)}
            error={errors.maxPerPayment}
          />
          <TextField
            label="Total budget (USDC)"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            error={errors.budget}
          />
        </div>
        <TextAreaField
          label="Allowed payees"
          rows={2}
          value={payees}
          onChange={(e) => setPayees(e.target.value)}
          hint="Addresses, agent ids (agt_…), ERC-8004 ids or domains, one per line."
          inputClassName="font-mono text-xs"
        />
        <TextAreaField
          label="x402 domains"
          rows={2}
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          hint="Hosts the agent may pay per call, one per line."
          inputClassName="font-mono text-xs"
          error={errors.domains}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Recurrence" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="">None</option>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f.toLowerCase().replace("_", " ")}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Valid for"
            value={String(validDays)}
            onChange={(e) => setValidDays(Number(e.target.value))}
          >
            {VALIDITY.map((v) => (
              <option key={v.days} value={v.days}>
                {v.label}
              </option>
            ))}
          </SelectField>
        </div>
        {draft.length === 0 ? <p className="text-sm text-muted">Add at least one constraint.</p> : null}
      </div>
    </OwnerActionDialog>
  );
}

function MandateItem({ id, onForget }: { id: string; onForget: () => void }) {
  const mandate = useApi("getMandate", { params: { id } });
  const [confirm, setConfirm] = useState(false);
  const revoke = useMutation(() => apiFetch("revokeMandate", { params: { id } }), {
    invalidates: ["getMandate"],
  });
  if (mandate.error) {
    return (
      <li className="space-y-2 px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <IdValue value={id} />
          <Button size="sm" variant="ghost" onClick={onForget}>
            Remove from list
          </Button>
        </div>
        <ProblemAlert problem={mandate.error} />
      </li>
    );
  }
  if (!mandate.data) {
    return (
      <li>
        <LoadingState label="Loading mandate" rows={1} />
      </li>
    );
  }
  const m = mandate.data;
  return (
    <li className="space-y-2 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <IdValue value={m.id} />
          <StatusBadge status={m.status} />
          <span className="text-xs text-muted">
            Expires <DateTimeValue value={m.expires_at} />
          </span>
        </div>
        {m.status === "active" ? (
          confirm ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={revoke.pending}
                onClick={async () => {
                  const result = await revoke.run();
                  if (result.ok) setConfirm(false);
                }}
              >
                Confirm revoke
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
              Revoke
            </Button>
          )
        ) : (
          <Button size="sm" variant="ghost" onClick={onForget}>
            Remove from list
          </Button>
        )}
      </div>
      {m.mandate.description ? <p className="text-sm">{m.mandate.description}</p> : null}
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
        {m.mandate.constraints.map((c, i) => (
          <li key={`${c.type}-${i}`}>{describeConstraint(c)}</li>
        ))}
      </ul>
      <p className="text-sm">
        Spent so far: <Amount value={m.spent} />
      </p>
      {revoke.error ? <ProblemAlert problem={revoke.error} /> : null}
    </li>
  );
}

export function MandatesCard({ agent }: { agent: Agent }) {
  const [ids, remember, forget] = useKnownIds(`mandates.${agent.id}`);
  const [issuing, setIssuing] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookup, setLookup] = useState("");
  const valid = /^mdt_[0-9A-HJKMNP-TV-Z]{26}$/.test(lookup.trim());

  function submitLookup(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    remember(lookup.trim());
    setLookup("");
    setLookupOpen(false);
  }

  return (
    <Card aria-labelledby="mandates-title">
      <CardHeader
        id="mandates-title"
        title="Mandates"
        description="Signed AP2 payment mandates: cryptographic proof that a human authorized the spend."
        actions={
          <>
            <Button size="sm" onClick={() => setLookupOpen(true)}>
              Look up by id
            </Button>
            <Button size="sm" variant="owner" icon={<IconPlus size={16} />} onClick={() => setIssuing(true)}>
              Issue mandate
            </Button>
          </>
        }
      />
      {ids.length === 0 ? (
        <EmptyState
          icon={<IconLedger size={20} />}
          title="No mandates in this browser"
          description="The API cannot list mandates yet. Mandates you issue or look up here are remembered in this browser."
        />
      ) : (
        <ul className="divide-y divide-line">
          {ids.map((id) => (
            <MandateItem key={id} id={id} onForget={() => forget(id)} />
          ))}
        </ul>
      )}
      {issuing ? (
        <IssueMandateDialog
          agent={agent}
          open={issuing}
          onClose={() => setIssuing(false)}
          onIssued={(id) => remember(id)}
        />
      ) : null}
      <Dialog open={lookupOpen} onClose={() => setLookupOpen(false)} title="Look up a mandate" size="sm">
        <form onSubmit={submitLookup} className="space-y-4">
          <TextField
            label="Mandate id"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="mdt_…"
            spellCheck={false}
            inputClassName="font-mono"
            error={lookup && !valid ? "Mandate ids look like mdt_ followed by 26 characters" : null}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLookupOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid}>
              Show mandate
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
