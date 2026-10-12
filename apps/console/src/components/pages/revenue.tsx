"use client";

import { breakEvenRevenue, DRIVERS, STAGES, type Stage } from "@agentbank/core";
import { useMemo, useState, type ReactNode } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField } from "@/components/ui/field";
import { PageHeader, Stat, StatGrid } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useApi } from "@/lib/api/hooks";
import { cn } from "@/lib/cn";
import { formatPeriod, humanize, recentPeriods } from "@/lib/format";
import { formatBps, formatCents, formatCentsCompact, groupDigits, ratioBps } from "@/lib/money";
import {
  actuals,
  modelColumns,
  STAGE_LABELS,
  stageReached,
  STREAMS,
  type Actuals,
  type ModelColumn,
} from "@/lib/revenue";

/** Actual as a share of the model value: a bar drawn with SVG attributes (CSP-safe) plus the percentage. */
function ShareBar({ actual, model }: { actual: bigint; model: bigint }) {
  const bps = ratioBps(actual, model);
  if (bps === null) return <span className="text-xs text-muted">n/a</span>;
  const capped = bps > 10_000n ? 10_000n : bps < 0n ? 0n : bps;
  const width = `${(capped / 100n).toString()}.${(capped % 100n).toString().padStart(2, "0")}%`;
  return (
    <span className="flex items-center gap-2">
      <svg width="96" height="8" className="shrink-0" aria-hidden="true" focusable="false">
        <rect width="96" height="8" rx="4" className="fill-line" />
        <rect width={width} height="8" rx="4" className={bps >= 10_000n ? "fill-teal" : "fill-blue"} />
      </svg>
      <span className="text-xs tabular text-muted">{formatBps(bps, 0)}</span>
    </span>
  );
}

