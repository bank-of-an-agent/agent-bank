import {
  AgentBankError,
  decimalsOf,
  parseAmount,
  PolicyDocumentSchema,
  type AssetCode,
  type PaymentKind,
  type PolicyDocumentInput,
} from "@agentbank/core";
import { counterpartySetFromLists } from "./counterparty";
import { normalizeIdentifier, type IdentifierType } from "./normalize";
import { compileTimeWindows } from "./time-windows";
import {
  COMPILED_POLICY_FORMAT,
  type ApprovalStep,
  type CompiledAutoSave,
  type CompiledCounterpartyCap,
  type CompiledPolicy,
  type CompiledScheduledSave,
  type SaveTarget,
} from "./types";

/**
 * Compile a policy document for evaluation.
 *
 * The document is (re)validated with `PolicyDocumentSchema`, so a raw JSON
 * object read from storage is as safe to pass as an already-parsed one, and
 * schema defaults (asset `USDC`, mode `open`, time zone `UTC`) are applied.
 * Decimal strings are parsed once into `bigint` minor units of the policy
 * asset, identifiers are normalized (addresses and ERC-8004 ids lowercased,
 * domains lowercased without a trailing dot), time windows are expanded into
 * per-minute tables and approval thresholds are normalized into a ladder.
 *
 * Throws `AgentBankError("invalid_request")` when the document fails the
 * schema (which rejects unknown time zones, windows ending after 24:00 or
 * starting where they end, empty `time_windows` / `allowed_kinds`, a zero
 * `round_up.to_nearest`, malformed agent / ERC-8004 ids, IP-like hosts and
 * top-level lists in `open` mode) or an amount above the ledger maximum. The
 * compiler re-checks the semantic rules itself as defense in depth. Call it
 * when a policy is written, not only when it is evaluated, so invalid
 * documents are rejected up front.
 *
 * @param doc The policy document (wire shape).
 * @param version The policy version (non-negative integer), echoed in decisions.
 */
export function compilePolicy(doc: PolicyDocumentInput, version: number): CompiledPolicy {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new AgentBankError("invalid_request", "Policy version must be a non-negative integer");
  }
  const parsed = PolicyDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    );
    throw new AgentBankError("invalid_request", `Invalid policy document: ${issues.join("; ")}`, { issues });
  }
  const source = parsed.data;
  const asset: AssetCode = source.asset;
  const decimals = decimalsOf(asset);
  const amount = (value: string | undefined, path: string): bigint | null =>
    value === undefined ? null : parseAt(value, decimals, path);

  const cp = source.counterparties;
  const caps: CompiledCounterpartyCap[] = (cp.caps ?? []).map((cap, i) => {
    const path = `counterparties.caps[${i}]`;
    const [type, raw] = capMatch(cap.match, path);
    const value = normalizeIdentifier(type, raw);
    if (value === null)
      throw new AgentBankError("invalid_request", `${path}.match is not a valid identifier`);
    return Object.freeze({
      type,
      value,
      perTx: amount(cap.per_tx, `${path}.per_tx`),
      perDay: amount(cap.per_day, `${path}.per_day`),
      perMonth: amount(cap.per_month, `${path}.per_month`),
    });
  });

  const compiled: CompiledPolicy = {
    format: COMPILED_POLICY_FORMAT,
    version,
    agent: source.agent ?? null,
    asset,
    decimals,
    limits: Object.freeze({
      perTx: amount(source.limits.per_tx, "limits.per_tx"),
      perDay: amount(source.limits.per_day, "limits.per_day"),
      perWeek: amount(source.limits.per_week, "limits.per_week"),
      perMonth: amount(source.limits.per_month, "limits.per_month"),
    }),
    counterparties: Object.freeze({
      mode: cp.mode,
      allow: cp.mode === "allowlist" ? counterpartySetFromLists([cp], "counterparties") : null,
      deny: counterpartySetFromLists(
        cp.mode === "denylist" ? [cp, cp.deny] : [cp.deny],
        cp.mode === "denylist" ? "counterparties" : "counterparties.deny",
      ),
      cooldownMinutes: cp.new_cooldown_minutes ?? 0,
      caps: Object.freeze(caps),
    }),
    velocity: Object.freeze({
      perMinute: source.velocity?.max_per_minute ?? null,
      perHour: source.velocity?.max_per_hour ?? null,
      perDay: source.velocity?.max_per_day ?? null,
    }),
    timeWindows: source.time_windows === undefined ? null : compileTimeWindows(source.time_windows),
    maxBalance: amount(source.max_balance, "max_balance"),
    approvals: compileApprovals(source.approvals ?? [], decimals),
    requireOwnerAbove: amount(source.require_owner_above, "require_owner_above"),
    allowedKinds: source.allowed_kinds === undefined ? null : new Set<PaymentKind>(source.allowed_kinds),
    autoSave: source.auto_save === undefined ? null : compileAutoSave(source.auto_save, decimals),
    source,
  };
  return Object.freeze(compiled);
}

