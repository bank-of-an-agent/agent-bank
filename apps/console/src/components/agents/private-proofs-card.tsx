"use client";

import type { OwnerAuthorization } from "@agentbank/core";
import { useId, useRef, useState } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/field";
import { IconAlert, IconCheck, IconKey, IconLock } from "@/components/ui/icons";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, HexValue, MoneyValue } from "@/components/ui/values";
import { newIdempotencyKey } from "@/lib/api/client";
import { apiFetch, useApi, useApiList, useInvalidate } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import type { Account, Agent, ProofReservation, ProofRoot, ProofSettings } from "@/lib/api/queries";
import { ownerPayloads } from "@/lib/owner/authorize";
import {
  canonicalClasses,
  classifyDisclosureChange,
  classList,
  DEFAULT_MIN_ANONYMITY_SET,
  DISCLOSURE_CLASS_INFO,
  DISCLOSURE_CLASSES,
  type DisclosureChange,
  type DisclosureClass,
  type DisclosureDraft,
} from "@/lib/proofs";

/**
 * Private proofs for one agent (docs/private-proofs.md): what the owner lets it prove, whether its
 * runtime has enrolled an identity, the latest attested root and its proof-of-funds reservations.
 * Widening disclosure needs the owner key (`proofs.disclose`); narrowing applies at once.
 */

const RESERVATION_LABELS: Record<ProofReservation["status"], string> = {
  pending: "Pending next root",
  active: "Active",
  released: "Released",
  expired: "Expired",
};

/** One idempotency key per distinct request body: a retry of the same body reuses it. */
function useRequestKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body: unknown): string => {
    const text = JSON.stringify(body);
    if (last.current?.body !== text) last.current = { body: text, key: newIdempotencyKey() };
    return last.current.key;
  };
}

// ---------------------------------------------------------------- editing

type Step = "edit" | "confirm" | "owner";