function StagePicker({ value, onChange }: { value: Stage; onChange: (stage: Stage) => void }) {
  return (
    <div
      role="group"
      aria-label="Compare with model stage"
      className="inline-flex rounded-lg border border-line bg-subtle p-0.5"
    >
      {STAGES.map((stage) => (
        <button
          key={stage}
          type="button"
          aria-pressed={value === stage}
          onClick={() => onChange(stage)}
          className={cn(
            "rounded-md px-3 py-1 text-sm font-medium",
            value === stage ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {STAGE_LABELS[stage]}
        </button>
      ))}
    </div>
  );
}

function ModelHeader({ compare }: { compare: Stage }) {
  return (
    <THead>
      <tr>
        <Th>Line</Th>
        <Th align="right">Actual</Th>
        {STAGES.map((stage) => (
          <Th key={stage} align="right">
            {STAGE_LABELS[stage]} model
          </Th>
        ))}
        <Th>vs {STAGE_LABELS[compare]}</Th>
      </tr>
    </THead>
  );
}

const MODELS = modelColumns();

function Row({
  label,
  actual,
  model,
  compare,
  format = formatCents,
  emphasis = false,
}: {
  label: ReactNode;
  actual: bigint | null;
  model: (column: ModelColumn) => bigint | null;
  compare: Stage;
  format?: (value: bigint) => string;
  emphasis?: boolean;
}) {
  const models = MODELS;
  const compareValue = model(models[compare]);
  return (
    <Tr className={emphasis ? "font-semibold" : undefined}>
      <Td>{label}</Td>
      <Td align="right">{actual === null ? "—" : format(actual)}</Td>
      {STAGES.map((stage) => {
        const value = model(models[stage]);
        return (
          <Td key={stage} align="right" className="text-muted">
            {value === null ? "—" : format(value)}
          </Td>
        );
      })}
      <Td>
        {actual !== null && compareValue !== null && compareValue > 0n ? (
          <ShareBar actual={actual} model={compareValue} />
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </Td>
    </Tr>
  );
}

const count = (value: bigint) => groupDigits(value.toString());
const margin = (bps: bigint) => formatBps(bps, 1);

const BREAK_EVEN_GROWTH = breakEvenRevenue(DRIVERS.growth);

function Dashboard({ a, compare }: { a: Actuals; compare: Stage }) {
  const models = MODELS;
  const breakEven = BREAK_EVEN_GROWTH;
  const orgsPaying = a.orgs.pro + a.orgs.business + a.orgs.enterprise;

  return (
    <div className="space-y-6">
      <StatGrid>
        <Stat
          label="Revenue"
          value={formatCents(a.totalRevenue)}
          hint={stageReached(a.totalRevenue, models)}
        />
        <Stat
          label="Gross margin"
          value={a.grossMarginBps === null ? "n/m" : margin(a.grossMarginBps)}
          hint={`Model: ${models.growth.pnl.grossMarginBps === null ? "n/m" : margin(models.growth.pnl.grossMarginBps)} at Growth`}
        />
        <Stat
          label="Volume per paying org"
          value={formatCentsCompact(a.volumePerOrg)}
          hint={`Model: ${formatCentsCompact(models[compare].volumePerOrg)} at ${STAGE_LABELS[compare]}`}
        />
        <Stat label="Paying orgs" value={count(orgsPaying)} hint={`${count(a.orgs.free)} on the free plan`} />
      </StatGrid>

      <Callout tone="info" title="Break-even">
        On the Growth cost base, break-even needs about {formatCentsCompact(breakEven)} of monthly revenue.
        This month is {formatBps(ratioBps(a.totalRevenue, breakEven), 1)} of that.
      </Callout>

      <Card aria-labelledby="streams-title">
        <CardHeader
          id="streams-title"
          title="Revenue by stream"
          description="Fees post to sys:revenue, so revenue reconciles like every other movement. Model figures are monthly planning assumptions from the design doc."
        />
        <Table caption="Revenue by stream, actual versus the business model">
          <ModelHeader compare={compare} />
          <tbody>
            {STREAMS.map((stream) => (
              <Row
                key={stream.key}
                label={stream.label}
                actual={a.revenue[stream.key]}
                model={(m) => m.pnl.revenue[stream.key]}
                compare={compare}
              />
            ))}
            {a.otherRevenue.map((other) => (
              <Row
                key={other.key}
                label={`${humanize(other.key)} (not in model)`}
                actual={other.cents}
                model={() => null}
                compare={compare}
              />
            ))}
            <Row
              label="Total revenue"
              actual={a.totalRevenue}
              model={(m) => m.pnl.totalRevenue}
              compare={compare}
              emphasis
            />
            <Row
              label="Variable costs (KYB, screening, gas)"
              actual={a.variableCosts}
              model={(m) => m.pnl.variableCosts}
              compare={compare}
            />
            <Row
              label="Gross margin"
              actual={a.grossMarginBps}
              model={(m) => m.pnl.grossMarginBps}
              compare={compare}
              format={margin}
            />
            <Row
              label="Fixed costs (model)"
              actual={null}
              model={(m) => m.pnl.fixedCosts}
              compare={compare}
            />
            <Row
              label="Operating profit (model)"
              actual={null}
              model={(m) => m.pnl.operatingProfit}
              compare={compare}
              emphasis
            />
          </tbody>
        </Table>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card aria-labelledby="volume-title">
          <CardHeader
            id="volume-title"
            title="Volume drivers"
            description="Settled payments to third parties this month."
          />
          <Table caption="Monthly volume, actual versus the business model">
            <ModelHeader compare={compare} />
            <tbody>
              <Row
                label="Outbound payments"
                actual={a.volume.outbound}
                model={(m) => m.volume.outbound}
                compare={compare}
                format={formatCentsCompact}
              />
              <Row
                label="x402 volume"
                actual={a.volume.x402}
                model={(m) => m.volume.x402}
                compare={compare}
                format={formatCentsCompact}
              />
              <Row
                label="Escrowed"
                actual={a.volume.escrow}
                model={(m) => m.volume.escrow}
                compare={compare}
                format={formatCentsCompact}
              />
              <Row
                label="Streamed"
                actual={a.volume.streams}
                model={(m) => m.volume.streams}
                compare={compare}
                format={formatCentsCompact}
              />
              <Row
                label="Total"
                actual={a.volume.total}
                model={(m) => m.volume.total}
                compare={compare}
                format={formatCentsCompact}
                emphasis
              />
              <Row
                label="Per paying org"
                actual={a.volumePerOrg}
                model={(m) => m.volumePerOrg}
                compare={compare}
                format={formatCentsCompact}
              />
            </tbody>
          </Table>
        </Card>
        <Card aria-labelledby="orgs-title">
          <CardHeader id="orgs-title" title="Paying orgs" description="Subscriptions by plan." />
          <Table caption="Paying orgs, actual versus the business model">
            <ModelHeader compare={compare} />
            <tbody>
              <Row
                label="Pro"
                actual={a.orgs.pro}
                model={(m) => m.orgs.pro}
                compare={compare}
                format={count}
              />
              <Row
                label="Business"
                actual={a.orgs.business}
                model={(m) => m.orgs.business}
                compare={compare}
                format={count}
              />
              <Row
                label="Enterprise"
                actual={a.orgs.enterprise}
                model={(m) => m.orgs.enterprise}
                compare={compare}
                format={count}
              />
              <Row
                label="Total paying"
                actual={orgsPaying}
                model={(m) => m.orgs.pro + m.orgs.business + m.orgs.enterprise}
                compare={compare}
                format={count}
                emphasis
              />
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

export function RevenuePage() {
  const [periods] = useState(() => recentPeriods(12));
  const [period, setPeriod] = useState(periods[0] ?? "");
  const [compare, setCompare] = useState<Stage>("growth");
  const report = useApi("getRevenueReport", { query: { period } });
  const a = useMemo(() => (report.data ? actuals(report.data) : null), [report.data]);

  return (
    <>
      <PageHeader
        title="Revenue dashboard"
        description="Revenue by stream, gross margin and volume per org against the design doc's Beta, Growth and Scale drivers. Model figures are planning assumptions, not a forecast."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StagePicker value={compare} onChange={setCompare} />
            <div className="w-44">
              <SelectField label="Month" hideLabel value={period} onChange={(e) => setPeriod(e.target.value)}>
                {periods.map((p) => (
                  <option key={p} value={p}>
                    {formatPeriod(p)}
                  </option>
                ))}
              </SelectField>
            </div>
          </div>
        }
      />
      {report.error ? (
        <ProblemAlert problem={report.error} onRetry={() => void report.mutate()} />
      ) : !a ? (
        <Card>
          <CardBody>
            <LoadingState label="Loading revenue report" rows={6} className="px-0" />
          </CardBody>
        </Card>
      ) : (
        <Dashboard a={a} compare={compare} />
      )}
    </>
  );
}
