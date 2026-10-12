"use client";

import { LOOSENING_DELAY_SECONDS, type OwnerAuthorization } from "@agentbank/core";
import { useState } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { Button } from "@/components/ui/button";
import { Countdown } from "@/components/ui/countdown";
import { Dialog } from "@/components/ui/dialog";
import { TextAreaField } from "@/components/ui/field";
import { IconFreeze } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import type { Agent, Org } from "@/lib/api/queries";
import { formatTime } from "@/lib/format";
import { ownerPayloads } from "@/lib/owner/authorize";

const DELAY_MINUTES = LOOSENING_DELAY_SECONDS / 60;

/** Freezing is a tightening change: immediate, no owner key needed. */
function FreezeDialog({
  open,
  onClose,
  title,
  impact,
  onFreeze,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  impact: string;
  onFreeze: (reason: string) => void;
  pending: boolean;
  error: ReturnType<typeof useMutation>["error"];
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      tone="danger"
      dismissible={!pending}
      description="Freezing applies at once. Unfreezing later needs the owner key and a 1-hour delay."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={<IconFreeze size={16} />}
            loading={pending}
            disabled={!reason.trim()}
            onClick={() => onFreeze(reason.trim())}
          >
            Freeze now
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Callout tone="danger">{impact}</Callout>
        <TextAreaField
          label="Reason"
          required
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Recorded in the audit log and shown to other admins."
        />
        {error ? <ProblemAlert problem={error} /> : null}
      </div>
    </Dialog>
  );
}

