"use client";

import { PAYMENT_KINDS, WEEKDAYS } from "@agentbank/core";
import { useState, type ReactNode } from "react";
import { kindLabel } from "@/components/payments/payment-bits";
import { Button } from "@/components/ui/button";
import { Checkbox, SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { IconClose, IconPlus } from "@/components/ui/icons";
import { getIn, setIn, type Draft, type Path } from "@/lib/policy/draft";

/**
 * Form view of a policy draft. Every field edits the same JSON draft the
 * JSON view shows; values are kept as typed and validated as a whole.
 */

interface FieldProps {
  draft: Draft;
  onChange: (next: Draft) => void;
  issues: Map<string, string>;
}

const key = (path: Path) => path.map(String).join(".");

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-4 rounded-xl border border-line p-4 sm:p-5">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {description ? <p className="-mt-2 text-sm text-muted">{description}</p> : null}
      {children}
    </fieldset>
  );
}

function MoneyField({
  draft,
  onChange,
  issues,
  path,
  label,
  hint,
}: FieldProps & { path: Path; label: string; hint?: string }) {
  const value = getIn(draft, path);
  return (
    <TextField
      label={label}
      hint={hint ?? "USDC. Leave empty for no limit."}
      inputMode="decimal"
      autoComplete="off"
      value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
      onChange={(e) =>
        onChange(setIn(draft, path, e.target.value.trim() === "" ? undefined : e.target.value.trim()))
      }
      error={issues.get(key(path))}
      inputClassName="tabular"
    />
  );
}

function IntField({
  draft,
  onChange,
  issues,
  path,
  label,
  hint,
}: FieldProps & { path: Path; label: string; hint?: string }) {
  const value = getIn(draft, path);
  return (
    <TextField
      label={label}
      hint={hint}
      inputMode="numeric"
      autoComplete="off"
      value={value === undefined ? "" : String(value)}
      onChange={(e) => {
        const text = e.target.value.trim();
        onChange(setIn(draft, path, text === "" ? undefined : /^\d+$/.test(text) ? Number(text) : text));
      }}
      error={issues.get(key(path))}
      inputClassName="tabular"
    />
  );
}

function linesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** One entry per line; keeps the text as typed and syncs when the draft changes elsewhere (JSON view). */
function ListField({
  draft,
  onChange,
  issues,
  path,
  label,
  hint,
}: FieldProps & { path: Path; label: string; hint?: string }) {
  const external = linesOf(getIn(draft, path)).join("\n");
  const [text, setText] = useState(external);
  const [synced, setSynced] = useState(external);
  if (external !== synced) {
    setSynced(external);
    if (normalize(text) !== external) setText(external);
  }
  const error = [...issues.entries()].find(([p]) => p === key(path) || p.startsWith(`${key(path)}.`))?.[1];
  return (
    <TextAreaField
      label={label}
      hint={hint ?? "One per line."}
      rows={3}
      spellCheck={false}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const entries = normalize(e.target.value).split("\n").filter(Boolean);
        const next = setIn(draft, path, entries.length ? entries : undefined);
        setSynced(entries.join("\n"));
        onChange(next);
      }}
      error={error}
      inputClassName="font-mono text-xs"
    />
  );
}

function normalize(text: string): string {
  return text
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function RowRemove({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-7 rounded-md p-2 text-muted hover:bg-subtle hover:text-danger-fg"
      aria-label={label}
    >
      <IconClose size={16} />
    </button>
  );
}

function ApprovalsSection(props: FieldProps) {
  const { draft, onChange, issues } = props;
  const rows = Array.isArray(draft.approvals) ? (draft.approvals as Record<string, unknown>[]) : [];
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Approval thresholds</p>
      <p className="text-xs text-muted">
        Payments above an amount wait for human approvers (passkey, 15-minute expiry). The highest threshold
        an amount exceeds decides.
      </p>
      {rows.map((_, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="grid flex-1 grid-cols-2 gap-3">
            <MoneyField
              {...props}
              path={["approvals", i, "above"]}
              label={`Above (USDC)`}
              hint="Strictly above"
            />
            <IntField {...props} path={["approvals", i, "approvers"]} label="Approvers" hint="1 to 5" />
          </div>
          <RowRemove
            label={`Remove threshold ${i + 1}`}
            onClick={() => onChange(setIn(draft, ["approvals", i], undefined))}
          />
        </div>
      ))}
      {issues.get("approvals") ? <p className="text-xs text-danger-fg">{issues.get("approvals")}</p> : null}
      <Button
        size="sm"
        icon={<IconPlus size={14} />}
        disabled={rows.length >= 5}
        onClick={() => onChange(setIn(draft, ["approvals", rows.length], { above: "", approvers: 1 }))}
      >
        Add threshold
      </Button>
    </div>
  );
}

