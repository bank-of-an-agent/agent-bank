"use client";

import { useState } from "react";
import { AccountDetails, BalancesView } from "@/components/agents/accounts-card";
import { TestUsdcButton } from "@/components/agents/faucet";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { useConsoleConfig } from "@/components/providers/config";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { IconPlus, IconTreasury } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, useApi, useIdempotencyKey, useInvalidate, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { useAccountsIndex, type Account } from "@/lib/api/queries";
import { chainLabel } from "@/lib/chains";
import { ownerPayloads } from "@/lib/owner/authorize";

function SetTreasury({ orgId, account }: { orgId: string; account: Account }) {
  const [open, setOpen] = useState(false);
  const [key, rotate] = useIdempotencyKey();
  const invalidate = useInvalidate();
  const toast = useToast();
  return (
    <>
      <Button variant="owner" onClick={() => setOpen(true)}>
        Make this the org treasury…
      </Button>
      <OwnerActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Set the org treasury account"
        description="Auto top-ups and plan billing draw from the treasury, so choosing it is owner-signed."
        request={ownerPayloads.treasurySet(orgId, account.id)}
        submitLabel="Sign and set treasury"
        onSubmit={async (authorization) => {
          try {
            await apiFetch("setTreasury", {
              body: { account_id: account.id, owner_authorization: authorization },
              idempotencyKey: key,
            });
            rotate();
            void invalidate("getCurrentOrg");
            toast({ title: "Treasury account set" });
            return { ok: true };
          } catch (error) {
            return { ok: false, problem: ApiProblem.from(error) };
          }
        }}
      />
    </>
  );
}

export function TreasuryAccountCard() {
  const { chain } = useConsoleConfig();
  const org = useApi("getCurrentOrg");
  const accounts = useAccountsIndex();
  const toast = useToast();
  const [key, rotate] = useIdempotencyKey();
  const create = useMutation(
    () => apiFetch("createTreasuryAccount", { body: { chain }, idempotencyKey: key }),
    {
      invalidates: ["listAccounts"],
    },
  );

  const treasuryId = org.data?.treasury_account_id ?? null;
  const treasury = treasuryId ? accounts.byId.get(treasuryId) : undefined;
  const unassigned = accounts.treasury.find((a) => a.id !== treasuryId);
  const error = org.error ?? accounts.error;

  return (
    <Card aria-labelledby="treasury-title">
      <CardHeader
        id="treasury-title"
        title="Org treasury"
        description="The org's own smart account. Savings live here by default; agents draw only what they need."
      />
      <CardBody className="space-y-4">
        {error ? (
          <ProblemAlert problem={error} onRetry={() => void accounts.mutate()} />
        ) : org.isLoading || accounts.isLoading ? (
          <LoadingState label="Loading treasury" rows={3} className="px-0 py-0" />
        ) : treasury ? (
          <>
            <AccountDetails account={treasury} />
            <BalancesView accountId={treasury.id} />
            <TestUsdcButton account={treasury} />
          </>
        ) : treasuryId ? (
          <Callout tone="warn">
            The org treasury is <code className="font-mono text-xs">{treasuryId}</code>, which is not among
            the listed accounts.
          </Callout>
        ) : unassigned && org.data ? (
          <div className="space-y-4">
            <Callout tone="info" title="Treasury account created, not yet assigned">
              Assign it as the org treasury with the owner key.
            </Callout>
            <AccountDetails account={unassigned} />
            <SetTreasury orgId={org.data.id} account={unassigned} />
          </div>
        ) : (
          <EmptyState
            icon={<IconTreasury size={20} />}
            title="No treasury account yet"
            description={`Create the org's treasury smart account on ${chainLabel(chain)}, then assign it with the owner key.`}
            action={
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                loading={create.pending}
                onClick={async () => {
                  const result = await create.run();
                  if (result.ok) {
                    rotate();
                    toast({
                      title: "Treasury account created",
                      description: "Now assign it as the org treasury.",
                    });
                  }
                }}
              >
                Create treasury account
              </Button>
            }
          />
        )}
        {create.error ? <ProblemAlert problem={create.error} /> : null}
      </CardBody>
    </Card>
  );
}
