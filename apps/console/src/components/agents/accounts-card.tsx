"use client";

import { useState } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { IconPlus, IconTreasury } from "@/components/ui/icons";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Amount, DateTimeValue, HexValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import type { Account, Agent } from "@/lib/api/queries";
import { chainLabel } from "@/lib/chains";

/** Balances by ledger pocket. Pockets are ledger-only sub-balances of one smart account. */
export function BalancesView({ accountId }: { accountId: string }) {
  const balances = useApi("getBalances", { params: { id: accountId } }, { refreshInterval: 30_000 });
  if (balances.error) return <ProblemAlert problem={balances.error} onRetry={() => void balances.mutate()} />;
  if (!balances.data) return <LoadingState label="Loading balances" rows={2} className="px-0 py-0" />;
  const b = balances.data;
  const pocket = (value: string) => <Amount value={value} asset={b.asset} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular">
          <Amount value={b.total} asset={b.asset} />
        </span>
        <span className="text-xs text-muted">
          total as of <DateTimeValue value={b.as_of} />
        </span>
      </div>
      <DescriptionList
        columns={3}
        items={[
          { term: "Available", detail: pocket(b.available) },
          { term: "Reserved for pending payments", detail: pocket(b.reserved) },
          { term: "Locked in escrow", detail: pocket(b.escrow) },
          { term: "Savings and vaults", detail: pocket(b.savings) },
          { term: "x402 spend-key float", detail: pocket(b.spend_float) },
          { term: "Fees owed", detail: pocket(b.fees) },
        ]}
      />
      {b.vaults.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Vaults</p>
          <ul className="mt-1 space-y-1 text-sm">
            {b.vaults.map((v) => (
              <li key={v.vault_id} className="flex justify-between gap-3">
                <span>{v.name}</span>
                <Amount value={v.balance} asset={b.asset} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function AccountDetails({ account }: { account: Account }) {
  const versions = Object.entries(account.module_versions);
  return (
    <DescriptionList
      items={[
        { term: "Chain", detail: chainLabel(account.chain) },
        {
          term: "Smart account",
          detail: (
            <div className="space-y-1">
              <HexValue value={account.address} chain={account.chain} label="account address" />
              <div>
                {account.deployed ? (
                  <Badge tone="teal">Deployed</Badge>
                ) : (
                  <Badge tone="neutral">Counterfactual: receives funds before deployment</Badge>
                )}
              </div>
            </div>
          ),
        },
        {
          term: "Owner key",
          detail: <HexValue value={account.owner_address} chain={account.chain} label="owner address" />,
        },
        {
          term: "x402 spend key",
          detail: account.spend_key_address ? (
            <HexValue value={account.spend_key_address} chain={account.chain} label="spend key address" />
          ) : (
            <span className="text-muted">None</span>
          ),
        },
        {
          term: "Modules",
          detail:
            versions.length === 0 ? (
              <span className="text-muted">—</span>
            ) : (
              <ul className="space-y-0.5">
                {versions.map(([name, version]) => (
                  <li key={name} className="font-mono text-xs">
                    {name} <span className="text-muted">{version}</span>
                  </li>
                ))}
              </ul>
            ),
        },
        { term: "Created", detail: <DateTimeValue value={account.created_at} /> },
      ]}
    />
  );
}

export function AccountsCard({
  agent,
  accounts,
  loading,
}: {
  agent: Agent;
  accounts: Account[];
  loading: boolean;
}) {
  const { chain } = useConsoleConfig();
  const toast = useToast();
  const [key, rotate] = useIdempotencyKey();
  const [creating, setCreating] = useState(false);
  const create = useMutation(
    () => apiFetch("createAccount", { params: { id: agent.id }, body: { chain }, idempotencyKey: key }),
    { invalidates: ["listAccounts", "getAccount"] },
  );

  async function createAccount() {
    setCreating(true);
    const result = await create.run();
    setCreating(false);
    if (result.ok) {
      rotate();
      toast({
        title: "Smart account created",
        description: "It can receive funds before its first operation deploys it.",
      });
    }
  }

  return (
    <Card aria-labelledby="accounts-title">
      <CardHeader
        id="accounts-title"
        title="Smart accounts"
        description="One ERC-7579 Safe per agent per chain. Only the account itself can move money."
        actions={
          accounts.length === 0 ? null : (
            <Badge tone="neutral">
              {accounts.length} account{accounts.length === 1 ? "" : "s"}
            </Badge>
          )
        }
      />
      <CardBody className="space-y-6">
        {create.error ? <ProblemAlert problem={create.error} /> : null}
        {loading ? (
          <LoadingState label="Loading accounts" rows={3} className="px-0 py-0" />
        ) : accounts.length === 0 ? (
          <EmptyState
            icon={<IconTreasury size={20} />}
            title="No smart account yet"
            description={`Create the agent's account on ${chainLabel(chain)}. The address is counterfactual (CREATE2), so you can fund it right away.`}
            action={
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                loading={creating}
                onClick={() => void createAccount()}
              >
                Create smart account
              </Button>
            }
          />
        ) : (
          accounts.map((account) => (
            <div key={account.id} className="space-y-4 border-b border-line pb-6 last:border-b-0 last:pb-0">
              <AccountDetails account={account} />
              <BalancesView accountId={account.id} />
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}
