"use client";

import type { OwnerAuthorization } from "@agentbank/core";
import { useState, type ReactNode } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconKey } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout } from "@/components/ui/states";
import { ApiProblem } from "@/lib/api/problem";
import {
  OWNER_ACTION_LABELS,
  OWNER_AUTHORIZATION_TTL_SECONDS,
  ownerAuthorize,
  type OwnerRequest,
} from "@/lib/owner/authorize";
import { OwnerKeyError } from "@/lib/owner/signer";
import { useOwnerKey } from "./owner-key-provider";
import { OwnerSignerPanel, useOwnerReady } from "./owner-signer-panel";

export type SubmitResult = { ok: true } | { ok: false; problem: ApiProblem };

/**
 * Collects an EIP-712 `OwnerAuthorization` from the owner key and hands it to
 * `onSubmit`. The dialog says exactly what is being authorized before the
 * wallet prompt, and keeps the problem details if the API refuses.
 */
export function OwnerActionDialog({
  open,
  onClose,
  title,
  description,
  request,
  children,
  canSubmit = true,
  submitLabel = "Sign with owner key",
  finalize,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** What to sign, built from the current inputs; `null` while inputs are incomplete. */
  request: OwnerRequest | null;
  children?: ReactNode;
  canSubmit?: boolean;
  submitLabel?: string;
  /** Stamp time-dependent fields (e.g. an expiry) at the moment of signing. */
  finalize?: (request: OwnerRequest) => OwnerRequest;
  /** Receives the authorization and the exact request it signs; send `request.payload` values. */
  onSubmit: (authorization: OwnerAuthorization, request: OwnerRequest) => Promise<SubmitResult>;
}) {
  const owner = useOwnerKey();
  const { chainId } = useConsoleConfig();
  const { ready, reason } = useOwnerReady();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setProblem(null);
    setWalletError(null);
    onClose();
  }

  async function submit() {
    if (!owner.signer || !request) return;
    setBusy(true);
    setProblem(null);
    setWalletError(null);
    try {
      const signed = finalize ? finalize(request) : request;
      const authorization = await ownerAuthorize(owner.signer, chainId, signed);
      const result = await onSubmit(authorization, signed);
      if (result.ok) {
        setBusy(false);
        onClose();
        return;
      }
      setProblem(result.problem);
    } catch (error) {
      if (error instanceof OwnerKeyError) setWalletError(error.message);
      else setProblem(ApiProblem.from(error));
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      tone="owner"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="owner"
            icon={<IconKey size={16} />}
            loading={busy}
            disabled={!ready || !request || !canSubmit}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {request ? (
          <div className="rounded-lg border border-line bg-subtle px-4 py-3 text-sm">
            <p className="font-medium">You are authorizing</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Action</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {OWNER_ACTION_LABELS[request.action]}
                <Badge tone="amber">
                  <code className="font-mono">{request.action}</code>
                </Badge>
              </dd>
              <dt className="text-muted">Subject</dt>
              <dd>
                <code className="font-mono text-xs break-all">{request.subject}</code>
              </dd>
              <dt className="text-muted">Valid for</dt>
              <dd>
                {OWNER_AUTHORIZATION_TTL_SECONDS / 60} minutes after signing (EIP-712, chain {chainId})
              </dd>
            </dl>
          </div>
        ) : null}
        <OwnerSignerPanel />
        {!ready && reason && owner.signer ? <Callout tone="warn">{reason}</Callout> : null}
        {walletError ? (
          <Callout tone="danger" title="Not signed">
            {walletError}
          </Callout>
        ) : null}
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </Dialog>
  );
}
