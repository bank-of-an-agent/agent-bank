"use client";

import { useState, type FormEvent } from "react";
import {
  OwnerOperationDialog,
  OwnerOperationPanel,
  PendingOperationButton,
} from "@/components/owner/owner-operation";
import { useOwnerKey } from "@/components/owner/owner-key-provider";
import { OwnerSignerPanel, useOwnerReady } from "@/components/owner/owner-signer-panel";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Countdown } from "@/components/ui/countdown";
import { IconKey, IconLock, IconPlus } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, HexValue, MoneyValue } from "@/components/ui/values";
import { newIdempotencyKey } from "@/lib/api/client";
import { apiFetch, useApiList, useIdempotencyKey, useInvalidate, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { accountLabel, useAccountsIndex, useAgentsIndex, type Vault } from "@/lib/api/queries";
import { amountError, formatBps, ratioBps, toMinor } from "@/lib/money";
import { OwnerKeyError } from "@/lib/owner/signer";
import { earlyWithdrawalTypedData, type EarlyWithdrawalTypedData } from "@/lib/owner/vault-withdrawal";

function CreateVaultDialog({
  open,
  onClose,
  onOperation,
}: {
  open: boolean;
  onClose: () => void;
  onOperation: (id: string) => void;
}) {
  const accounts = useAccountsIndex();
  const agents = useAgentsIndex();
  const toast = useToast();
  const [accountId, setAccountId] = useState("");
  const [kind, setKind] = useState<"goal" | "locked">("goal");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [unlockAt, setUnlockAt] = useState("");
  const [key, rotate] = useIdempotencyKey();
  const chosen = accountId || accounts.accounts[0]?.id || "";
  const unlockIso = unlockAt ? new Date(unlockAt).toISOString() : "";
  const create = useMutation(
    () =>
      apiFetch("createVault", {
        body: {
          account_id: chosen,
          kind,
          name: name.trim(),
          ...(target ? { target: { amount: target, asset: "USDC" as const } } : {}),
          ...(kind === "locked" && unlockIso ? { unlock_at: unlockIso } : {}),
        },
        idempotencyKey: key,
      }),
    { invalidates: ["listVaults", "getBalances", "listOwnerOperations"] },
  );
  const targetError = target ? amountError(target) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await create.run();
    if (result.ok) {
      rotate();
      const operation = result.data.pending_operation_id;
      toast({
        title: `Vault "${result.data.name}" created`,
        description: operation ? "Sign the owner operation that creates it on-chain." : undefined,
      });
      onClose();
      if (operation) onOperation(operation);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a vault"
      description="Goal vaults are ledger pockets agents cannot spend from. Locked vaults hold funds in the TimeLockVaults contract until the unlock date."
      dismissible={!create.pending}
    >
      <form onSubmit={submit} className="space-y-4">
        <SelectField label="Account" value={chosen} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(a, agents.byId)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "goal" | "locked")}>
          <option value="goal">Goal vault (ledger only)</option>
          <option value="locked">Locked vault (on-chain, time lock)</option>
        </SelectField>
        <TextField
          label="Name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Target (USDC)"
          inputMode="decimal"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          hint="Optional"
          error={targetError}
        />
        {kind === "locked" ? (
          <TextField
            label="Unlock at"
            type="datetime-local"
            required
            value={unlockAt}
            onChange={(e) => setUnlockAt(e.target.value)}
            hint="Before this, only the owner key can withdraw."
          />
        ) : null}
        {create.error ? <ProblemAlert problem={create.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.pending}
            disabled={!chosen || !name.trim() || Boolean(targetError) || (kind === "locked" && !unlockAt)}
          >
            Create vault
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Step =
  | { kind: "amount" }
  | { kind: "early"; typedData: EarlyWithdrawalTypedData }
  | { kind: "operation"; id: string };

/**
 * Deposit or withdraw. A locked vault's early withdrawal takes two owner
 * signatures: TimeLockVaults' EIP-712 `EarlyWithdrawal`, then the owner
 * operation that carries it on-chain. Deposits into locked vaults are owner
 * operations too.
 */
function TransferDialog({
  vault,
  direction,
  onClose,
}: {
  vault: Vault;
  direction: "deposit" | "withdraw";
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const owner = useOwnerKey();
  const { ready, reason } = useOwnerReady();
  const { chainId } = useConsoleConfig();
  const [amount, setAmount] = useState("");
  const [key, rotate] = useIdempotencyKey();
  const [step, setStep] = useState<Step>({ kind: "amount" });
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const money = { amount, asset: "USDC" as const };
  const error = amount ? amountError(amount) : null;

  function finished(next: Vault, title: string) {
    rotate();
    void invalidate("listVaults", "getVault", "getBalances", "listOwnerOperations");
    if (next.pending_operation_id) {
      setStep({ kind: "operation", id: next.pending_operation_id });
      return;
    }
    toast({ title });
    onClose();
  }

  async function submitAmount(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const next = await apiFetch(direction === "deposit" ? "depositVault" : "withdrawVault", {
        params: { id: vault.id },
        body: { amount: money },
        idempotencyKey: key,
      });
      finished(next, direction === "deposit" ? "Deposit recorded" : "Withdrawal recorded");
    } catch (e) {
      const p = ApiProblem.from(e);
      if (direction === "withdraw" && p.code === "owner_signature_required" && p.extensions.typed_data) {
        const checked = earlyWithdrawalTypedData(p.extensions.typed_data, {
          chainId,
          contract: vault.contract_address,
          onchainId: vault.onchain_id,
          amountMinor: toMinor(amount),
          now: Math.floor(Date.now() / 1000),
        });
        if (checked.ok) setStep({ kind: "early", typedData: checked.typedData });
        else setWalletError(`Not signing: ${checked.reason}`);
      } else {
        setProblem(p);
      }
    }
    setBusy(false);
  }

  async function signEarly(typedData: EarlyWithdrawalTypedData) {
    if (!owner.signer) return;
    setBusy(true);
    setProblem(null);
    setWalletError(null);
    try {
      const signature = await owner.signer.signTypedData(typedData);
      const next = await apiFetch("withdrawVault", {
        params: { id: vault.id },
        body: {
          amount: money,
          owner_authorization: {
            signer: owner.signer.address,
            signature,
            issued_at: Math.floor(Date.now() / 1000),
            expires_at: Number(typedData.message.deadline),
          },
        },
        idempotencyKey: newIdempotencyKey(),
      });
      finished(next, "Early withdrawal requested");
    } catch (e) {
      if (e instanceof OwnerKeyError) setWalletError(e.message);
      else setProblem(ApiProblem.from(e));
    }
    setBusy(false);
  }

  const title =
    step.kind === "operation"
      ? "Sign the vault operation"
      : step.kind === "early"
        ? `Withdraw early from ${vault.name}`
        : direction === "deposit"
          ? `Deposit into ${vault.name}`
          : `Withdraw from ${vault.name}`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      tone={step.kind === "amount" ? "default" : "owner"}
      description={
        step.kind === "operation"
          ? "The vault contract moves the funds once the owner key signs this operation."
          : step.kind === "early"
            ? "The vault is still locked, so only the owner key can release funds back to its account."
            : direction === "deposit"
              ? "Moves funds from the account's available balance into the vault."
              : "Moves funds from the vault back to its account."
      }
      dismissible={!busy}
    >
      {step.kind === "operation" ? (
        <OwnerOperationPanel id={step.id} />
      ) : step.kind === "early" ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-subtle px-4 py-3 text-sm">
            <p className="font-medium">You are signing a TimeLockVaults early withdrawal</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">Amount</dt>
              <dd>
                <MoneyValue money={money} />
              </dd>
              <dt className="text-muted">Vault</dt>
              <dd>
                {vault.name} <span className="text-xs text-muted">(on-chain #{vault.onchain_id})</span>
              </dd>
              <dt className="text-muted">Contract</dt>
              <dd>
                <HexValue
                  value={step.typedData.domain.verifyingContract}
                  chain={chainId}
                  label="vault contract"
                />
              </dd>
              <dt className="text-muted">Signature valid until</dt>
              <dd>
                <Countdown to={new Date(Number(step.typedData.message.deadline) * 1000).toISOString()} />
              </dd>
            </dl>
          </div>
          <OwnerSignerPanel />
          {!ready && reason && owner.signer ? <Callout tone="warn">{reason}</Callout> : null}
          {walletError ? (
            <Callout tone="danger" title="Not signed">
              {walletError}
            </Callout>
          ) : null}
          {problem ? <ProblemAlert problem={problem} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="owner"
              icon={<IconKey size={16} />}
              loading={busy}
              disabled={!ready}
              onClick={() => void signEarly(step.typedData)}
            >
              Sign early withdrawal
            </Button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submitAmount}>
          <TextField
            label="Amount (USDC)"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={error}
          />
          {walletError ? (
            <Callout tone="danger" title="Not signed">
              {walletError}
            </Callout>
          ) : null}
          {problem ? <ProblemAlert problem={problem} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!amount || Boolean(error)}>
              {direction === "deposit" ? "Deposit" : "Withdraw"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function progress(vault: Vault): string | null {
  if (!vault.target) return null;
  const bps = ratioBps(toMinor(vault.balance.amount), toMinor(vault.target.amount));
  return bps === null ? null : formatBps(bps, 0);
}

export function VaultsCard() {
  const list = useApiList("listVaults", { query: { limit: 50 } });
  const accounts = useAccountsIndex();
  const agents = useAgentsIndex();
  const [creating, setCreating] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<{ vault: Vault; direction: "deposit" | "withdraw" } | null>(null);

  return (
    <Card aria-labelledby="vaults-title">
      <CardHeader
        id="vaults-title"
        title="Vaults"
        description="Savings without yield: agents can deposit but cannot withdraw early."
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={14} />}
            onClick={() => setCreating(true)}
            disabled={accounts.accounts.length === 0}
          >
            New vault
          </Button>
        }
      />
      {list.error ? (
        <div className="p-4">
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </div>
      ) : list.isLoading ? (
        <LoadingState label="Loading vaults" rows={3} />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon={<IconLock size={20} />}
          title="No vaults yet"
          description={
            accounts.accounts.length === 0
              ? "Create a treasury or agent account first."
              : "Set money aside for a goal or lock it until a date."
          }
        />
      ) : (
        <Table caption="Vaults">
          <THead>
            <tr>
              <Th>Vault</Th>
              <Th>Account</Th>
              <Th align="right">Balance</Th>
              <Th>Target</Th>
              <Th>Unlocks</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {list.items.map((vault) => {
              const pct = progress(vault);
              return (
                <Tr key={vault.id}>
                  <Td>
                    <p className="font-medium">{vault.name}</p>
                    <Badge tone={vault.kind === "locked" ? "violet" : "neutral"}>
                      {vault.kind === "locked" ? "Locked" : "Goal"}
                    </Badge>
                  </Td>
                  <Td>{accountLabel(accounts.byId.get(vault.account_id), agents.byId)}</Td>
                  <Td align="right">
                    <MoneyValue money={vault.balance} />
                  </Td>
                  <Td>
                    {vault.target ? (
                      <span className="flex flex-col gap-1">
                        <MoneyValue money={vault.target} />
                        {pct ? <span className="text-xs text-muted">{pct} reached</span> : null}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="text-muted">
                    {vault.unlock_at ? <DateTimeValue value={vault.unlock_at} /> : "—"}
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-2">
                      <PendingOperationButton
                        operationId={vault.pending_operation_id}
                        title={`Sign the operation for ${vault.name}`}
                      />
                      <Button size="sm" onClick={() => setTransfer({ vault, direction: "deposit" })}>
                        Deposit
                      </Button>
                      <Button
                        size="sm"
                        variant={vault.kind === "locked" ? "owner" : "secondary"}
                        onClick={() => setTransfer({ vault, direction: "withdraw" })}
                      >
                        Withdraw
                      </Button>
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {creating ? (
        <CreateVaultDialog open={creating} onClose={() => setCreating(false)} onOperation={setOperationId} />
      ) : null}
      <OwnerOperationDialog
        id={operationId}
        open={operationId !== null}
        onClose={() => setOperationId(null)}
        title="Create the vault on-chain"
        description="Locked vaults live in the TimeLockVaults contract; the owner key creates them."
      />
      {transfer ? (
        <TransferDialog
          vault={transfer.vault}
          direction={transfer.direction}
          onClose={() => setTransfer(null)}
        />
      ) : null}
    </Card>
  );
}
