import { formatAmount, LOOSENING_DELAY_SECONDS, type PolicyDocumentInput } from "@agentbank/core";
import {
  classifyChange,
  compilePolicy,
  effectiveAt,
  requiresOwnerSignatureForChange,
  type ChangeKind,
  type CompiledPolicy,
} from "@agentbank/policy";
import { groupDigits } from "../money";

/**
 * The policy editor's live diff. Classification comes from
 * `@agentbank/policy` (`classifyChange`), the same code the API and the
 * co-signer run, so the console never labels a loosening as a tightening.
 * This module only turns each classified path into words.
 */

export type Direction = "tighten" | "loosen" | "neutral";

export interface DiffItem {
  key: string;
  path: string;
  label: string;
  before: string;
  after: string;
  direction: Direction;
}

export interface PolicyDiff {
  kind: ChangeKind;
  items: DiffItem[];
  /** Loosening, mixed and initial policies, and any auto-save edit, need the owner key (`policy.loosen`). */
  requiresOwner: boolean;
  /** Auto-save rules changed (owner-signed, but never delayed). */
  autoSaveChanged: boolean;
  /** Loosening and mixed changes wait out the 1-hour delay. */
  delayed: boolean;
  effectiveAt: Date;
}

export const LOOSENING_DELAY_MINUTES = LOOSENING_DELAY_SECONDS / 60;

const LIMIT_LABELS: Record<string, string> = {
  "limits.per_tx": "Per-payment limit",
  "limits.per_day": "Daily limit (rolling 24 h)",
  "limits.per_week": "Weekly limit (rolling 7 days)",
  "limits.per_month": "Monthly limit (rolling 30 days)",
  max_balance: "Maximum balance",
  require_owner_above: "Owner signature above",
};

const VELOCITY_LABELS: Record<string, string> = {
  "velocity.max_per_minute": "Payments per minute",
  "velocity.max_per_hour": "Payments per hour",
  "velocity.max_per_day": "Payments per day",
};

const KIND_LABELS: Record<string, string> = {
  transfer: "Transfers",
  x402: "x402 payments",
  escrow: "Escrow",
  stream: "Streams",
  payout: "Payouts",
  refill: "Spend-key refills",
};

const IDENTIFIER_LABELS: Record<string, string> = {
  addresses: "address",
  agent_ids: "agent",
  erc8004_ids: "ERC-8004 id",
  x402_domains: "x402 domain",
  address: "address",
  agent_id: "agent",
  erc8004_id: "ERC-8004 id",
  x402_domain: "x402 domain",
};

const NEUTRAL_LABELS: Record<string, string> = {
  "auto_save.income_split": "Auto-save: income split",
  "auto_save.excess_sweep": "Auto-save: excess sweep",
  "auto_save.round_up": "Auto-save: round-up",
  "auto_save.scheduled": "Auto-save: scheduled saves",
  $schema: "Schema tag",
};

function amount(value: bigint | null, decimals: number, asset: string, none = "No limit"): string {
  if (value === null) return none;
  return `${groupDigits(formatAmount(value, decimals))} ${asset}`;
}

function count(value: number | null): string {
  return value === null ? "No limit" : String(value);
}

function approvalsText(policy: CompiledPolicy | null): string {
  if (!policy || policy.approvals.length === 0) return "None";
  return policy.approvals
    .map(
      (s) =>
        `above ${amount(s.above, policy.decimals, policy.asset)}: ${s.approvers} approver${s.approvers === 1 ? "" : "s"}`,
    )
    .join("; ");
}

function windowsText(policy: CompiledPolicy | null): string {
  const windows = policy?.source.time_windows;
  if (windows === undefined) return "Any time";
  if (windows.length === 0) return "Never (no window)";
  return windows.map((w) => `${w.days.join(", ")} ${w.start}–${w.end} ${w.timezone}`).join("; ");
}