function ChangeSummary({
  change,
  current,
  enabled,
}: {
  change: DisclosureChange;
  current: ProofSettings;
  enabled: boolean;
}) {
  if (!change.changed) return <p className="text-sm text-muted">Nothing changed yet.</p>;
  if (change.widening) {
    const what = [
      !current.enabled && enabled ? "turning proofs on" : null,
      change.added.length ? `disclosing ${classList(change.added)}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const lead = what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}` : "This";
    return (
      <Callout tone="owner" icon={<IconKey size={16} />} title="Widening needs the owner key">
        <p>
          {lead} lets verifiers learn more about this agent, so the owner signs it (
          <code>proofs.disclose</code>). It applies from the next root, usually within a minute.
          {change.narrowing && change.removed.length
            ? ` Removing ${classList(change.removed)} applies at the same time and revokes older roots.`
            : ""}
        </p>
      </Callout>
    );
  }
  if (change.narrowing) {
    return (
      <Callout tone="warn" icon={<IconAlert size={16} />} title="Narrowing applies immediately">
        <p>
          No owner signature is needed. Agent Bank publishes a new root at once and revokes every older one,
          so proofs made under the wider disclosure stop verifying.
        </p>
      </Callout>
    );
  }
  return (
    <Callout tone="info">
      Proofs are off, so this only changes what will be disclosed once they are turned on.
    </Callout>
  );
}

function EditDisclosureDialog({
  agent,
  settings,
  initial,
  startAt,
  onClose,
}: {
  agent: Agent;
  settings: ProofSettings;
  initial: DisclosureDraft;
  startAt: "edit" | "confirm";
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const keyFor = useRequestKey();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [classes, setClasses] = useState<DisclosureClass[]>(() => canonicalClasses(initial.disclose));
  const [step, setStep] = useState<Step>(startAt);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const saved = useRef(false);

  const change = classifyDisclosureChange(settings, { enabled, disclose: classes });
  const turningOff = settings.enabled && !enabled;

  function toggle(c: DisclosureClass, on: boolean) {
    setProblem(null);
    setClasses((prev) => canonicalClasses(on ? [...prev, c] : prev.filter((x) => x !== c)));
  }

  function announce(signed: boolean) {
    void invalidate("getProofSettings", "listProofRoots");
    if (signed) {
      toast({
        title: !settings.enabled && enabled ? "Private proofs turned on" : "Disclosure widened",
        description: "Signed by the owner key. It applies from the next root, usually within a minute.",
      });
    } else if (change.narrowing) {
      toast({
        title: turningOff ? "Private proofs turned off" : "Disclosure narrowed",
        description: "A new root is published now and older roots are revoked.",
      });
    } else {
      toast({ title: "Disclosure saved", description: "It applies once private proofs are turned on." });
    }
  }

  async function put(body: {
    enabled: boolean;
    disclose: DisclosureClass[];
    owner_authorization?: OwnerAuthorization;
  }) {
    return apiFetch("updateProofSettings", {
      params: { id: agent.id },
      body,
      idempotencyKey: keyFor(body),
    });
  }

  /** Narrowing (or a change while proofs are off): no owner signature. */
  async function apply() {
    setBusy(true);
    setProblem(null);
    try {
      await put({ enabled, disclose: change.next });
      setBusy(false);
      announce(false);
      onClose();
    } catch (error) {
      const p = ApiProblem.from(error);
      setBusy(false);
      // The API is authoritative: if the stored settings differ from what this page shows, it may
      // classify the change as widening and ask for the owner key.
      if (p.code === "owner_signature_required") {
        void invalidate("getProofSettings");
        setStep("owner");
      } else {
        setProblem(p);
      }
    }
  }

  function next() {
    if (change.widening) setStep("owner");
    else if (change.narrowing) setStep("confirm");
    else void apply();
  }

  const editing = step === "edit";
  const footer = editing ? (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      {change.widening ? (
        <Button variant="owner" icon={<IconKey size={16} />} onClick={next}>
          Continue to owner signature…
        </Button>
      ) : change.narrowing ? (
        <Button variant="danger" onClick={next}>
          Review and apply…
        </Button>
      ) : (
        <Button variant="primary" loading={busy} disabled={!change.changed} onClick={next}>
          Save
        </Button>
      )}
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => setStep("edit")} disabled={busy}>
        Back
      </Button>
      <Button variant="danger" loading={busy} onClick={() => void apply()}>
        {turningOff ? "Turn off now" : "Narrow now"}
      </Button>
    </>
  );

  return (
    <>
      <Dialog
        open={step !== "owner"}
        onClose={onClose}
        dismissible={!busy}
        tone={editing ? "default" : "danger"}
        title={
          editing
            ? `What ${agent.name} may prove`
            : turningOff
              ? `Turn off private proofs for ${agent.name}?`
              : `Narrow what ${agent.name} may prove?`
        }
        description={
          editing
            ? "A verifier can only ask about the classes you disclose; the circuit enforces it. Widening needs the owner key, narrowing applies at once."
            : "Narrowing needs no owner signature and takes effect immediately."
        }
        footer={footer}
      >
        {editing ? (
          <div className="space-y-4">
            <Checkbox
              label="Private proofs on"
              hint="When off, the agent is left out of the attested tree and cannot prove anything."
              checked={enabled}
              onChange={(e) => {
                setProblem(null);
                setEnabled(e.target.checked);
              }}
            />
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Classes the agent may prove</legend>
              {DISCLOSURE_CLASSES.map((c) => (
                <Checkbox
                  key={c}
                  label={DISCLOSURE_CLASS_INFO[c].label}
                  hint={DISCLOSURE_CLASS_INFO[c].description}
                  checked={classes.includes(c)}
                  onChange={(e) => toggle(c, e.target.checked)}
                />
              ))}
            </fieldset>
            {enabled && classes.length === 0 ? (
              <p className="text-xs text-muted">
                With no classes disclosed, the agent can only prove that it is an Agent Bank agent.
              </p>
            ) : null}
            <ChangeSummary change={change} current={settings} enabled={enabled} />
            {problem ? <ProblemAlert problem={problem} /> : null}
          </div>
        ) : (
          <div className="space-y-4">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {turningOff ? (
                <li>Leave {agent.name} out of the attested tree: it can no longer prove anything.</li>
              ) : (
                <li>Stop disclosing {classList(change.removed)}.</li>
              )}
            </ul>
            <Callout tone="danger" icon={<IconAlert size={16} />} title="Applies immediately">
              Agent Bank rebuilds the tree now, publishes a new root and revokes every older root that is
              still valid, so proofs this agent already made stop verifying once the revocation lands.
              Widening again later needs the owner key.
            </Callout>
            {problem ? <ProblemAlert problem={problem} /> : null}
          </div>
        )}
      </Dialog>
      <OwnerActionDialog
        open={step === "owner"}
        onClose={() => (saved.current ? onClose() : setStep("edit"))}
        title={
          !settings.enabled && enabled
            ? `Turn on private proofs for ${agent.name}`
            : `Widen what ${agent.name} may prove`
        }
        description="Turning proofs on or disclosing another class tells verifiers more about this agent, so it needs the owner key. It applies from the next root."
        request={ownerPayloads.proofsDisclose(agent.id, { enabled, disclose: change.next })}
        submitLabel="Sign and save"
        onSubmit={async (authorization, signed) => {
          const payload = signed.payload as { enabled: boolean; disclose: DisclosureClass[] };
          try {
            await put({
              enabled: payload.enabled,
              disclose: payload.disclose,
              owner_authorization: authorization,
            });
            saved.current = true;
            announce(true);
            return { ok: true };
          } catch (error) {
            return { ok: false, problem: ApiProblem.from(error) };
          }
        }}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {!settings.enabled && enabled ? <li>Turn private proofs on</li> : null}
          {change.added.length ? <li>Disclose {classList(change.added)}</li> : null}
          {change.removed.length ? <li>Stop disclosing {classList(change.removed)}</li> : null}
          <li>
            {enabled ? "The agent may then prove: " : "Disclosed once proofs are on: "}
            {change.next.length ? classList(change.next) : "nothing beyond being an Agent Bank agent"}
          </li>
        </ul>
      </OwnerActionDialog>
    </>
  );
}

// ---------------------------------------------------------------- read-only parts

function DisclosureClasses({ settings }: { settings: ProofSettings }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-semibold">
        What it may prove
      </h3>
      {!settings.enabled ? (
        <p className="text-xs text-muted">Disclosed classes take effect only while proofs are on.</p>
      ) : null}
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {DISCLOSURE_CLASSES.map((c) => {
          const on = settings.disclose.includes(c);
          const info = DISCLOSURE_CLASS_INFO[c];
          return (
            <li key={c} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2">
              {on ? (
                <IconCheck size={16} className="mt-0.5 shrink-0 text-teal-fg" />
              ) : (
                <IconLock size={16} className="mt-0.5 shrink-0 text-muted" />
              )}
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {info.label}
                  <Badge tone={on ? "teal" : "neutral"}>{on ? "Disclosed" : "Not disclosed"}</Badge>
                </p>
                <p className="text-xs text-muted">{info.description}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function IdentityStatus({ account }: { account: Account | null }) {
  const identity = useApi(
    account ? "getProofIdentity" : null,
    { params: { id: account?.id ?? "" } },
    { refreshInterval: 60_000 },
  );
  if (!account) return <p className="text-sm text-muted">The agent has no account yet.</p>;
  if (identity.error) {
    if (identity.error.extensions.reason === "not_enrolled") {
      return (
        <div className="space-y-1">
          <Badge tone="neutral">Not enrolled</Badge>
          <p className="text-xs text-muted">
            The agent&apos;s runtime enrolls with the SDK (<code>agent.proofs.enroll()</code>), keeping its
            secret to itself. Until then it has no leaf in the tree, even with proofs on.
          </p>
        </div>
      );
    }
    return <ProblemAlert problem={identity.error} compact onRetry={() => void identity.mutate()} />;
  }
  if (!identity.data) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="teal">Enrolled</Badge>
        <span className="text-xs text-muted">
          since <DateTimeValue value={identity.data.created_at} />
        </span>
      </p>
      <p className="text-xs text-muted">
        Commitment{" "}
        <HexValue value={identity.data.identity_commitment} kind="hash" label="identity commitment" />. The
        secret behind it never leaves the agent, so Agent Bank cannot prove on its behalf.
      </p>
    </div>
  );
}

function LatestRoot() {
  const roots = useApi("listProofRoots", { query: { limit: 1 } }, { refreshInterval: 60_000 });
  if (roots.error) return <ProblemAlert problem={roots.error} compact onRetry={() => void roots.mutate()} />;
  if (!roots.data) return <p className="text-sm text-muted">Loading…</p>;
  const root = roots.data.data[0];
  if (!root) {
    return (
      <p className="text-sm text-muted">
        No root yet. Agent Bank publishes one once an enrolled agent has proofs on.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <DescriptionList
        items={[
          { term: "Epoch", detail: <span className="tabular">{root.epoch}</span> },
          { term: "Status", detail: <StatusBadge status={root.status} /> },
          {
            term: "Anonymity set",
            detail: `${root.leaf_count} agent${root.leaf_count === 1 ? "" : "s"} in the tree`,
          },
          { term: "Valid until", detail: <DateTimeValue value={root.valid_until} /> },
        ]}
      />
      {root.leaf_count < DEFAULT_MIN_ANONYMITY_SET ? (
        <p className="text-xs text-warn-fg">
          Fewer than {DEFAULT_MIN_ANONYMITY_SET} agents: verifiers using the SDK defaults refuse proofs
          against this root.
        </p>
      ) : null}
    </div>
  );
}

function ReleaseReservationDialog({
  reservation,
  agentName,
  onClose,
}: {
  reservation: ProofReservation;
  agentName: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  return (
    <OwnerActionDialog
      open
      onClose={onClose}
      title="Release a reservation early"
      description="The agent cannot cancel a reservation; only the owner can, with the owner key. Releasing returns the funds to the agent's available balance now and revokes every root that contains the reservation, so the verifier can no longer rely on it."
      request={ownerPayloads.proofReservationRelease(reservation.id)}
      submitLabel="Sign and release"
      onSubmit={async (authorization) => {
        try {
          await apiFetch("releaseProofReservation", {
            params: { id: reservation.id },
            body: { owner_authorization: authorization },
            idempotencyKey: newIdempotencyKey(),
          });
          void invalidate("listProofReservations", "getProofReservation", "listProofRoots", "getBalances");
          toast({
            title: "Reservation released",
            description: `${reservation.amount.amount} ${reservation.amount.asset} is available to ${agentName} again.`,
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, problem: ApiProblem.from(error) };
        }
      }}
    >
      <DescriptionList
        items={[
          { term: "Amount", detail: <MoneyValue money={reservation.amount} /> },
          {
            term: "Verifier tag",
            detail: <code className="font-mono text-xs break-all">{reservation.scope_tag}</code>,
          },
          { term: "Expires", detail: <DateTimeValue value={reservation.expires_at} /> },
          {
            term: "Status",
            detail: (
              <StatusBadge status={reservation.status} label={RESERVATION_LABELS[reservation.status]} />
            ),
          },
        ]}
      />
    </OwnerActionDialog>
  );
}

function OpenReservations({ agent, account }: { agent: Agent; account: Account }) {
  const headingId = useId();
  // Open reservations are exactly the pending and active ones; the API filters one status at a time.
  const pending = useApi(
    "listProofReservations",
    { params: { id: account.id }, query: { status: "pending", limit: 100 } },
    { refreshInterval: 30_000 },
  );
  const active = useApi(
    "listProofReservations",
    { params: { id: account.id }, query: { status: "active", limit: 100 } },
    { refreshInterval: 30_000 },
  );
  const [releasing, setReleasing] = useState<ProofReservation | null>(null);
  const error = pending.error ?? active.error;
  const items = [...(pending.data?.data ?? []), ...(active.data?.data ?? [])].sort(
    (a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at),
  );
  const truncated = Boolean(pending.data?.next_cursor || active.data?.next_cursor);

  return (
    <section aria-labelledby={headingId} className="border-t border-line">
      <div className="px-4 pt-4 sm:px-5">
        <h3 id={headingId} className="text-sm font-semibold">
          Open reservations (proof of funds)
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          Funds the agent holds for one verifier until they expire. The agent cannot cancel them; the owner
          can release one early.
        </p>
      </div>
      {error ? (
        <div className="p-4 sm:px-5">
          <ProblemAlert
            problem={error}
            onRetry={() => {
              void pending.mutate();
              void active.mutate();
            }}
          />
        </div>
      ) : !pending.data || !active.data ? (
        <LoadingState label="Loading reservations" rows={2} />
      ) : items.length === 0 ? (
        <EmptyState
          className="py-6"
          title="No open reservations"
          description="The agent reserves funds for a verifier with agent.proofs.reserve(); they appear here while held."
        />
      ) : (
        <>
          <Table caption="Open proof-of-funds reservations" className="mt-3">
            <THead>
              <tr>
                <Th align="right">Amount</Th>
                <Th>Verifier tag</Th>
                <Th>Expires</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody>
              {items.map((r) => (
                <Tr key={r.id}>
                  <Td align="right">
                    <MoneyValue money={r.amount} />
                  </Td>
                  <Td>
                    <code className="font-mono text-xs" title="Low 64 bits of the verifier's scope">
                      {r.scope_tag}
                    </code>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <DateTimeValue value={r.expires_at} />
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} label={RESERVATION_LABELS[r.status]} />
                  </Td>
                  <Td align="right">
                    <Button size="sm" variant="owner" onClick={() => setReleasing(r)}>
                      Release early…{" "}
                      <span className="sr-only">
                        the {r.amount.amount} {r.amount.asset} reservation
                      </span>
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {truncated ? (
            <p className="border-t border-line px-4 py-2 text-xs text-muted sm:px-5">
              Showing the first 100 pending and 100 active reservations.
            </p>
          ) : null}
        </>
      )}
      {releasing ? (
        <ReleaseReservationDialog
          reservation={releasing}
          agentName={agent.name}
          onClose={() => setReleasing(null)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- the card

function ProofsCard({ agent, account }: { agent: Agent; account: Account | null }) {
  const settings = useApi("getProofSettings", { params: { id: agent.id } }, { refreshInterval: 60_000 });
  const [editing, setEditing] = useState<{ initial: DisclosureDraft; startAt: "edit" | "confirm" } | null>(
    null,
  );
  const s = settings.data;
  const identityId = useId();
  const rootId = useId();
  const gated = settings.error?.code === "feature_gated";

  const actions = s ? (
    s.enabled ? (
      <>
        <Button size="sm" onClick={() => setEditing({ initial: s, startAt: "edit" })}>
          Edit disclosure…
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() =>
            setEditing({ initial: { enabled: false, disclose: s.disclose }, startAt: "confirm" })
          }
        >
          Turn off
        </Button>
      </>
    ) : (
      <Button
        size="sm"
        variant="owner"
        icon={<IconKey size={16} />}
        onClick={() => setEditing({ initial: { enabled: true, disclose: s.disclose }, startAt: "edit" })}
      >
        Turn on…
      </Button>
    )
  ) : undefined;

  return (
    <Card aria-labelledby="private-proofs-title">
      <div id="private-proofs" />
      <CardHeader
        id="private-proofs-title"
        title="Private proofs"
        description="Let the agent prove facts about itself (a verified company backs it, it can pay, funds are reserved) without revealing which agent it is. What it may prove is the owner's decision."
        actions={actions}
      />
      {gated ? (
        <CardBody>
          <Callout tone="info">Private proofs are not enabled on this deployment.</Callout>
        </CardBody>
      ) : (
        <>
          <CardBody className="space-y-5">
            <Callout tone="warn" icon={<IconAlert size={16} />} title="Testnet only">
              Verifiers trust Agent Bank as the attester of these facts, and the proving keys come from a
              single-party testnet setup. Mainnet needs a public multi-party ceremony and an audit.
            </Callout>
            {settings.error ? (
              <ProblemAlert problem={settings.error} onRetry={() => void settings.mutate()} />
            ) : !s ? (
              <LoadingState label="Loading proof settings" rows={3} className="px-0 py-0" />
            ) : (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={s.enabled ? "enabled" : "disabled"} />
                  <span className="text-muted">
                    {s.enabled
                      ? "The agent is in the attested tree and can prove the classes it discloses."
                      : "The agent is left out of the attested tree and cannot prove anything."}
                  </span>
                </p>
                <DisclosureClasses settings={s} />
              </>
            )}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <section aria-labelledby={identityId} className="space-y-2">
                <h3 id={identityId} className="text-sm font-semibold">
                  Identity
                </h3>
                <IdentityStatus account={account} />
              </section>
              <section aria-labelledby={rootId} className="space-y-2">
                <h3 id={rootId} className="text-sm font-semibold">
                  Latest root
                </h3>
                <LatestRoot />
              </section>
            </div>
          </CardBody>
          {account ? <OpenReservations agent={agent} account={account} /> : null}
        </>
      )}
      {editing && s ? (
        <EditDisclosureDialog
          agent={agent}
          settings={s}
          initial={editing.initial}
          startAt={editing.startAt}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

/** The agent detail page's "Private proofs" card. Hidden when the deployment turns the feature off. */
export function PrivateProofsCard({ agent, accounts }: { agent: Agent; accounts: Account[] }) {
  const { features } = useConsoleConfig();
  if (features.private_proofs === false) return null;
  return <ProofsCard agent={agent} account={accounts[0] ?? null} />;
}

// ---------------------------------------------------------------- org level: recent roots

function RootsTable() {
  const list = useApiList("listProofRoots", { query: { limit: 10 } }, { refreshInterval: 60_000 });
  if (list.error?.code === "feature_gated") {
    return (
      <div className="p-4 sm:px-5">
        <Callout tone="info">Private proofs are not enabled on this deployment.</Callout>
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="p-4 sm:px-5">
        <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
      </div>
    );
  }
  if (list.isLoading) return <LoadingState label="Loading roots" rows={3} />;
  if (list.items.length === 0) {
    return (
      <EmptyState
        icon={<IconLock size={20} />}
        title="No roots yet"
        description="Agent Bank publishes a root once an enrolled agent has private proofs on."
      />
    );
  }
  return (
    <>
      <Table caption="Attested-facts roots, newest first">
        <THead>
          <tr>
            <Th>Epoch</Th>
            <Th align="right">Agents</Th>
            <Th>Snapshot</Th>
            <Th>Valid until</Th>
            <Th>Status</Th>
            <Th>Root</Th>
            <Th>Transaction</Th>
          </tr>
        </THead>
        <tbody>
          {list.items.map((root: ProofRoot) => (
            <Tr key={root.root}>
              <Td className="tabular">{root.epoch}</Td>
              <Td align="right">{root.leaf_count}</Td>
              <Td className="whitespace-nowrap">
                <DateTimeValue value={root.snapshot_at} />
              </Td>
              <Td className="whitespace-nowrap">
                <DateTimeValue value={root.valid_until} />
              </Td>
              <Td>
                <StatusBadge status={root.status} />
              </Td>
              <Td>
                <HexValue value={root.root} kind="hash" label={`root of epoch ${root.epoch}`} />
              </Td>
              <Td>
                <HexValue
                  value={root.tx_hash}
                  kind="tx"
                  chain={root.chain_id}
                  label={`transaction of epoch ${root.epoch}`}
                />
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
  );
}

/**
 * Recent attested-facts roots (public data): what anyone reading Base sees. Each proof hides its
 * agent among the agents in its root, so the leaf count is the anonymity set.
 */
export function ProofRootsCard() {
  const { features } = useConsoleConfig();
  if (features.private_proofs === false) return null;
  return (
    <Card aria-labelledby="proof-roots-title">
      <CardHeader
        id="proof-roots-title"
        title="Private proofs: published roots"
        description="Merkle roots of the facts Agent Bank attests, anchored on Base and public. A proof hides its agent among the agents in its root."
      />
      <RootsTable />
    </Card>
  );
}
