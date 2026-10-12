"use client";

import type { Hex } from "viem";
import { useState } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Countdown } from "@/components/ui/countdown";
import { IconKey } from "@/components/ui/icons";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { HexValue, IdValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { chainLabel } from "@/lib/chains";
import { OwnerKeyError } from "@/lib/owner/signer";
import { useOwnerKey } from "./owner-key-provider";
import { OwnerSignerPanel, useOwnerReady } from "./owner-signer-panel";

export const OWNER_OPERATION_PURPOSES: Record<string, string> = {
  "session.install": "Install a session key on-chain (Smart Sessions)",
  "session.revoke": "Revoke a session key on-chain",
  "topup.configure": "Install the auto top-up executor on the treasury",
  "sweep.configure": "Install the treasury sweep executor",
  "vault.withdraw": "Withdraw early from a locked vault",
  payment: "A payment the policy requires the owner to sign",
  "account.deploy": "Deploy the smart account",
};

/**
 * An owner operation: an on-chain operation only the owner key can
 * authorize. The owner signs `user_op_hash` (EIP-191); Agent Bank submits it
 * and cannot sign it itself.
 */
export function OwnerOperationCard({ id, title = "Owner signature needed" }: { id: string; title?: string }) {
  const { chain } = useConsoleConfig();
  const owner = useOwnerKey();
  const { ready, reason } = useOwnerReady();
  const [idempotencyKey, rotateKey] = useIdempotencyKey();
  const [walletError, setWalletError] = useState<string | null>(null);
  const op = useApi(
    "getOwnerOperation",
    { params: { id } },
    {
      refreshInterval: (data) => (data?.status === "submitted" ? 4000 : 0),
    },
  );
  const submit = useMutation(
    async (signature: Hex) =>
      apiFetch("submitOwnerSignature", { params: { id }, body: { signature }, idempotencyKey }),
    { invalidates: ["getOwnerOperation", "getSession", "getPayment", "listPayments"] },
  );

  async function sign() {
    if (!owner.signer || !op.data) return;
    setWalletError(null);
    let signature: Hex;
    try {
      signature = await owner.signer.signHash(op.data.user_op_hash as Hex);
    } catch (error) {
      setWalletError(error instanceof OwnerKeyError || error instanceof Error ? error.message : "Not signed");
      return;
    }
    const result = await submit.run(signature);
    if (result.ok) {
      rotateKey();
      void op.mutate();
    }
  }

  return (
    <Card>
      <CardHeader
        title={title}
        description={op.data ? (OWNER_OPERATION_PURPOSES[op.data.purpose] ?? op.data.purpose) : undefined}
        actions={op.data ? <StatusBadge status={op.data.status} /> : null}
      />
      <CardBody>
        {op.error ? (
          <ProblemAlert problem={op.error} onRetry={() => void op.mutate()} />
        ) : !op.data ? (
          <LoadingState label="Loading owner operation" rows={2} className="px-0 py-0" />
        ) : (
          <div className="space-y-4">
            <DescriptionList
              items={[
                { term: "Operation", detail: <IdValue value={op.data.id} /> },
                { term: "Account", detail: <IdValue value={op.data.account_id} /> },
                {
                  term: "Applies to",
                  detail: <code className="font-mono text-xs">{op.data.subject_id}</code>,
                },
                { term: "Chain", detail: chainLabel(op.data.chain_id) },
                {
                  term: "User operation hash",
                  detail: (
                    <HexValue value={op.data.user_op_hash} kind="hash" full label="user operation hash" />
                  ),
                },
                {
                  term: op.data.status === "requires_signature" ? "Expires" : "Transaction",
                  detail:
                    op.data.status === "requires_signature" ? (
                      <Countdown to={op.data.expires_at} />
                    ) : (
                      <HexValue value={op.data.tx_hash} kind="tx" chain={op.data.chain_id ?? chain} />
                    ),
                },
              ]}
            />
            {op.data.status === "requires_signature" ? (
              <>
                <OwnerSignerPanel />
                {!ready && reason && owner.signer ? <Callout tone="warn">{reason}</Callout> : null}
                {walletError ? (
                  <Callout tone="danger" title="Not signed">
                    {walletError}
                  </Callout>
                ) : null}
                {submit.error ? <ProblemAlert problem={submit.error} /> : null}
                <Button
                  variant="owner"
                  icon={<IconKey size={16} />}
                  disabled={!ready}
                  loading={submit.pending}
                  onClick={() => void sign()}
                >
                  Sign hash with owner key
                </Button>
              </>
            ) : op.data.status === "submitted" ? (
              <Callout tone="info">Submitted to the bundler; waiting for the chain to include it.</Callout>
            ) : op.data.status === "succeeded" ? (
              <Callout tone="success">Confirmed on-chain.</Callout>
            ) : (
              <Callout tone="danger">
                This operation {op.data.status === "expired" ? "expired before it was signed" : "failed"}.
                Start the action again to prepare a new one.
              </Callout>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
