"use client";

import { useState } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { OwnerOperationCard } from "@/components/owner/owner-operation";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/field";
import { IconLock } from "@/components/ui/icons";
import { DescriptionList } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { MoneyValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import type { ResponseOf } from "@agentbank/core/api";
import { amountError, formatBps } from "@/lib/money";
import { ownerPayloads } from "@/lib/owner/authorize";

type SweepRule = ResponseOf<"putSweepRule">;

/** The counsel gate: the treasury sweep stays off until counsel signs off on broker and adviser questions. */
function CounselGate({ detail }: { detail?: string }) {
  return (
    <Callout tone="warn" icon={<IconLock size={16} />} title="Requires counsel sign-off">
      <p>
        The owner-directed treasury sweep (excess into a tokenized Treasury fund you choose, 0.15% a year) is
        disabled on this deployment until crypto counsel signs off on broker-dealer and investment-adviser
        questions. Until then savings stay in the treasury and vaults, with no yield.
      </p>
      {detail ? <p className="mt-1 text-xs text-muted">{detail}</p> : null}
    </Callout>
  );
}

function ConfigureSweep({
  accountId,
  funds,
  onConfigured,
}: {
  accountId: string;
  funds: ResponseOf<"listFunds">["data"];
  onConfigured: (rule: SweepRule) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [fundId, setFundId] = useState(funds[0]?.id ?? "");
  const [floor, setFloor] = useState("");
  const [threshold, setThreshold] = useState("1000.00");
  const [maxSharePct, setMaxSharePct] = useState("50");
  const [key, rotate] = useIdempotencyKey();
  const shareValid = /^(100|[1-9]?[0-9])$/.test(maxSharePct);
  const errors = {
    floor: floor ? amountError(floor, { allowZero: true }) : null,
    threshold: amountError(threshold),
    share: shareValid ? null : "A whole percentage from 0 to 100",
  };
  const valid = Boolean(fundId) && !Object.values(errors).some(Boolean);
  const body = {
    fund_id: fundId,
    ...(floor ? { floor: { amount: floor, asset: "USDC" as const } } : {}),
    threshold: { amount: threshold, asset: "USDC" as const },
    max_share_bps: shareValid ? Number(maxSharePct) * 100 : 0,
  };
  const fund = funds.find((f) => f.id === fundId);

  return (
    <>
      <Button variant="owner" onClick={() => setOpen(true)} disabled={funds.length === 0}>
        Configure sweep…
      </Button>
      <OwnerActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Configure the treasury sweep"
        description="Keep a liquid floor in the treasury and sweep the excess into the fund you choose; redemptions start automatically below the floor. Fund shares stay in your treasury account."
        request={valid ? ownerPayloads.sweepSet(accountId, body) : null}
        submitLabel="Sign and save rule"
        onSubmit={async (authorization) => {
          try {
            const rule = await apiFetch("putSweepRule", {
              params: { id: accountId },
              body: { ...body, owner_authorization: authorization },
              idempotencyKey: key,
            });
            rotate();
            onConfigured(rule);
            toast({
              title: "Sweep rule saved",
              description: "Install the sweep executor with the owner key to activate it.",
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, problem: ApiProblem.from(error) };
          }
        }}
      >
        <div className="space-y-4">
          <SelectField label="Fund" value={fundId} onChange={(e) => setFundId(e.target.value)}>
            {funds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </SelectField>
          {fund ? <p className="text-xs text-muted">{fund.disclosure}</p> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TextField
              label="Liquid floor (USDC)"
              inputMode="decimal"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              hint="Default: two days of trailing seven-day spend"
              error={errors.floor}
            />
            <TextField
              label="Sweep above (USDC)"
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              error={errors.threshold}
            />
            <TextField
              label="Max share in savings (%)"
              inputMode="numeric"
              value={maxSharePct}
              onChange={(e) => setMaxSharePct(e.target.value)}
              error={errors.share}
            />
          </div>
        </div>
      </OwnerActionDialog>
    </>
  );
}

export function TreasurySweepCard() {
  const { features } = useConsoleConfig();
  const org = useApi("getCurrentOrg");
  const enabled = features.treasury_sweep === true;
  const funds = useApi(enabled ? "listFunds" : null);
  const [rule, setRule] = useState<SweepRule | null>(null);
  const treasuryId = org.data?.treasury_account_id ?? null;
  const gated = !enabled || funds.error?.code === "feature_gated";

  return (
    <Card aria-labelledby="sweep-title">
      <CardHeader
        id="sweep-title"
        title="Treasury sweep"
        description="Owner-directed yield from a fund you pick from a neutral eligibility list. Agent Bank makes no recommendation and never pays yield itself."
        actions={gated ? <Badge tone="warn">Gated</Badge> : null}
      />
      <CardBody className="space-y-4">
        {gated ? (
          <CounselGate detail={funds.error?.code === "feature_gated" ? funds.error.detail : undefined} />
        ) : funds.error ? (
          <ProblemAlert problem={funds.error} onRetry={() => void funds.mutate()} />
        ) : funds.isLoading ? (
          <LoadingState label="Loading eligible funds" rows={2} className="px-0 py-0" />
        ) : (
          <>
            <ul className="space-y-3" aria-label="Eligible funds">
              {(funds.data?.data ?? []).map((f) => (
                <li key={f.id} className="rounded-lg border border-line px-4 py-3 text-sm">
                  <p className="font-medium">{f.name}</p>
                  <p className="text-xs text-muted">
                    {f.issuer} · settles {f.settlement.replace("_", " ")} · minimum{" "}
                    <MoneyValue money={f.eligibility.minimum} /> · {f.eligibility.investor_types.join(", ")} ·{" "}
                    {f.eligibility.jurisdictions}
                  </p>
                  <p className="mt-1 text-xs text-muted">{f.disclosure}</p>
                </li>
              ))}
            </ul>
            {rule ? (
              <div className="space-y-3">
                <DescriptionList
                  columns={3}
                  items={[
                    { term: "Status", detail: <StatusBadge status={rule.status} /> },
                    { term: "Floor", detail: <MoneyValue money={rule.floor} /> },
                    { term: "Sweep above", detail: <MoneyValue money={rule.threshold} /> },
                    { term: "Max share", detail: formatBps(rule.max_share_bps, 0) },
                  ]}
                />
                {rule.install_operation_id ? (
                  <OwnerOperationCard id={rule.install_operation_id} title="Install the sweep executor" />
                ) : null}
              </div>
            ) : null}
            {treasuryId ? (
              <ConfigureSweep accountId={treasuryId} funds={funds.data?.data ?? []} onConfigured={setRule} />
            ) : (
              <Callout tone="info">Set an org treasury account to configure the sweep.</Callout>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
