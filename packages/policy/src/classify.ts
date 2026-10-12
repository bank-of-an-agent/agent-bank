import {
  canonicalJson,
  LOOSENING_DELAY_SECONDS,
  PAYMENT_KINDS,
  type PolicyDocumentInput,
} from "@agentbank/core";
import { approversFor } from "./approvals";
import { compilePolicy } from "./compile";
import { IDENTIFIER_FIELDS } from "./counterparty";
import { compareTimeWindows } from "./time-windows";
import type { CompiledCounterpartyCap, CompiledPolicy } from "./types";

/**
 * How a policy change affects what the agent can spend:
 * - `initial`: the agent's first policy (there is nothing to compare with).
 * - `tighten`: everything allowed afterwards was allowed before.
 * - `loosen`: everything allowed before is still allowed, and more is.
 * - `mixed`: some things become allowed and others disallowed.
 * - `unchanged`: outflow capacity is identical (the documents may still
 *   differ in neutral fields such as `auto_save`, or in form).
 */
export type ChangeKind = "initial" | "tighten" | "loosen" | "mixed" | "unchanged";

/** Direction of one change. */
export type ChangeDirection = "tighten" | "loosen";

/**
 * One effective change. Paths name the effective rule, e.g. `limits.per_day`,
 * `counterparties.allowlist.x402_domains[api.example.com]`,
 * `counterparties.denylist.addresses[0x…]`, `counterparties.mode`,
 * `counterparties.caps[address:0x…].per_day`, `allowed_kinds[escrow]`,
 * `velocity.max_per_minute`, `time_windows`, `approvals`. A path may appear
 * twice (once per direction) when it both tightens and loosens.
 */
export interface PolicyChange {
  readonly path: string;
  readonly direction: ChangeDirection;
}

/** Result of {@link classifyChange}. */
export interface ChangeClassification {
  readonly kind: ChangeKind;
  readonly changes: readonly PolicyChange[];
  /**
   * Paths that changed without affecting outflow capacity (`auto_save.*`,
   * `$schema`). They need no delay, but `auto_save.*` changes still need the
   * owner's authorization (see {@link requiresOwnerSignatureForChange}).
   */
  readonly neutral: readonly string[];
}

const NO_CAP = { perTx: null, perDay: null, perMonth: null } as const;

/**
 * Classify a policy change as tightening or loosening outflow capacity.
 *
 * The classification is sound for `tighten`: if a change is classified as
 * `tighten` (or `unchanged`), no payment that the old policy denies or
 * escalates is allowed, or escalated less, by the new one. Anything that
 * cannot be proven tighter is reported as a loosening, so the worst case of
 * an imprecise comparison is an unnecessary owner signature and delay.
 *
 * Tighten: lower or newly added caps (`limits.*`, `counterparties.caps`,
 * `max_balance`, `require_owner_above`), removed allowlist entries, added
 * denylist entries, open/denylist → allowlist, a longer cooling period, lower
 * velocity limits, fewer allowed kinds, narrower time windows (allowed
 * minutes compared over a reference week), lower approval thresholds or more
 * approvers, binding the policy to an agent. Loosen: the opposites, and
 * removing a cap entirely. Changing the asset is both. `auto_save` changes
 * move money between the org's own accounts only, so they are neutral for
 * capacity (listed in `neutral`, never delayed) but still owner-signed: see
 * {@link requiresOwnerSignatureForChange}.
 *
 * Throws `AgentBankError("invalid_request")` if either document is invalid
 * (see `compilePolicy`).
 */
