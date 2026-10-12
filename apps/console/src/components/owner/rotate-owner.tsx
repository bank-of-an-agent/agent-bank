"use client";

import { useState } from "react";
import useSWR from "swr";
import { getAddress, isAddress, zeroAddress } from "viem";
import { useConsoleConfig } from "@/components/providers/config";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { IconKey } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { HexValue } from "@/components/ui/values";
import { newIdempotencyKey } from "@/lib/api/client";
import { apiFetch, useApi, useIdempotencyKey, useInvalidate } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import {
  accountLabel,
  useAccountsIndex,
  useAgentsIndex,
  type Org,
  type OwnerOperation,
} from "@/lib/api/queries";
import { shortHex } from "@/lib/format";
import { ownerAuthorize, ownerPayloads } from "@/lib/owner/authorize";
import { OwnerKeyError, sameAddress } from "@/lib/owner/signer";
import { useOwnerKey } from "./owner-key-provider";
import { useSignOwnerOperation } from "./owner-operation";
import { OwnerSignerPanel, useOwnerReady } from "./owner-signer-panel";

/** Validates the new owner address; the result is checksummed so the signed payload and the body match. */
export function parseNewOwner(
  input: string,
  currentOwner: string | null | undefined,
): { address: `0x${string}` | null; error: string | null } {
  const value = input.trim();
  if (!value) return { address: null, error: null };
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { address: null, error: "Enter a 0x-prefixed address of 40 hex characters." };
  }
  if (!isAddress(value)) {
    return {
      address: null,
      error: "The checksum (capitalisation) is wrong. Check the address or paste it in lower case.",
    };
  }
  const address = getAddress(value);
  if (address === zeroAddress)
    return { address: null, error: "The zero address cannot own an organization." };
  if (sameAddress(address, currentOwner)) return { address: null, error: "That is already the owner key." };
  return { address, error: null };
}

const SETTLED = new Set(["succeeded", "failed", "expired"]);

/** The swap operations being tracked, polled while any is on its way on-chain. */
function useSwapOperations(ids: string[]) {
  const key = ids.length > 0 ? (["getOwnerOperation", `swaps:${[...ids].sort().join(",")}`] as const) : null;
  return useSWR<Map<string, OwnerOperation>, ApiProblem>(
    key,
    async () => {
      const results = await Promise.allSettled(
        ids.map((id) => apiFetch("getOwnerOperation", { params: { id } })),
      );
      const map = new Map<string, OwnerOperation>();
      for (const result of results) if (result.status === "fulfilled") map.set(result.value.id, result.value);
      return map;
    },
    {
      refreshInterval: (data) =>
        data && [...data.values()].every((op) => SETTLED.has(op.status) || op.status === "requires_signature")
          ? 0
          : 4000,
    },
  );
}

/**
 * Voluntary owner-key rotation, in the order the contracts require:
 * 1. for every account, `prepareOwnerSwap` and sign it with the current key
 *    (one owner operation swaps both the Safe owner and the owner validator);
 * 2. once every swap is confirmed, sign `owner.rotate` (`POST /v1/orgs/me/owner`)
 *    so Agent Bank and the co-signer accept only the new key.
 * A lost key cannot be rotated here: recovery goes through the guardians on-chain.
 */