export function FreezeAgentButton({ agent, size = "md" }: { agent: Agent; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [key, rotate] = useIdempotencyKey();
  const toast = useToast();
  const freeze = useMutation(
    (reason: string) =>
      apiFetch("freezeAgent", { params: { id: agent.id }, body: { reason }, idempotencyKey: key }),
    { invalidates: ["getAgent", "listAgents"] },
  );
  return (
    <>
      <Button variant="danger" size={size} icon={<IconFreeze size={16} />} onClick={() => setOpen(true)}>
        Freeze agent
      </Button>
      <FreezeDialog
        open={open}
        onClose={() => {
          setOpen(false);
          freeze.reset();
        }}
        title={`Freeze ${agent.name}`}
        impact="The co-signer will refuse every operation this agent attempts, starting now. Pending approvals stay pending."
        pending={freeze.pending}
        error={freeze.error}
        onFreeze={async (reason) => {
          const result = await freeze.run(reason);
          if (result.ok) {
            rotate();
            setOpen(false);
            toast({
              title: `${agent.name} is frozen`,
              description: "The co-signer now refuses its operations.",
            });
          }
        }}
      />
    </>
  );
}

export function UnfreezeAgentButton({ agent, size = "md" }: { agent: Agent; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [key, rotate] = useIdempotencyKey();
  const toast = useToast();
  const unfreeze = useMutation(
    (owner_authorization: OwnerAuthorization) =>
      apiFetch("unfreezeAgent", {
        params: { id: agent.id },
        body: { reason: reason.trim(), owner_authorization },
        idempotencyKey: key,
      }),
    { invalidates: ["getAgent", "listAgents"] },
  );
  if (agent.pending_unfreeze_at) return null;
  return (
    <>
      <Button variant="owner" size={size} onClick={() => setOpen(true)}>
        Unfreeze…
      </Button>
      <OwnerActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Unfreeze ${agent.name}`}
        description={`Unfreezing loosens control, so it needs the owner key and takes effect ${DELAY_MINUTES} minutes after signing.`}
        request={reason.trim() ? ownerPayloads.agentUnfreeze(agent.id, reason.trim()) : null}
        submitLabel="Sign and schedule unfreeze"
        onSubmit={async (authorization) => {
          const result = await unfreeze.run(authorization);
          if (!result.ok) return result;
          rotate();
          setReason("");
          toast({
            title: "Unfreeze scheduled",
            description: result.data.pending_unfreeze_at
              ? `${agent.name} unfreezes at ${formatTime(result.data.pending_unfreeze_at)}.`
              : `${agent.name} unfreezes in about ${DELAY_MINUTES} minutes.`,
          });
          return { ok: true };
        }}
      >
        <TextAreaField
          label="Reason"
          required
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Signed together with the unfreeze."
        />
      </OwnerActionDialog>
    </>
  );
}

export function FreezeOrgButton({ size = "md" }: { size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [key, rotate] = useIdempotencyKey();
  const toast = useToast();
  const freeze = useMutation(
    (reason: string) => apiFetch("freezeOrg", { body: { reason }, idempotencyKey: key }),
    { invalidates: ["getCurrentOrg", "listAgents", "getAgent"] },
  );
  return (
    <>
      <Button variant="danger" size={size} icon={<IconFreeze size={16} />} onClick={() => setOpen(true)}>
        Freeze all agents
      </Button>
      <FreezeDialog
        open={open}
        onClose={() => {
          setOpen(false);
          freeze.reset();
        }}
        title="Freeze the whole organization"
        impact="Every agent stops: the co-signer refuses every operation for the org until the owner unfreezes it."
        pending={freeze.pending}
        error={freeze.error}
        onFreeze={async (reason) => {
          const result = await freeze.run(reason);
          if (result.ok) {
            rotate();
            setOpen(false);
            toast({ title: "Organization frozen", description: "Every agent is stopped." });
          }
        }}
      />
    </>
  );
}

export function UnfreezeOrgButton({ org, size = "md" }: { org: Org; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [key, rotate] = useIdempotencyKey();
  const toast = useToast();
  const unfreeze = useMutation(
    (owner_authorization: OwnerAuthorization) =>
      apiFetch("unfreezeOrg", { body: { reason: reason.trim(), owner_authorization }, idempotencyKey: key }),
    { invalidates: ["getCurrentOrg"] },
  );
  // Already signed: the unfreeze is waiting out the delay.
  if (org.pending_unfreeze_at) return null;
  return (
    <>
      <Button variant="owner" size={size} onClick={() => setOpen(true)}>
        Unfreeze organization…
      </Button>
      <OwnerActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Unfreeze the organization"
        description={`Unfreezing needs the owner key and takes effect ${DELAY_MINUTES} minutes after signing.`}
        request={reason.trim() ? ownerPayloads.orgUnfreeze(org.id, reason.trim()) : null}
        submitLabel="Sign and schedule unfreeze"
        onSubmit={async (authorization) => {
          const result = await unfreeze.run(authorization);
          if (!result.ok) return result;
          rotate();
          setReason("");
          toast({
            title: "Unfreeze scheduled",
            description: result.data.pending_unfreeze_at
              ? `The org unfreezes at ${formatTime(result.data.pending_unfreeze_at)}.`
              : `The org unfreezes in about ${DELAY_MINUTES} minutes.`,
          });
          return { ok: true };
        }}
      >
        <TextAreaField
          label="Reason"
          required
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Signed together with the unfreeze."
        />
      </OwnerActionDialog>
    </>
  );
}

/** Why the org is frozen and, once the owner signed an unfreeze, when it takes effect. */
export function OrgFreezeDetails({ org }: { org: Org }) {
  if (org.status !== "frozen") return null;
  return (
    <div className="space-y-1">
      {org.frozen_reason ? <p>Reason: {org.frozen_reason}</p> : null}
      {org.pending_unfreeze_at ? (
        <p className="flex flex-wrap items-center gap-2">
          The owner signed an unfreeze. It takes effect at {formatTime(org.pending_unfreeze_at)}:
          <Countdown to={org.pending_unfreeze_at} label="Unfreezes" expiredText="Unfreezing" />
        </p>
      ) : null}
    </div>
  );
}