export function classifyChange(
  prev: PolicyDocumentInput | null,
  next: PolicyDocumentInput,
): ChangeClassification {
  const n = compilePolicy(next, 0);
  if (prev === null)
    return Object.freeze({ kind: "initial", changes: Object.freeze([]), neutral: Object.freeze([]) });
  const p = compilePolicy(prev, 0);
  const changes: PolicyChange[] = [];
  const add = (path: string, direction: ChangeDirection): void => {
    changes.push(Object.freeze({ path, direction }));
  };

  if (p.agent !== n.agent) {
    if (n.agent !== null) add("agent", "tighten");
    if (p.agent !== null) add("agent", "loosen");
  }
  if (p.asset !== n.asset) {
    add("asset", "tighten");
    add("asset", "loosen");
  }
  compareCap(add, "limits.per_tx", p.limits.perTx, n.limits.perTx);
  compareCap(add, "limits.per_day", p.limits.perDay, n.limits.perDay);
  compareCap(add, "limits.per_week", p.limits.perWeek, n.limits.perWeek);
  compareCap(add, "limits.per_month", p.limits.perMonth, n.limits.perMonth);
  compareCap(add, "max_balance", p.maxBalance, n.maxBalance);
  compareCap(add, "require_owner_above", p.requireOwnerAbove, n.requireOwnerAbove);
  compareCap(add, "velocity.max_per_minute", big(p.velocity.perMinute), big(n.velocity.perMinute));
  compareCap(add, "velocity.max_per_hour", big(p.velocity.perHour), big(n.velocity.perHour));
  compareCap(add, "velocity.max_per_day", big(p.velocity.perDay), big(n.velocity.perDay));

  const allKinds = new Set(PAYMENT_KINDS);
  const prevKinds = p.allowedKinds ?? allKinds;
  const nextKinds = n.allowedKinds ?? allKinds;
  for (const kind of PAYMENT_KINDS) {
    if (prevKinds.has(kind) && !nextKinds.has(kind)) add(`allowed_kinds[${kind}]`, "tighten");
    if (!prevKinds.has(kind) && nextKinds.has(kind)) add(`allowed_kinds[${kind}]`, "loosen");
  }

  compareCounterparties(add, p, n);

  const windows = compareTimeWindows(p.timeWindows, n.timeWindows);
  if (windows.narrower) add("time_windows", "tighten");
  if (windows.wider) add("time_windows", "loosen");

  const points = [...new Set([...p.approvals, ...n.approvals].map((s) => s.above + 1n))];
  let moreApprovers = false;
  let fewerApprovers = false;
  for (const amount of points) {
    const before = approversFor(p.approvals, amount).approvers;
    const after = approversFor(n.approvals, amount).approvers;
    if (after > before) moreApprovers = true;
    if (after < before) fewerApprovers = true;
  }
  if (moreApprovers) add("approvals", "tighten");
  if (fewerApprovers) add("approvals", "loosen");

  const neutral: string[] = [];
  const ps = p.autoSave;
  const ns = n.autoSave;
  const saveRules = [
    ["income_split", ps?.incomeSplit ?? null, ns?.incomeSplit ?? null],
    ["excess_sweep", ps?.excessSweep ?? null, ns?.excessSweep ?? null],
    ["round_up", ps?.roundUp ?? null, ns?.roundUp ?? null],
    ["scheduled", ps?.scheduled ?? [], ns?.scheduled ?? []],
  ] as const;
  for (const [key, before, after] of saveRules) {
    if (canonicalJson(before) !== canonicalJson(after)) neutral.push(`auto_save.${key}`);
  }
  if (p.source.$schema !== n.source.$schema) neutral.push("$schema");

  const tighter = changes.some((c) => c.direction === "tighten");
  const looser = changes.some((c) => c.direction === "loosen");
  const kind: ChangeKind =
    tighter && looser ? "mixed" : tighter ? "tighten" : looser ? "loosen" : "unchanged";
  return Object.freeze({ kind, changes: Object.freeze(changes), neutral: Object.freeze(neutral) });
}

type Add = (path: string, direction: ChangeDirection) => void;

function big(value: number | null): bigint | null {
  return value === null ? null : BigInt(value);
}