const MATCH_TYPES = [
  { id: "address", label: "Address" },
  { id: "agent_id", label: "Agent id" },
  { id: "erc8004_id", label: "ERC-8004 id" },
  { id: "x402_domain", label: "x402 domain" },
] as const;

function CapsSection(props: FieldProps) {
  const { draft, onChange, issues } = props;
  const caps = linesCaps(getIn(draft, ["counterparties", "caps"]));
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Per-counterparty caps</p>
      {caps.map((cap, i) => {
        const type = (Object.keys(cap.match ?? {})[0] as string | undefined) ?? "address";
        const value = String((cap.match as Record<string, unknown> | undefined)?.[type] ?? "");
        const base: Path = ["counterparties", "caps", i];
        return (
          <div key={i} className="space-y-3 rounded-lg border border-line p-3">
            <div className="flex items-start gap-2">
              <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
                <SelectField
                  label="Match"
                  value={type}
                  onChange={(e) => onChange(setIn(draft, [...base, "match"], { [e.target.value]: value }))}
                >
                  {MATCH_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label="Counterparty"
                  value={value}
                  spellCheck={false}
                  inputClassName="font-mono text-xs"
                  onChange={(e) =>
                    onChange(setIn(draft, [...base, "match"], { [type]: e.target.value.trim() }))
                  }
                  error={issues.get(key([...base, "match"])) ?? issues.get(key([...base, "match", type]))}
                />
              </div>
              <RowRemove
                label={`Remove cap ${i + 1}`}
                onClick={() => onChange(setIn(draft, base, undefined))}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MoneyField {...props} path={[...base, "per_tx"]} label="Per payment" hint="USDC" />
              <MoneyField {...props} path={[...base, "per_day"]} label="Per day" hint="USDC" />
              <MoneyField {...props} path={[...base, "per_month"]} label="Per month" hint="USDC" />
            </div>
          </div>
        );
      })}
      <Button
        size="sm"
        icon={<IconPlus size={14} />}
        onClick={() =>
          onChange(setIn(draft, ["counterparties", "caps", caps.length], { match: { x402_domain: "" } }))
        }
      >
        Add cap
      </Button>
    </div>
  );
}