function capText(policy: CompiledPolicy | null, key: string, field: "perTx" | "perDay" | "perMonth"): string {
  if (!policy) return "No cap";
  let best: bigint | null = null;
  for (const cap of policy.counterparties.caps) {
    if (`${cap.type}:${cap.value}` !== key) continue;
    const value = cap[field];
    if (value !== null && (best === null || value < best)) best = value;
  }
  return amount(best, policy.decimals, policy.asset, "No cap");
}

const CAP_FIELD: Record<string, "perTx" | "perDay" | "perMonth"> = {
  per_tx: "perTx",
  per_day: "perDay",
  per_month: "perMonth",
};

const CAP_WINDOW: Record<string, string> = {
  per_tx: "per payment",
  per_day: "per day",
  per_month: "per month",
};

function modeText(policy: CompiledPolicy | null): string {
  return policy ? policy.counterparties.mode : "open";
}

/** Words for one classified path. */
export function describeChange(
  path: string,
  direction: Direction,
  prev: CompiledPolicy | null,
  next: CompiledPolicy,
): Omit<DiffItem, "key" | "direction" | "path"> {
  const decimals = next.decimals;
  const asset = next.asset;

  const limitKey = path in LIMIT_LABELS ? path : null;
  if (limitKey) {
    const pick = (p: CompiledPolicy | null): bigint | null => {
      if (!p) return null;
      switch (limitKey) {
        case "limits.per_tx":
          return p.limits.perTx;
        case "limits.per_day":
          return p.limits.perDay;
        case "limits.per_week":
          return p.limits.perWeek;
        case "limits.per_month":
          return p.limits.perMonth;
        case "max_balance":
          return p.maxBalance;
        default:
          return p.requireOwnerAbove;
      }
    };
    return {
      label: LIMIT_LABELS[limitKey] ?? limitKey,
      before: amount(pick(prev), decimals, asset),
      after: amount(pick(next), decimals, asset),
    };
  }

  if (path in VELOCITY_LABELS) {
    const pick = (p: CompiledPolicy | null): number | null => {
      if (!p) return null;
      if (path === "velocity.max_per_minute") return p.velocity.perMinute;
      if (path === "velocity.max_per_hour") return p.velocity.perHour;
      return p.velocity.perDay;
    };
    return { label: VELOCITY_LABELS[path] ?? path, before: count(pick(prev)), after: count(pick(next)) };
  }

  const kind = /^allowed_kinds\[(.+)\]$/.exec(path)?.[1];
  if (kind) {
    const allowed = (p: CompiledPolicy | null) =>
      p?.allowedKinds ? p.allowedKinds.has(kind as never) : true;
    return {
      label: `Payment kind: ${KIND_LABELS[kind] ?? kind}`,
      before: allowed(prev) ? "Allowed" : "Not allowed",
      after: allowed(next) ? "Allowed" : "Not allowed",
    };
  }

  const list = /^counterparties\.(allowlist|denylist)\.([a-z0-9_]+)\[(.+)\]$/.exec(path);
  if (list) {
    const [, which = "", field = "", value = ""] = list;
    const added = which === "allowlist" ? direction === "loosen" : direction === "tighten";
    return {
      label: `${which === "allowlist" ? "Allowlist" : "Denylist"}: ${IDENTIFIER_LABELS[field] ?? field} ${value}`,
      before: added ? "Not listed" : "Listed",
      after: added ? "Listed" : "Not listed",
    };
  }

  if (path === "counterparties.mode") {
    return { label: "Counterparty mode", before: modeText(prev), after: modeText(next) };
  }

  if (path === "counterparties.new_cooldown_minutes") {
    const minutes = (p: CompiledPolicy | null) => {
      const value = p?.counterparties.cooldownMinutes ?? 0;
      return value === 0 ? "None" : `${value} min`;
    };
    return { label: "New-counterparty cooling period", before: minutes(prev), after: minutes(next) };
  }

  const cap = /^counterparties\.caps\[(.+)\]\.(per_tx|per_day|per_month)$/.exec(path);
  if (cap) {
    const [, key = "", window = "per_tx"] = cap;
    const field = CAP_FIELD[window] ?? "perTx";
    const separator = key.indexOf(":");
    const type = key.slice(0, separator);
    const value = key.slice(separator + 1);
    return {
      label: `Cap for ${IDENTIFIER_LABELS[type] ?? type} ${value} (${CAP_WINDOW[window] ?? window})`,
      before: capText(prev, key, field),
      after: capText(next, key, field),
    };
  }

  if (path === "time_windows") {
    return { label: "Time windows", before: windowsText(prev), after: windowsText(next) };
  }
  if (path === "approvals") {
    return { label: "Approval thresholds", before: approvalsText(prev), after: approvalsText(next) };
  }
  if (path === "agent") {
    return { label: "Bound to agent", before: prev?.agent ?? "Any", after: next.agent ?? "Any" };
  }
  if (path === "asset") {
    return { label: "Asset", before: prev?.asset ?? "—", after: next.asset };
  }
  if (path in NEUTRAL_LABELS) {
    return { label: NEUTRAL_LABELS[path] ?? path, before: "", after: "Changed" };
  }
  return { label: path, before: "", after: "" };
}

