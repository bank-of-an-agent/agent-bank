"use client";

import { assertTestnet } from "@agentbank/core";
import { useCallback, useState, type ReactNode } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { Dialog } from "@/components/ui/dialog";
import { IconKey } from "@/components/ui/icons";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { HexValue, IdValue } from "@/components/ui/values";
import { apiFetch, useApi, useInvalidate } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { useOwnerInbox } from "@/lib/api/queries";
import { chainLabel } from "@/lib/chains";
import {
  isOperationHash,
  purposeLabel,
  signatureIdempotencyKey,
  type OwnerOperation,
} from "@/lib/owner/operations";
import { OwnerKeyError } from "@/lib/owner/signer";
import { useOwnerKey } from "./owner-key-provider";
import { OwnerSignerPanel, useOwnerReady } from "./owner-signer-panel";

export { OWNER_OPERATION_PURPOSES } from "@/lib/owner/operations";

/** Everything that may change once an owner operation is signed. */
const AFFECTED = [
  "getOwnerOperation",
  "listOwnerOperations",
  "getSession",
  "listSessions",
  "getPayment",
  "listPayments",
  "getVault",
  "listVaults",
  "getAutoTopUp",
  "listAutoTopUpRules",
  "getSweepRule",
  "getAccount",
  "listAccounts",
  "getBalances",
] as const;

export type SignResult =
  | { ok: true; operation: OwnerOperation }
  | { ok: false; problem: ApiProblem | null; walletError: string | null };

/**
 * Sign an owner operation's `user_op_hash` (EIP-191 over the raw 32 bytes)
 * with the connected owner key and submit the signature.
 */
export function useSignOwnerOperation() {
  const owner = useOwnerKey();
  const invalidate = useInvalidate();
  const [signing, setSigning] = useState<string | null>(null);
  const sign = useCallback(
    async (op: OwnerOperation): Promise<SignResult> => {
      if (op.status !== "requires_signature") return { ok: true, operation: op };
      const signer = owner.signer;
      if (!signer) return { ok: false, problem: null, walletError: "Connect the owner key first." };
      try {
        assertTestnet(op.chain_id);
      } catch {
        return { ok: false, problem: null, walletError: "Refusing to sign for a mainnet chain." };
      }
      if (!isOperationHash(op.user_op_hash)) {
        return { ok: false, problem: null, walletError: "Refusing to sign: the hash is not 32 bytes." };
      }
      setSigning(op.id);
      try {
        let signature: `0x${string}`;
        try {
          signature = await signer.signHash(op.user_op_hash);
        } catch (error) {
          const message =
            error instanceof OwnerKeyError || error instanceof Error ? error.message : "Not signed.";
          return { ok: false, problem: null, walletError: message };
        }
        try {
          const operation = await apiFetch("submitOwnerSignature", {
            params: { id: op.id },
            body: { signature },
            idempotencyKey: signatureIdempotencyKey(op.id, signature),
          });
          void invalidate(...AFFECTED);
          return { ok: true, operation };
        } catch (error) {
          return { ok: false, problem: ApiProblem.from(error), walletError: null };
        }
      } finally {
        setSigning(null);
      }
    },
    [owner.signer, invalidate],
  );
  return { sign, signing };
}

/** "Sign" for an operation already loaded (inbox rows): no extra request before the wallet prompt. */
export function SignOperationButton({
  operation,
  onResult,
  size = "sm",
  children = "Sign",
}: {
  operation: OwnerOperation;
  onResult?: (result: SignResult) => void;
  size?: "sm" | "md";
  children?: ReactNode;
}) {
  const { ready } = useOwnerReady();
  const { sign, signing } = useSignOwnerOperation();
  return (
    <Button
      size={size}
      variant="owner"
      icon={<IconKey size={14} />}
      disabled={
        !ready || operation.status !== "requires_signature" || (signing !== null && signing !== operation.id)
      }
      loading={signing === operation.id}
      aria-label={`Sign ${purposeLabel(operation.purpose).toLowerCase()} (${operation.id})`}
      onClick={async () => {
        const result = await sign(operation);
        onResult?.(result);
      }}
    >
      {children}
    </Button>
  );
}