function linesCaps(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function CounterpartiesSection(props: FieldProps) {
  const { draft, onChange, issues } = props;
  const mode = (getIn(draft, ["counterparties", "mode"]) as string | undefined) ?? "open";
  const listVerb =
    mode === "allowlist" ? "Allowed" : mode === "denylist" ? "Denied" : "Listed (ignored in open mode)";
  const [showDeny, setShowDeny] = useState(Boolean(getIn(draft, ["counterparties", "deny"])));
  return (
    <Section
      title="Counterparties"
      description="Who the agent may pay: by address, Agent Bank agent id, ERC-8004 id or x402 domain."
    >
      <div role="radiogroup" aria-label="Counterparty mode" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {[
          { id: "open", title: "Open", text: "Anyone except denied entries" },
          { id: "allowlist", title: "Allowlist", text: "Only listed counterparties" },
          { id: "denylist", title: "Denylist", text: "Anyone except listed" },
        ].map((option) => (
          <label
            key={option.id}
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${mode === option.id ? "border-blue bg-blue-bg" : "border-line hover:bg-subtle"}`}
          >
            <input
              type="radio"
              name="counterparty-mode"
              className="mt-1 accent-primary"
              checked={mode === option.id}
              onChange={() => onChange(setIn(draft, ["counterparties", "mode"], option.id))}
            />
            <span>
              <span className="block font-medium">{option.title}</span>
              <span className="block text-xs text-muted">{option.text}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ListField {...props} path={["counterparties", "x402_domains"]} label={`${listVerb}: x402 domains`} />
        <ListField {...props} path={["counterparties", "addresses"]} label={`${listVerb}: addresses`} />
        <ListField {...props} path={["counterparties", "agent_ids"]} label={`${listVerb}: agent ids`} />
        <ListField {...props} path={["counterparties", "erc8004_ids"]} label={`${listVerb}: ERC-8004 ids`} />
      </div>
      <div>
        <Button size="sm" variant="ghost" onClick={() => setShowDeny((v) => !v)} aria-expanded={showDeny}>
          {showDeny ? "Hide always-deny lists" : "Always-deny lists (any mode)"}
        </Button>
        {showDeny ? (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
            <ListField
              {...props}
              path={["counterparties", "deny", "x402_domains"]}
              label="Always deny: x402 domains"
            />
            <ListField
              {...props}
              path={["counterparties", "deny", "addresses"]}
              label="Always deny: addresses"
            />
            <ListField
              {...props}
              path={["counterparties", "deny", "agent_ids"]}
              label="Always deny: agent ids"
            />
            <ListField
              {...props}
              path={["counterparties", "deny", "erc8004_ids"]}
              label="Always deny: ERC-8004 ids"
            />
          </div>
        ) : null}
      </div>
      <IntField
        {...props}
        path={["counterparties", "new_cooldown_minutes"]}
        label="Cooling period for new counterparties (minutes)"
        hint="First payments to a new counterparty wait this long. 0 or empty for none; at most 10,080 (7 days)."
      />
      <CapsSection draft={draft} onChange={onChange} issues={issues} />
    </Section>
  );
}

const DAY_LABELS: Record<string, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

function TimeWindowsSection(props: FieldProps) {
  const { draft, onChange, issues } = props;
  const windows = Array.isArray(draft.time_windows)
    ? (draft.time_windows as Record<string, unknown>[])
    : null;
  return (
    <Section title="Time windows" description="Restrict payments to business hours or other windows.">
      <Checkbox
        label="Only allow payments inside these windows"
        checked={windows !== null}
        onChange={(e) =>
          onChange(
            setIn(
              draft,
              ["time_windows"],
              e.target.checked
                ? [
                    {
                      days: ["mon", "tue", "wed", "thu", "fri"],
                      start: "09:00",
                      end: "17:00",
                      timezone: "UTC",
                    },
                  ]
                : undefined,
            ),
          )
        }
      />
      {windows?.map((window, i) => {
        const days = Array.isArray(window.days) ? (window.days as string[]) : [];
        const base: Path = ["time_windows", i];
        return (
          <div key={i} className="space-y-3 rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-2">
              <fieldset>
                <legend className="text-sm font-medium">Days</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <label key={day} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={days.includes(day)}
                        onChange={(e) =>
                          onChange(
                            setIn(
                              draft,
                              [...base, "days"],
                              e.target.checked
                                ? WEEKDAYS.filter((d) => d === day || days.includes(d))
                                : days.filter((d) => d !== day),
                            ),
                          )
                        }
                      />
                      {DAY_LABELS[day]}
                    </label>
                  ))}
                </div>
                {issues.get(key([...base, "days"])) ? (
                  <p className="text-xs text-danger-fg">{issues.get(key([...base, "days"]))}</p>
                ) : null}
              </fieldset>
              <RowRemove
                label={`Remove window ${i + 1}`}
                onClick={() => onChange(setIn(draft, base, undefined))}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextField
                label="Start"
                type="time"
                value={String(window.start ?? "")}
                onChange={(e) => onChange(setIn(draft, [...base, "start"], e.target.value))}
                error={issues.get(key([...base, "start"]))}
              />
              <TextField
                label="End"
                type="time"
                value={String(window.end ?? "")}
                onChange={(e) => onChange(setIn(draft, [...base, "end"], e.target.value))}
                error={issues.get(key([...base, "end"]))}
              />
              <TextField
                label="Time zone"
                value={String(window.timezone ?? "UTC")}
                onChange={(e) => onChange(setIn(draft, [...base, "timezone"], e.target.value))}
                hint="IANA name, e.g. Europe/Paris"
                error={issues.get(key([...base, "timezone"]))}
              />
            </div>
          </div>
        );
      })}
      {windows !== null ? (
        <Button
          size="sm"
          icon={<IconPlus size={14} />}
          disabled={windows.length >= 20}
          onClick={() =>
            onChange(
              setIn(draft, ["time_windows", windows.length], {
                days: ["sat", "sun"],
                start: "10:00",
                end: "16:00",
                timezone: "UTC",
              }),
            )
          }
        >
          Add window
        </Button>
      ) : null}
    </Section>
  );
}

function KindsSection(props: FieldProps) {
  const { draft, onChange } = props;
  const kinds = Array.isArray(draft.allowed_kinds) ? (draft.allowed_kinds as string[]) : null;
  return (
    <Section title="Payment kinds" description="Limit which kinds of payment the agent may make.">
      <Checkbox
        label="Allow every kind"
        checked={kinds === null}
        onChange={(e) =>
          onChange(setIn(draft, ["allowed_kinds"], e.target.checked ? undefined : [...PAYMENT_KINDS]))
        }
      />
      {kinds !== null ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PAYMENT_KINDS.map((kind) => (
            <Checkbox
              key={kind}
              label={kindLabel(kind)}
              checked={kinds.includes(kind)}
              onChange={(e) =>
                onChange(
                  setIn(
                    draft,
                    ["allowed_kinds"],
                    e.target.checked
                      ? PAYMENT_KINDS.filter((k) => k === kind || kinds.includes(k))
                      : kinds.filter((k) => k !== kind),
                  ),
                )
              }
            />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

export function PolicyForm(props: FieldProps) {
  const autoSave = props.draft.auto_save;
  return (
    <div className="space-y-6">
      <Section
        title="Amount limits"
        description="Rolling windows: a day is 24 hours, a week 7 days, a month 30 days."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MoneyField {...props} path={["limits", "per_tx"]} label="Per payment" />
          <MoneyField {...props} path={["limits", "per_day"]} label="Per day" />
          <MoneyField {...props} path={["limits", "per_week"]} label="Per week" />
          <MoneyField {...props} path={["limits", "per_month"]} label="Per month" />
        </div>
      </Section>
      <Section title="Human controls">
        <ApprovalsSection {...props} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MoneyField
            {...props}
            path={["require_owner_above"]}
            label="Owner signs payments above"
            hint="USDC. Above this the owner key must sign the payment itself."
          />
          <MoneyField
            {...props}
            path={["max_balance"]}
            label="Maximum balance"
            hint="USDC. Excess sweeps back to the org treasury."
          />
        </div>
      </Section>
      <CounterpartiesSection {...props} />
      <Section title="Velocity" description="Caps on the number of payments, regardless of amount.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <IntField {...props} path={["velocity", "max_per_minute"]} label="Payments per minute" />
          <IntField {...props} path={["velocity", "max_per_hour"]} label="Payments per hour" />
          <IntField {...props} path={["velocity", "max_per_day"]} label="Payments per day" />
        </div>
      </Section>
      <TimeWindowsSection {...props} />
      <KindsSection {...props} />
      <Section title="Auto-save" description="Income split, excess sweep, round-up and scheduled saves.">
        <p className="text-sm text-muted">
          {autoSave ? "Auto-save rules are set." : "No auto-save rules."} Edit them in the JSON view; they
          move money only between the org&apos;s own accounts.
        </p>
      </Section>
    </div>
  );
}
