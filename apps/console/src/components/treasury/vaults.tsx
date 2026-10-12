"use client";

import type { ResponseOf } from "@agentbank/core/api";
import { useState, type FormEvent } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { IconLock, IconPlus } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, MoneyValue } from "@/components/ui/values";
import { apiFetch, useApiList, useIdempotencyKey, useInvalidate, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { accountLabel, useAccountsIndex, useAgentsIndex } from "@/lib/api/queries";
import { amountError, formatBps, ratioBps, toMinor } from "@/lib/money";
import { ownerPayloads } from "@/lib/owner/authorize";

type Vault = ResponseOf<"getVault">;

function CreateVaultDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    { invalidates: ["listVaults", "getBalances"] },
  );
  const targetError = target ? amountError(target) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await create.run();
    if (result.ok) {
      rotate();
      toast({ title: `Vault "${result.data.name}" created` });
      onClose();
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
  const [amount, setAmount] = useState("");
  const [key, rotate] = useIdempotencyKey();
  const [needsOwner, setNeedsOwner] = useState(
    direction === "withdraw" &&
      vault.kind === "locked" &&
      (!vault.unlock_at || new Date(vault.unlock_at) > new Date()),
  );
  const money = { amount, asset: "USDC" as const };
  const error = amount ? amountError(amount) : null;
  const transfer = useMutation(
    () =>
      apiFetch(direction === "deposit" ? "depositVault" : "withdrawVault", {
        params: { id: vault.id },
        body: { amount: money },
        idempotencyKey: key,
      }),
    { invalidates: ["listVaults", "getVault", "getBalances"] },
  );

  function done() {
    rotate();
    void invalidate("listVaults", "getBalances");
    toast({ title: direction === "deposit" ? "Deposit recorded" : "Withdrawal requested" });
    onClose();
  }

  if (needsOwner) {
    return (
      <OwnerActionDialog
        open
        onClose={onClose}
        title={`Withdraw early from ${vault.name}`}
        description="The vault is still locked, so only the owner key can release funds back to its account."
        request={amount && !error ? ownerPayloads.vaultWithdraw(vault.id, money) : null}
        submitLabel="Sign and withdraw"
        onSubmit={async (authorization) => {
          try {
            await apiFetch("withdrawVault", {
              params: { id: vault.id },
              body: { amount: money, owner_authorization: authorization },
              idempotencyKey: key,
            });
            done();
            return { ok: true };
          } catch (e) {
            return { ok: false, problem: ApiProblem.from(e) };
          }
        }}
      >
        <TextField
          label="Amount (USDC)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={error}
        />
      </OwnerActionDialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={direction === "deposit" ? `Deposit into ${vault.name}` : `Withdraw from ${vault.name}`}
      description={
        direction === "deposit"
          ? "Moves funds from the account's available balance into the vault."
          : "Moves funds from the vault back to its account."
      }
      dismissible={!transfer.pending}
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await transfer.run();
          if (result.ok) done();
          else if (result.problem.code === "owner_signature_required") setNeedsOwner(true);
        }}
      >
        <TextField
          label="Amount (USDC)"
          inputMode="decimal"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={error}
        />
        {transfer.error ? <ProblemAlert problem={transfer.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={transfer.pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={transfer.pending}
            disabled={!amount || Boolean(error)}
          >
            {direction === "deposit" ? "Deposit" : "Withdraw"}
          </Button>
        </div>
      </form>
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
      {creating ? <CreateVaultDialog open={creating} onClose={() => setCreating(false)} /> : null}
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