/** The details of one owner operation, its signer and the sign button. */
export function OwnerOperationPanel({
  id,
  onSigned,
}: {
  id: string;
  onSigned?: (op: OwnerOperation) => void;
}) {
  const { chain } = useConsoleConfig();
  const owner = useOwnerKey();
  const { ready, reason } = useOwnerReady();
  const { sign, signing } = useSignOwnerOperation();
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const op = useApi(
    "getOwnerOperation",
    { params: { id } },
    { refreshInterval: (data) => (data?.status === "submitted" ? 4000 : 0) },
  );

  async function run() {
    if (!op.data) return;
    setProblem(null);
    setWalletError(null);
    const result = await sign(op.data);
    if (result.ok) {
      void op.mutate(result.operation, { revalidate: true });
      onSigned?.(result.operation);
    } else {
      setProblem(result.problem);
      setWalletError(result.walletError);
    }
  }

  if (op.error) return <ProblemAlert problem={op.error} onRetry={() => void op.mutate()} />;
  if (!op.data) return <LoadingState label="Loading owner operation" rows={2} className="px-0 py-0" />;
  const o = op.data;
  return (
    <div className="space-y-4">
      <p className="text-sm">{purposeLabel(o.purpose)}</p>
      <DescriptionList
        items={[
          { term: "Status", detail: <StatusBadge status={o.status} /> },
          { term: "Operation", detail: <IdValue value={o.id} /> },
          { term: "Account", detail: <IdValue value={o.account_id} /> },
          { term: "Applies to", detail: <code className="font-mono text-xs break-all">{o.subject_id}</code> },
          { term: "Chain", detail: chainLabel(o.chain_id) },
          {
            term: "User operation hash",
            detail: <HexValue value={o.user_op_hash} kind="hash" full label="user operation hash" />,
          },
          {
            term: o.status === "requires_signature" ? "Expires" : "Transaction",
            detail:
              o.status === "requires_signature" ? (
                <Countdown to={o.expires_at} />
              ) : (
                <HexValue value={o.tx_hash} kind="tx" chain={o.chain_id ?? chain} />
              ),
          },
        ]}
      />
      {o.status === "requires_signature" ? (
        <>
          <OwnerSignerPanel />
          {!ready && reason && owner.signer ? <Callout tone="warn">{reason}</Callout> : null}
          {walletError ? (
            <Callout tone="danger" title="Not signed">
              {walletError}
            </Callout>
          ) : null}
          {problem ? <ProblemAlert problem={problem} /> : null}
          <Button
            variant="owner"
            icon={<IconKey size={16} />}
            disabled={!ready}
            loading={signing === o.id}
            onClick={() => void run()}
          >
            Sign hash with owner key
          </Button>
        </>
      ) : o.status === "submitted" ? (
        <Callout tone="info">Submitted to the bundler; waiting for the chain to include it.</Callout>
      ) : o.status === "succeeded" ? (
        <Callout tone="success">Confirmed on-chain.</Callout>
      ) : (
        <Callout tone="danger">
          This operation {o.status === "expired" ? "expired before it was signed" : "failed"}. Start the
          action again to prepare a new one.
        </Callout>
      )}
    </div>
  );
}

/**
 * An owner operation as a card. The owner signs `user_op_hash` (EIP-191);
 * Agent Bank submits it and cannot sign it itself.
 */
export function OwnerOperationCard({ id, title = "Owner signature needed" }: { id: string; title?: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        <OwnerOperationPanel id={id} />
      </CardBody>
    </Card>
  );
}

/** The same panel in a dialog, e.g. right after an action prepared an operation. */
export function OwnerOperationDialog({
  id,
  open,
  onClose,
  title = "Sign with the owner key",
  description,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
}) {
  return (
    <Dialog
      open={open && id !== null}
      onClose={onClose}
      title={title}
      description={description}
      tone="owner"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {id ? <OwnerOperationPanel id={id} /> : null}
    </Dialog>
  );
}

/**
 * "Sign…" for an operation id carried by a resource (`install_operation_id`,
 * `pending_operation_id`, …). Shown only while the operation waits for the
 * owner key; the dialog stays open after signing to show the result.
 */
export function PendingOperationButton({
  operationId,
  title,
  label = "Sign…",
}: {
  operationId: string | null | undefined;
  title: string;
  label?: string;
}) {
  const inbox = useOwnerInbox();
  const [open, setOpen] = useState(false);
  const waiting = operationId ? inbox.byId.get(operationId) : undefined;
  if (!operationId || (!waiting && !open)) return null;
  return (
    <>
      {waiting ? (
        <Button size="sm" variant="owner" icon={<IconKey size={14} />} onClick={() => setOpen(true)}>
          {label}
        </Button>
      ) : null}
      <OwnerOperationDialog id={operationId} open={open} onClose={() => setOpen(false)} title={title} />
    </>
  );
}