function RotateOwnerWizard({ org, onClose }: { org: Org; onClose: () => void }) {
  const owner = useOwnerKey();
  const { ready, reason } = useOwnerReady();
  const { chainId } = useConsoleConfig();
  const accounts = useAccountsIndex();
  const agents = useAgentsIndex();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { sign } = useSignOwnerOperation();
  const [input, setInput] = useState("");
  const [target, setTarget] = useState<`0x${string}` | null>(null);
  const [opIds, setOpIds] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [rotateKey] = useIdempotencyKey();
  const swaps = useSwapOperations(Object.values(opIds));

  const parsed = parseNewOwner(input, org.owner_address);
  const statusOf = (accountId: string): OwnerOperation | undefined => {
    const id = opIds[accountId];
    return id ? swaps.data?.get(id) : undefined;
  };
  const swapped = (accountId: string, ownerAddress: string) =>
    target !== null && (sameAddress(ownerAddress, target) || statusOf(accountId)?.status === "succeeded");
  const pendingAccounts = accounts.accounts.filter((a) => !swapped(a.id, a.owner_address));
  const allSwapped =
    target !== null && !accounts.isLoading && !accounts.truncated && pendingAccounts.length === 0;

  async function swapAll() {
    if (!target) return;
    setRunning(true);
    setProblem(null);
    setWalletError(null);
    for (const account of pendingAccounts) {
      const tracked = statusOf(account.id);
      if (tracked && (tracked.status === "submitted" || tracked.status === "succeeded")) continue;
      let op: OwnerOperation;
      try {
        op = await apiFetch("prepareOwnerSwap", {
          params: { id: account.id },
          body: { new_owner_address: target },
          idempotencyKey: newIdempotencyKey(),
        });
      } catch (error) {
        const p = ApiProblem.from(error);
        const pendingId =
          typeof p.extensions.owner_operation_id === "string" ? p.extensions.owner_operation_id : null;
        if (p.code !== "conflict" || !pendingId) {
          setRowErrors((prev) => ({ ...prev, [account.id]: `${p.code}: ${p.detail ?? p.title}` }));
          continue;
        }
        // A swap is already pending on this account: sign that one if it is for the same key.
        try {
          op = await apiFetch("getOwnerOperation", { params: { id: pendingId } });
        } catch (inner) {
          const q = ApiProblem.from(inner);
          setRowErrors((prev) => ({ ...prev, [account.id]: `${q.code}: ${q.detail ?? q.title}` }));
          continue;
        }
        if (!sameAddress(op.subject_id, target)) {
          setRowErrors((prev) => ({
            ...prev,
            [account.id]: `A swap to ${shortHex(op.subject_id)} is already pending; wait for it to expire.`,
          }));
          continue;
        }
      }
      setOpIds((prev) => ({ ...prev, [account.id]: op.id }));
      setRowErrors(({ [account.id]: _dropped, ...rest }) => rest);
      const result = await sign(op);
      if (!result.ok) {
        // A declined wallet prompt stops the run; the owner can resume it.
        setWalletError(result.walletError);
        setProblem(result.problem);
        break;
      }
    }
    await swaps.mutate();
    void invalidate("listAccounts", "listOwnerOperations");
    setRunning(false);
  }

  async function rotate() {
    if (!target || !owner.signer) return;
    setRotating(true);
    setProblem(null);
    setWalletError(null);
    try {
      const authorization = await ownerAuthorize(
        owner.signer,
        chainId,
        ownerPayloads.ownerRotate(org.id, target),
      );
      await apiFetch("rotateOwner", {
        body: { new_owner_address: target, owner_authorization: authorization },
        idempotencyKey: rotateKey,
      });
      void invalidate("getCurrentOrg", "listAccounts");
      toast({
        title: "Owner key rotated",
        description: `Connect ${shortHex(target)} to sign owner actions from now on.`,
      });
      onClose();
    } catch (error) {
      if (error instanceof OwnerKeyError) setWalletError(error.message);
      else setProblem(ApiProblem.from(error));
    }
    setRotating(false);
  }

  if (!target) {
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.address) setTarget(parsed.address);
        }}
      >
        <TextField
          label="New owner address"
          required
          autoComplete="off"
          spellCheck={false}
          inputClassName="font-mono"
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          error={parsed.error ?? undefined}
          hint="A key you control, ideally a hardware wallet. Agent Bank never holds it."
        />
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>The current owner key signs an owner swap on every smart account.</li>
          <li>Once every swap is confirmed on-chain, it signs the hand-over of the org.</li>
          <li>From then on Agent Bank and the co-signer accept only the new key.</li>
        </ol>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!parsed.address}>
            Continue
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        New owner <HexValue value={target} label="new owner address" />{" "}
        <Button size="sm" variant="ghost" disabled={running || rotating} onClick={() => setTarget(null)}>
          Change
        </Button>
      </p>
      <section aria-labelledby="swap-step" className="space-y-3">
        <h3 id="swap-step" className="text-sm font-semibold">
          1. Swap the owner on every account
        </h3>
        {accounts.error ? (
          <ProblemAlert problem={accounts.error} onRetry={() => void accounts.mutate()} />
        ) : accounts.isLoading ? (
          <LoadingState label="Loading accounts" rows={2} className="px-0 py-0" />
        ) : accounts.accounts.length === 0 ? (
          <p className="text-sm text-muted">No smart accounts yet: nothing to swap.</p>
        ) : (
          <Table caption="Owner swaps by account" className="rounded-lg border border-line">
            <THead>
              <tr>
                <Th>Account</Th>
                <Th>Swap</Th>
              </tr>
            </THead>
            <tbody>
              {accounts.accounts.map((account) => {
                const op = statusOf(account.id);
                const error = rowErrors[account.id];
                return (
                  <Tr key={account.id}>
                    <Td>
                      <span className="flex flex-col">
                        <span className="font-medium">{accountLabel(account, agents.byId)}</span>
                        <HexValue value={account.address} chain={account.chain} label="account address" />
                      </span>
                    </Td>
                    <Td>
                      {sameAddress(account.owner_address, target) ? (
                        <StatusBadge status="succeeded" label="Swapped" />
                      ) : op ? (
                        <StatusBadge status={op.status} />
                      ) : error ? (
                        <span className="text-xs text-danger-fg">{error}</span>
                      ) : (
                        <span className="text-xs text-muted">Not started</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {accounts.truncated ? (
          <Callout tone="warn">More than 200 accounts: rotate with the SDK instead.</Callout>
        ) : null}
        {!allSwapped && accounts.accounts.length > 0 ? (
          <Button
            variant="owner"
            icon={<IconKey size={16} />}
            loading={running}
            disabled={!ready || accounts.truncated}
            onClick={() => void swapAll()}
          >
            {Object.keys(opIds).length > 0
              ? "Continue swapping"
              : `Sign swaps for ${pendingAccounts.length} account${pendingAccounts.length === 1 ? "" : "s"}`}
          </Button>
        ) : null}
        {Object.keys(opIds).length > 0 && !allSwapped ? (
          <p className="text-xs text-muted">
            Signed swaps confirm on-chain in a few blocks; this list updates itself.
          </p>
        ) : null}
      </section>
      <section aria-labelledby="rotate-step" className="space-y-3">
        <h3 id="rotate-step" className="text-sm font-semibold">
          2. Hand over the organization
        </h3>
        <p className="text-sm text-muted">
          {allSwapped
            ? "Every account is swapped. Sign owner.rotate with the current key to finish."
            : "Available once every account's swap is confirmed on-chain."}
        </p>
        <Button
          variant="owner"
          icon={<IconKey size={16} />}
          loading={rotating}
          disabled={!ready || !allSwapped || running}
          onClick={() => void rotate()}
        >
          Sign and rotate
        </Button>
      </section>
      <OwnerSignerPanel />
      {!ready && reason && owner.signer ? <Callout tone="warn">{reason}</Callout> : null}
      {walletError ? (
        <Callout tone="danger" title="Not signed">
          {walletError}
        </Callout>
      ) : null}
      {problem ? <ProblemAlert problem={problem} /> : null}
    </div>
  );
}

/**
 * Voluntary owner-key rotation, signed by the current owner key. If the
 * current key is lost, recovery goes through the guardians on-chain instead.
 */
export function RotateOwnerKey() {
  const org = useApi("getCurrentOrg");
  const [open, setOpen] = useState(false);
  if (!org.data) return null;
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div id="owner" />
      <p className="text-sm font-semibold">Rotate the owner key</p>
      <p className="text-sm text-muted">
        Hand ownership to a new key while you still hold the current one. If the current key is lost, recover
        the accounts on-chain with your guardians instead.
      </p>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Rotate owner key…
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rotate the owner key"
        description="The current owner key signs every step. Afterwards Agent Bank and the co-signer accept only the new key."
        tone="owner"
        size="lg"
      >
        {open ? <RotateOwnerWizard org={org.data} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </div>
  );
}
