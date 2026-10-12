"use client";

import { generateSpendKey, signSpendKeyPermit, type GeneratedKey } from "@agentbank/sdk";
import { useState } from "react";
import { getAddress, isAddress } from "viem";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, TextAreaField, TextField } from "@/components/ui/field";
import { IconAlert, IconDownload, IconKey } from "@/components/ui/icons";
import { Callout } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { HexValue } from "@/components/ui/values";
import { apiFetch, useIdempotencyKey, useInvalidate } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import type { Account } from "@/lib/api/queries";
import { chainLabel } from "@/lib/chains";
import { downloadText } from "@/lib/download";
import { ownerPayloads } from "@/lib/owner/authorize";
import { checkPermit, spendKeyFile, type Permit } from "@/lib/owner/spend-key";

const PERMIT: Record<Account["spend_key_permit"], { tone: Tone; label: string; detail: string }> = {
  none: {
    tone: "neutral",
    label: "No permit",
    detail: "The float-recovery permit is not attached yet.",
  },
  pending: {
    tone: "warn",
    label: "Permit pending",
    detail:
      "The float-recovery permit executes with the account's next owner operation, usually the first session install.",
  },
  executed: {
    tone: "teal",
    label: "Float recoverable",
    detail: "The permit is on-chain: the account (or your exit tool) can always sweep the float back.",
  },
};

type Check = { ok: true; permit: Permit } | { ok: false; message: string } | null;

function notReady(detail: string): ApiProblem {
  return new ApiProblem({ status: 0, code: "invalid_request", title: "Not ready to attach", detail });
}