/** Compare an upper bound (`null` = unbounded): lower or added is tighter. */
function compareCap(add: Add, path: string, prev: bigint | null, next: bigint | null): void {
  if (prev === next) return;
  if (next === null) add(path, "loosen");
  else if (prev === null || next < prev) add(path, "tighten");
  else add(path, "loosen");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function compareCounterparties(add: Add, p: CompiledPolicy, n: CompiledPolicy): void {
  const pc = p.counterparties;
  const nc = n.counterparties;
  for (const field of IDENTIFIER_FIELDS) {
    const before = pc.deny[field.set];
    const after = nc.deny[field.set];
    for (const x of sorted(before))
      if (!after.has(x)) add(`counterparties.denylist.${field.wire}[${x}]`, "loosen");
    for (const x of sorted(after))
      if (!before.has(x)) add(`counterparties.denylist.${field.wire}[${x}]`, "tighten");
  }
  if (pc.allow !== null && nc.allow !== null) {
    for (const field of IDENTIFIER_FIELDS) {
      const before = pc.allow[field.set];
      const after = nc.allow[field.set];
      for (const x of sorted(after))
        if (!before.has(x)) add(`counterparties.allowlist.${field.wire}[${x}]`, "loosen");
      for (const x of sorted(before))
        if (!after.has(x)) add(`counterparties.allowlist.${field.wire}[${x}]`, "tighten");
    }
  } else if (pc.allow === null && nc.allow !== null) {
    add("counterparties.mode", "tighten");
  } else if (pc.allow !== null && nc.allow === null) {
    add("counterparties.mode", "loosen");
  }

  if (nc.cooldownMinutes > pc.cooldownMinutes) add("counterparties.new_cooldown_minutes", "tighten");
  if (nc.cooldownMinutes < pc.cooldownMinutes) add("counterparties.new_cooldown_minutes", "loosen");

  const before = capsByKey(pc.caps);
  const after = capsByKey(nc.caps);
  for (const key of sorted(new Set([...before.keys(), ...after.keys()]))) {
    const a = before.get(key) ?? NO_CAP;
    const b = after.get(key) ?? NO_CAP;
    compareCap(add, `counterparties.caps[${key}].per_tx`, a.perTx, b.perTx);
    compareCap(add, `counterparties.caps[${key}].per_day`, a.perDay, b.perDay);
    compareCap(add, `counterparties.caps[${key}].per_month`, a.perMonth, b.perMonth);
  }
}

interface CapLimits {
  perTx: bigint | null;
  perDay: bigint | null;
  perMonth: bigint | null;
}

/** Caps keyed by `type:value`, combining repeated entries for one identifier (tightest wins). */
function capsByKey(caps: readonly CompiledCounterpartyCap[]): Map<string, CapLimits> {
  const out = new Map<string, CapLimits>();
  const min = (a: bigint | null, b: bigint | null): bigint | null =>
    a === null ? b : b === null || a < b ? a : b;
  for (const cap of caps) {
    const key = `${cap.type}:${cap.value}`;
    const prev = out.get(key) ?? NO_CAP;
    out.set(key, {
      perTx: min(prev.perTx, cap.perTx),
      perDay: min(prev.perDay, cap.perDay),
      perMonth: min(prev.perMonth, cap.perMonth),
    });
  }
  return out;
}

/**
 * Whether a change of this kind needs an owner authorization
 * (`policy.loosen`): loosening and mixed changes, and the initial policy
 * (an agent without a policy can spend nothing, so its first policy is
 * itself a loosening from deny-all; it is authorized by the owner but takes
 * effect without delay, because no prior capacity exists to protect).
 *
 * This looks at the kind only. To decide whether a concrete change needs the
 * owner, use {@link requiresOwnerSignatureForChange}, which also covers
 * `auto_save` edits.
 */
export function requiresOwnerSignature(kind: ChangeKind): boolean {
  return kind === "loosen" || kind === "mixed" || kind === "initial";
}

/**
 * Whether a classified change needs an owner authorization: every change
 * {@link requiresOwnerSignature} covers (`initial`, `loosen`, `mixed`), and
 * any change to `auto_save`, because the design makes all auto-save rules
 * owner-signed policy (they decide where an agent's money is moved, even
 * though it stays within the org). This is the check the API and the
 * co-signer should apply to `PUT /v1/agents/{id}/policy`.
 *
 * It does not affect timing: an `auto_save` edit that is otherwise
 * `unchanged` or `tighten` still takes effect immediately; only `loosen` and
 * `mixed` changes wait {@link effectiveAt}'s one-hour delay.
 */
export function requiresOwnerSignatureForChange(change: ChangeClassification): boolean {
  return requiresOwnerSignature(change.kind) || change.neutral.some((path) => path.startsWith("auto_save."));
}

/**
 * When a change of this kind takes effect: immediately for `tighten`,
 * `unchanged` and `initial`; after `LOOSENING_DELAY_SECONDS` (1 hour) for
 * `loosen` and `mixed`, so a stolen admin session cannot quietly raise
 * limits and drain an agent.
 */
export function effectiveAt(kind: ChangeKind, now: Date): Date {
  const delayed = kind === "loosen" || kind === "mixed";
  return new Date(now.getTime() + (delayed ? LOOSENING_DELAY_SECONDS * 1000 : 0));
}