function parseAt(value: string, decimals: number, path: string): bigint {
  try {
    return parseAmount(value, decimals);
  } catch (error) {
    throw new AgentBankError("invalid_request", `${path}: ${(error as Error).message}`);
  }
}

function capMatch(
  match: { address?: string; agent_id?: string; erc8004_id?: string; x402_domain?: string },
  path: string,
): [IdentifierType, string] {
  const present: Array<[IdentifierType, string | undefined]> = [
    ["address", match.address],
    ["agent_id", match.agent_id],
    ["erc8004_id", match.erc8004_id],
    ["x402_domain", match.x402_domain],
  ];
  const set = present.filter((entry): entry is [IdentifierType, string] => entry[1] !== undefined);
  const only = set[0];
  if (set.length !== 1 || only === undefined) {
    throw new AgentBankError("invalid_request", `${path}.match must name exactly one identifier`);
  }
  return only;
}

/**
 * Sort thresholds ascending, merge duplicates and carry the approver count
 * upward so it never decreases as the amount grows.
 */
function compileApprovals(
  thresholds: readonly { above: string; approvers: number }[],
  decimals: number,
): readonly ApprovalStep[] {
  const sorted = thresholds
    .map((t, i) => ({ above: parseAt(t.above, decimals, `approvals[${i}].above`), approvers: t.approvers }))
    .sort((a, b) => (a.above < b.above ? -1 : a.above > b.above ? 1 : 0));
  const steps: { above: bigint; approvers: number }[] = [];
  let carried = 0;
  for (const t of sorted) {
    carried = Math.max(carried, t.approvers);
    const last = steps[steps.length - 1];
    if (last !== undefined && last.above === t.above) last.approvers = carried;
    else steps.push({ above: t.above, approvers: carried });
  }
  return Object.freeze(steps.map((s) => Object.freeze(s)));
}

interface AutoSaveInput {
  income_split?: { bps: number; to: string } | undefined;
  excess_sweep?: { to: string } | undefined;
  round_up?: { to_nearest: string; to: string } | undefined;
  scheduled?: readonly { amount: string; every: "day" | "week" | "month"; to: string }[] | undefined;
}

function compileAutoSave(input: AutoSaveInput, decimals: number): CompiledAutoSave {
  let roundUp: CompiledAutoSave["roundUp"] = null;
  if (input.round_up !== undefined) {
    const toNearest = parseAt(input.round_up.to_nearest, decimals, "auto_save.round_up.to_nearest");
    if (toNearest <= 0n) {
      throw new AgentBankError("invalid_request", "auto_save.round_up.to_nearest must be greater than zero");
    }
    roundUp = Object.freeze({ toNearest, to: input.round_up.to as SaveTarget });
  }
  const seen = new Map<string, number>();
  const scheduled: CompiledScheduledSave[] = (input.scheduled ?? []).map((rule, i) => {
    const amount = parseAt(rule.amount, decimals, `auto_save.scheduled[${i}].amount`);
    const base = `${rule.every}:${amount}:${rule.to}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return Object.freeze({
      key: n === 1 ? base : `${base}#${n}`,
      amount,
      every: rule.every,
      to: rule.to as SaveTarget,
    });
  });
  return Object.freeze({
    incomeSplit:
      input.income_split === undefined
        ? null
        : Object.freeze({ bps: input.income_split.bps, to: input.income_split.to as SaveTarget }),
    excessSweep:
      input.excess_sweep === undefined ? null : Object.freeze({ to: input.excess_sweep.to as SaveTarget }),
    roundUp,
    scheduled: Object.freeze(scheduled),
  });
}