function AttachSpendKeyDialog({
  account,
  agentName,
  open,
  onClose,
}: {
  account: Account;
  agentName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { sandbox, chainId, usdc, chain } = useConsoleConfig();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [mode, setMode] = useState<"generate" | "runtime">(sandbox ? "generate" : "runtime");
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [address, setAddress] = useState("");
  const [permitText, setPermitText] = useState("");
  const [check, setCheck] = useState<Check>(null);
  const [checking, setChecking] = useState(false);
  const [key, rotate] = useIdempotencyKey();

  const blocked = !usdc
    ? "USDC's details could not be loaded from GET /v1/meta, so a permit cannot be built. Reload to try again."
    : account.chain_id !== chainId
      ? `This account is on chain ${account.chain_id}, not this deployment's chain ${chainId}.`
      : null;
  const typed = address.trim();
  const runtimeKey = isAddress(typed, { strict: false }) ? getAddress(typed) : null;
  const spendKey = mode === "generate" ? (generated?.address ?? null) : runtimeKey;
  const ready =
    !blocked && spendKey !== null && (mode === "generate" ? downloaded && saved : check?.ok === true);

  function generate() {
    setGenerated(generateSpendKey());
    setDownloaded(false);
    setSaved(false);
  }

  function download() {
    if (!generated) return;
    const file = spendKeyFile({
      privateKey: generated.privateKey,
      address: generated.address,
      accountId: account.id,
      accountAddress: account.address,
      agentId: account.agent_id,
      agentName,
      chain,
      chainId: account.chain_id,
      createdAt: new Date(),
    });
    downloadText(file.filename, file.text);
    setDownloaded(true);
  }

  async function verify() {
    if (!usdc || !runtimeKey) return;
    setChecking(true);
    setCheck(
      await checkPermit(permitText, runtimeKey, {
        account: account.address,
        chainId: account.chain_id,
        usdc,
      }),
    );
    setChecking(false);
  }

  function close() {
    // The generated key exists only in memory: closing discards it.
    setGenerated(null);
    setDownloaded(false);
    setSaved(false);
    onClose();
  }

  return (
    <OwnerActionDialog
      open={open}
      onClose={close}
      title={`Attach an x402 spend key to ${agentName}`}
      description="The spend key holds the agent's small x402 float outside its smart account. Its permit lets the account sweep that float back at any time, and the owner key pins the key in the co-signer. It cannot be replaced later."
      request={spendKey ? ownerPayloads.spendKeySet(account.id, spendKey) : null}
      canSubmit={ready}
      submitLabel="Sign and attach"
      onSubmit={async (authorization, signed) => {
        if (!usdc || !spendKey) return { ok: false, problem: notReady("USDC's details are unavailable.") };
        const payload = signed.payload as { spend_key_address: string };
        try {
          const permit =
            mode === "generate" && generated
              ? await signSpendKeyPermit({
                  spendKey: generated.account,
                  account: account.address,
                  chainId: account.chain_id,
                  usdc: usdc.address,
                  name: usdc.name,
                  version: usdc.version,
                })
              : check?.ok
                ? check.permit
                : null;
          if (!permit) return { ok: false, problem: notReady("Verify the permit first.") };
          await apiFetch("attachSpendKey", {
            params: { id: account.id },
            body: {
              spend_key_address: payload.spend_key_address,
              permit,
              owner_authorization: authorization,
            },
            idempotencyKey: key,
          });
          rotate();
          void invalidate("listAccounts", "getAccount", "getBalances");
          toast({
            title: "Spend key attached",
            description: "The permit executes with the account's next owner operation.",
          });
          setGenerated(null);
          return { ok: true };
        } catch (error) {
          return { ok: false, problem: ApiProblem.from(error) };
        }
      }}
    >
      <div className="space-y-4">
        {blocked ? <Callout tone="warn">{blocked}</Callout> : null}
        {sandbox ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Spend key</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`spend-key-mode-${account.id}`}
                className="mt-0.5 accent-primary"
                checked={mode === "generate"}
                onChange={() => setMode("generate")}
              />
              <span>Generate a testnet key in this browser and download it once</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`spend-key-mode-${account.id}`}
                className="mt-0.5 accent-primary"
                checked={mode === "runtime"}
                onChange={() => setMode("runtime")}
              />
              <span>Use a key from the agent&apos;s runtime (paste its address and signed permit)</span>
            </label>
          </fieldset>
        ) : null}

        {mode === "generate" ? (
          <div className="space-y-3 rounded-lg border border-warn/50 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <IconAlert size={16} className="text-warn-fg" />
              Testnet only · {chainLabel(account.chain_id)}
            </p>
            <p className="text-sm text-muted">
              The key is generated and kept in this browser&apos;s memory, never sent to Agent Bank. Download
              it for the agent&apos;s runtime: closing this dialog discards it, and an attached key cannot be
              replaced.
            </p>
            {generated ? (
              <>
                <p className="text-sm">
                  Spend key{" "}
                  <HexValue value={generated.address} chain={account.chain} label="spend key address" />
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={<IconDownload size={14} />} onClick={download}>
                    {downloaded ? "Download again" : "Download key file"}
                  </Button>
                </div>
                <Checkbox
                  label="I saved the key file where the agent's runtime can load it"
                  checked={saved}
                  disabled={!downloaded}
                  onChange={(e) => setSaved(e.target.checked)}
                />
              </>
            ) : (
              <Button size="sm" icon={<IconKey size={14} />} onClick={generate} disabled={Boolean(blocked)}>
                Generate testnet spend key
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <TextField
              label="Spend key address"
              required
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setCheck(null);
              }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              inputClassName="font-mono"
              error={typed && !runtimeKey ? "An address is 0x followed by 40 hex digits" : null}
            />
            <TextAreaField
              label="Signed permit (JSON)"
              required
              rows={5}
              value={permitText}
              onChange={(e) => {
                setPermitText(e.target.value);
                setCheck(null);
              }}
              inputClassName="font-mono text-xs"
              hint={`From the agent's runtime: the SDK's signSpendKeyPermit() for spender ${account.address}.`}
              error={check && !check.ok ? check.message : null}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                loading={checking}
                disabled={!runtimeKey || !permitText.trim() || Boolean(blocked)}
                onClick={() => void verify()}
              >
                Verify permit
              </Button>
              {check?.ok ? <Badge tone="teal">Permit verified</Badge> : null}
            </div>
          </div>
        )}
      </div>
    </OwnerActionDialog>
  );
}

/** The account's x402 spend key: address, permit status and, for agent accounts without one, "Attach". */
export function SpendKeyDetail({ account, agentName }: { account: Account; agentName: string }) {
  const [open, setOpen] = useState(false);
  if (account.spend_key_address) {
    const permit = PERMIT[account.spend_key_permit];
    return (
      <div className="space-y-1">
        <HexValue value={account.spend_key_address} chain={account.chain} label="spend key address" />
        <div>
          <Badge tone={permit.tone}>{permit.label}</Badge>
        </div>
        <p className="text-xs text-muted">{permit.detail}</p>
      </div>
    );
  }
  if (account.role !== "agent")
    return <span className="text-muted">None (treasury accounts pay no x402)</span>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        None: x402 payments and float refills are refused until one is attached.
      </p>
      <Button size="sm" variant="owner" onClick={() => setOpen(true)}>
        Attach spend key…
      </Button>
      {open ? (
        <AttachSpendKeyDialog
          account={account}
          agentName={agentName}
          open={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