/**
 * Diff a draft against the agent's latest policy version (the pending one if
 * a loosening is waiting out its delay; that is what the API compares with).
 * `prev = null` is the agent's first policy. Throws
 * `AgentBankError("invalid_request")` for an invalid draft, like the server.
 */
export function diffPolicy(
  prev: PolicyDocumentInput | null,
  next: PolicyDocumentInput,
  now: Date = new Date(),
): PolicyDiff {
  const classification = classifyChange(prev, next);
  const prevCompiled = prev === null ? null : compilePolicy(prev, 0);
  const nextCompiled = compilePolicy(next, 0);

  const items: DiffItem[] = classification.changes.map((change, i) => ({
    key: `${change.path}:${change.direction}:${i}`,
    path: change.path,
    direction: change.direction,
    ...describeChange(change.path, change.direction, prevCompiled, nextCompiled),
  }));
  for (const path of classification.neutral) {
    items.push({
      key: `${path}:neutral`,
      path,
      direction: "neutral",
      ...describeChange(path, "neutral", prevCompiled, nextCompiled),
    });
  }

  const kind = classification.kind;
  return {
    kind,
    items,
    requiresOwner: requiresOwnerSignatureForChange(classification),
    autoSaveChanged: classification.neutral.some((path) => path.startsWith("auto_save.")),
    delayed: kind === "loosen" || kind === "mixed",
    effectiveAt: effectiveAt(kind, now),
  };
}

/** One-line explanation of what saving the draft will do. */
export function explainDiff(diff: PolicyDiff): string {
  switch (diff.kind) {
    case "unchanged":
      if (diff.autoSaveChanged) {
        return "Only auto-save rules changed. They move money between the org's own accounts, so nothing is delayed, but auto-save is owner-signed policy: the owner key must sign.";
      }
      return diff.items.length > 0
        ? "Only neutral fields changed. Saving applies immediately."
        : "No changes yet.";
    case "tighten":
      return diff.autoSaveChanged
        ? "Every limit change tightens the policy and applies immediately; the auto-save edit still needs the owner key."
        : "Every change tightens the policy. Tightening applies immediately; no owner signature is needed.";
    case "initial":
      return "This is the agent's first policy. An agent without a policy can spend nothing, so the owner key must sign it; it applies immediately.";
    case "loosen":
      return `This change loosens the policy. Loosening needs the owner key and takes effect ${LOOSENING_DELAY_MINUTES} minutes after signing, so a stolen admin session cannot quietly raise limits.`;
    case "mixed":
      return `This change both tightens and loosens rules, so it is treated as a loosening: the owner key must sign and the whole change takes effect after ${LOOSENING_DELAY_MINUTES} minutes.`;
  }
}
