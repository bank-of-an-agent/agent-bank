import {
  ASSET_DECIMALS,
  formatAmount,
  MAX_MINOR_UNITS,
  PAYMENT_KINDS,
  type DecisionOutcome,
  type PolicyDecisionWire,
  type RuleHit,
} from "@agentbank/core";
import {
  counterpartyHas,
  counterpartySetSize,
  describeCounterparty,
  describeIdentifier,
  findAnyMatch,
  findRelevantMatch,
  normalizeIntentCounterparty,
  quote,
  type NormalizedCounterparty,
} from "./counterparty";
import { approversFor } from "./approvals";
import { MANDATE_IAT_LEEWAY_MS, RECURRENCE_MIN_SPACING_MS } from "./mandate";
import { normalizeAddress } from "./normalize";
import { mostSevere, type RuleId } from "./rules";
import { isWithinTimeWindows, nextTimeWindowOpening } from "./time-windows";
import {
  COMPILED_MANDATE_FORMAT,
  COMPILED_POLICY_FORMAT,
  COMPILED_SESSION_SCOPE_FORMAT,
  type CompiledPolicy,
  type Decision,
  type EvaluationContext,
  type MandateContext,
  type PolicyRuleHit,
  type SessionContext,
} from "./types";

type Effect = RuleHit["effect"];

const MS_PER_MINUTE = 60_000;

/** Collects rule hits in evaluation order, with the time each time-based denial lifts. */
class Hits {
  readonly list: PolicyRuleHit[] = [];
  private readonly opensAt = new Map<number, number>();

  add(rule: RuleId, effect: Effect, detail: string, opensAt: number | null = null): void {
    if (opensAt !== null) this.opensAt.set(this.list.length, opensAt);
    this.list.push(Object.freeze({ rule, effect, detail }));
  }

  allow(rule: RuleId, detail: string): void {
    this.add(rule, "allow", detail);
  }

  deny(rule: RuleId, detail: string, opensAt: number | null = null): void {
    this.add(rule, "deny", detail, opensAt);
  }

  outcome(): DecisionOutcome {
    let outcome: DecisionOutcome = "allow";
    for (const hit of this.list) {
      if (hit.effect !== "allow" && hit.effect !== "info") outcome = mostSevere(outcome, hit.effect);
    }
    return outcome;
  }

  /** Latest opening time over all denials, or `null` if any denial is not time-based. */
  retryAt(): Date | null {
    let latest: number | null = null;
    for (const [i, hit] of this.list.entries()) {
      if (hit.effect !== "deny") continue;
      const opens = this.opensAt.get(i);
      if (opens === undefined) return null;
      if (latest === null || opens > latest) latest = opens;
    }
    return latest === null ? null : new Date(latest);
  }
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isNonNegativeBigint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Everything wrong with the context, so the engine can fail closed with an explanation. */
function contextProblems(ctx: EvaluationContext): string[] {
  const problems: string[] = [];
  if (typeof ctx.agent?.id !== "string" || ctx.agent.id.length === 0) {
    problems.push("agent.id must be a non-empty string");
  }
  const intent = ctx.intent as EvaluationContext["intent"] | undefined;
  if (intent === undefined || intent === null || typeof intent !== "object") {
    problems.push("intent is missing");
  } else {
    if (!(PAYMENT_KINDS as readonly unknown[]).includes(intent.kind)) {
      problems.push(`intent.kind ${quote(intent.kind)} is not a payment kind`);
    }
    if (typeof intent.amount !== "bigint") problems.push("intent.amount must be a bigint of minor units");
    else if (intent.amount <= 0n) problems.push("intent.amount must be positive");
    else if (intent.amount > MAX_MINOR_UNITS)
      problems.push("intent.amount exceeds the largest supported amount");
    if (typeof intent.asset !== "string") problems.push("intent.asset must be an asset code");
    if (!isAbsent(intent.contract) && normalizeAddress(intent.contract) === null) {
      problems.push(`intent.contract ${quote(intent.contract)} is not an address`);
    }
  }
  const h = ctx.history as EvaluationContext["history"] | undefined;
  if (h === undefined || h === null || typeof h !== "object") {
    problems.push("history is missing");
  } else {
    for (const key of [
      "spentLastDay",
      "spentLastWeek",
      "spentLastMonth",
      "counterpartySpentLastDay",
      "counterpartySpentLastMonth",
    ] as const) {
      if (!isNonNegativeBigint(h[key])) problems.push(`history.${key} must be a non-negative bigint`);
    }
    for (const key of ["countLastMinute", "countLastHour", "countLastDay"] as const) {
      if (!isCount(h[key])) problems.push(`history.${key} must be a non-negative integer`);
    }
    if (h.counterpartyFirstSeenAt !== null && !isValidDate(h.counterpartyFirstSeenAt)) {
      problems.push("history.counterpartyFirstSeenAt must be a valid Date or null");
    }
  }
  const mc = ctx.mandate;
  if (!isAbsent(mc)) {
    if (mc.mandate?.format !== COMPILED_MANDATE_FORMAT)
      problems.push("mandate.mandate must come from compileMandate");
    if (!isNonNegativeBigint(mc.spent)) problems.push("mandate.spent must be a non-negative bigint");
    if (!isCount(mc.occurrences)) problems.push("mandate.occurrences must be a non-negative integer");
    if (!isAbsent(mc.lastOccurrenceAt) && !isValidDate(mc.lastOccurrenceAt)) {
      problems.push("mandate.lastOccurrenceAt must be a valid Date");
    }
  }
  const sc = ctx.session;
  if (!isAbsent(sc)) {
    if (sc.scope?.format !== COMPILED_SESSION_SCOPE_FORMAT) {
      problems.push("session.scope must come from compileSessionScope");
    }
    if (!isNonNegativeBigint(sc.spentToday))
      problems.push("session.spentToday must be a non-negative bigint");
    if (!isAbsent(sc.revokedAt) && !isValidDate(sc.revokedAt))
      problems.push("session.revokedAt must be a valid Date");
  }
  return problems;
}

/**
 * Evaluate a payment intent against a compiled policy. Pure and
 * deterministic: the same policy and context always produce the same
 * decision; the clock is `context.now` and nothing else is read.
 *
 * Every applicable rule is evaluated (there is no short-circuit) and reported
 * in `ruleHits` in a fixed order: status, kind, asset, counterparty identity,
 * counterparty rules (denylist, allowlist, cooling period, per-counterparty
 * caps), time windows, amount limits, velocity, mandate, session scope, owner
 * threshold, approvals. Configured rules that pass report `allow`. The
 * outcome is the most severe effect: `deny` > `require_owner` >
 * `require_approval` > `allow`.
 *
 * Fails closed: a `null` policy denies with `policy.missing`; a malformed
 * context denies with `context.invalid`; anything unexpected denies with
 * `engine.error`. It never throws.
 *
 * Comparisons: amounts over a cap deny when `spent + amount > cap`; velocity
 * denies when the count already made in the window `>= max`; approval and
 * owner thresholds apply when `amount > above`.
 */
export function evaluate(policy: CompiledPolicy | null, ctx: EvaluationContext): Decision {
  try {
    return run(policy, ctx);
  } catch (error) {
    const now = (ctx as EvaluationContext | null | undefined)?.now;
    return Object.freeze({
      outcome: "deny",
      ruleHits: Object.freeze([
        Object.freeze({
          rule: "engine.error",
          effect: "deny",
          detail: `Policy evaluation failed (${error instanceof Error ? error.message : String(error)}); failing closed`,
        } satisfies PolicyRuleHit),
      ]),
      approversRequired: 0,
      policyVersion: versionOf(policy),
      evaluatedAt: isValidDate(now) ? new Date(now.getTime()) : new Date(0),
      retryAt: null,
    } satisfies Decision);
  }
}

function versionOf(policy: CompiledPolicy | null): number {
  const version: unknown = (policy as { version?: unknown } | null)?.version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

function finish(hits: Hits, policy: CompiledPolicy | null, evaluatedAt: Date, approvers: number): Decision {
  const outcome = hits.outcome();
  return Object.freeze({
    outcome,
    ruleHits: Object.freeze(hits.list),
    approversRequired: outcome === "require_approval" ? approvers : 0,
    policyVersion: versionOf(policy),
    evaluatedAt,
    retryAt: outcome === "deny" ? hits.retryAt() : null,
  });
}

function run(policy: CompiledPolicy | null, ctx: EvaluationContext): Decision {
  const hits = new Hits();
  const now = (ctx as EvaluationContext | null | undefined)?.now;
  if (!isValidDate(now)) {
    hits.deny("context.invalid", "context.now must be a valid Date");
    return finish(hits, policy, new Date(0), 0);
  }
  const at = now.getTime();
  const evaluatedAt = new Date(at);

  if (ctx.agent?.status !== "active") {
    hits.deny(
      "agent.frozen",
      `Agent ${String(ctx.agent?.id)} is ${quote(ctx.agent?.status)}; nothing can be paid`,
    );
  }
  if (ctx.org?.status !== "active") {
    hits.deny("org.frozen", `The organization is ${quote(ctx.org?.status)}; nothing can be paid`);
  }
  const problems = contextProblems(ctx);
  if (problems.length > 0) {
    hits.deny("context.invalid", problems.join("; "));
    return finish(hits, policy, evaluatedAt, 0);
  }

  let p: CompiledPolicy | null = null;
  if (policy === null) {
    hits.deny("policy.missing", "No policy is in effect for this agent; failing closed");
  } else if ((policy as { format?: unknown }).format !== COMPILED_POLICY_FORMAT) {
    hits.deny("policy.invalid", "The policy was not produced by compilePolicy; failing closed");
  } else {
    p = policy;
  }

  const { intent, history } = ctx;
  const { amount, kind } = intent;
  const decimals = p?.decimals ?? ASSET_DECIMALS.USDC;
  const unit = p?.asset ?? "USDC";
  const fmt = (v: bigint): string => `${formatAmount(v, decimals)} ${unit}`;
  const cap = (rule: RuleId, limit: bigint | null, spent: bigint, label: string): void => {
    if (limit === null) return;
    const total = spent + amount;
    const what = spent > 0n ? `${fmt(amount)} + ${fmt(spent)} already spent` : fmt(amount);
    if (total > limit) hits.deny(rule, `${what} exceeds the ${label} of ${fmt(limit)}`);
    else hits.allow(rule, `${what} is within the ${label} of ${fmt(limit)}`);
  };

  if (p !== null && p.agent !== null && p.agent !== ctx.agent.id) {
    hits.deny("policy.agent", `The policy is bound to agent ${p.agent}, not ${ctx.agent.id}`);
  }
  if (p?.allowedKinds) {
    if (p.allowedKinds.has(kind)) hits.allow("kinds.allowed", `${kind} payments are allowed`);
    else hits.deny("kinds.allowed", `${kind} payments are not allowed by the policy`);
  }
  if (p !== null && intent.asset !== p.asset) {
    hits.deny("asset", `Asset ${quote(intent.asset)} is not the policy asset ${p.asset}`);
  }

  const normalized = normalizeIntentCounterparty(intent.counterparty, kind);
  const cp = normalized.counterparty;
  if (normalized.problems.length > 0) hits.deny("counterparty.invalid", normalized.problems.join("; "));

  let ownRefill = false;
  if (kind === "refill") {
    const spendKey = normalizeAddress(ctx.agent.spendKeyAddress);
    if (spendKey === null) {
      hits.deny("refill.target", "The agent has no registered spend key, so a refill cannot be verified");
    } else if (cp.address !== spendKey) {
      hits.deny("refill.target", `Refills may only go to the agent's spend key ${spendKey}`);
    } else {
      ownRefill = true;
      hits.allow(
        "refill.target",
        `Refill of the agent's own spend key ${spendKey}; counterparty rules do not apply`,
      );
    }
  }

  if (p !== null && !ownRefill) {
    evaluateCounterparty(hits, p, cp, ctx, at, cap);
  }

  if (p?.timeWindows) {
    if (isWithinTimeWindows(p.timeWindows, now)) {
      hits.allow("time_windows", "Inside an allowed time window");
    } else {
      const opens = nextTimeWindowOpening(p.timeWindows, now);
      hits.deny(
        "time_windows",
        opens === null
          ? "The policy allows no time window at all"
          : `Outside the allowed time windows; the next window opens at ${opens.toISOString()}`,
        opens?.getTime() ?? null,
      );
    }
  }

  if (p !== null) {
    cap("limits.per_tx", p.limits.perTx, 0n, "per-transaction limit");
    cap("limits.per_day", p.limits.perDay, history.spentLastDay, "daily limit (rolling 24 h)");
    cap("limits.per_week", p.limits.perWeek, history.spentLastWeek, "weekly limit (rolling 7 days)");
    cap("limits.per_month", p.limits.perMonth, history.spentLastMonth, "monthly limit (rolling 30 days)");
    const velocity = (rule: RuleId, max: number | null, count: number, window: string): void => {
      if (max === null) return;
      const detail = `${count} payment(s) in the last ${window}; at most ${max} allowed`;
      if (count >= max) hits.deny(rule, detail);
      else hits.allow(rule, detail);
    };
    velocity("velocity.per_minute", p.velocity.perMinute, history.countLastMinute, "minute");
    velocity("velocity.per_hour", p.velocity.perHour, history.countLastHour, "hour");
    velocity("velocity.per_day", p.velocity.perDay, history.countLastDay, "24 hours");
  }

  if (!isAbsent(ctx.mandate)) evaluateMandate(hits, ctx.mandate, ctx, cp, at, fmt);
  if (!isAbsent(ctx.session)) evaluateSession(hits, ctx.session, ctx, cp, at, fmt);

  let approvers = 0;
  if (p !== null) {
    if (p.requireOwnerAbove !== null) {
      if (amount > p.requireOwnerAbove) {
        hits.add(
          "require_owner_above",
          "require_owner",
          `${fmt(amount)} is above ${fmt(p.requireOwnerAbove)}: the owner key must sign this payment`,
        );
      } else {
        hits.allow("require_owner_above", `${fmt(amount)} does not exceed ${fmt(p.requireOwnerAbove)}`);
      }
    }
    if (p.approvals.length > 0) {
      const required = approversFor(p.approvals, amount);
      approvers = required.approvers;
      if (approvers > 0) {
        hits.add(
          "approvals",
          "require_approval",
          `${fmt(amount)} is above ${fmt(required.above)}: ${approvers} approver(s) required`,
        );
      } else {
        hits.allow("approvals", `${fmt(amount)} is below every approval threshold`);
      }
    }
  }
  return finish(hits, p ?? policy, evaluatedAt, approvers);
}

type CapCheck = (rule: RuleId, limit: bigint | null, spent: bigint, label: string) => void;

function evaluateCounterparty(
  hits: Hits,
  p: CompiledPolicy,
  cp: NormalizedCounterparty,
  ctx: EvaluationContext,
  at: number,
  cap: CapCheck,
): void {
  const { kind } = ctx.intent;
  const { history } = ctx;
  const rules = p.counterparties;
  if (counterpartySetSize(rules.deny) > 0) {
    const match = findAnyMatch(rules.deny, cp);
    if (match !== null) hits.deny("counterparties.denylist", `${match} is denylisted`);
    else hits.allow("counterparties.denylist", "The counterparty is not denylisted");
  }
  if (rules.allow !== null) {
    const match = findRelevantMatch(rules.allow, cp, kind);
    if (match !== null) {
      hits.allow("counterparties.allowlist", `${match} is allowlisted`);
    } else {
      const how = kind === "x402" ? " (x402 payments match by host name)" : "";
      hits.deny(
        "counterparties.allowlist",
        `${describeCounterparty(cp, kind)} is not on the allowlist${how}`,
      );
    }
  }
  if (rules.cooldownMinutes > 0) {
    const first = history.counterpartyFirstSeenAt;
    const window = rules.cooldownMinutes * MS_PER_MINUTE;
    if (first === null) {
      const opens = at + window;
      hits.deny(
        "counterparties.cooldown",
        `First payment to ${describeCounterparty(cp, kind)}: new counterparties cool down for ${rules.cooldownMinutes} minute(s); opens at ${iso(opens)}`,
        opens,
      );
    } else if (at < first.getTime() + window) {
      const opens = first.getTime() + window;
      hits.deny(
        "counterparties.cooldown",
        `Counterparty first seen at ${first.toISOString()}; its cooling period ends at ${iso(opens)}`,
        opens,
      );
    } else {
      hits.allow(
        "counterparties.cooldown",
        `Counterparty first seen at ${first.toISOString()}; cooling period over`,
      );
    }
  }
  for (const c of rules.caps) {
    if (!counterpartyHas(cp, c.type, c.value)) continue;
    const label = describeIdentifier(c.type, c.value);
    cap("counterparties.caps.per_tx", c.perTx, 0n, `per-transaction cap for ${label}`);
    cap("counterparties.caps.per_day", c.perDay, history.counterpartySpentLastDay, `daily cap for ${label}`);
    cap(
      "counterparties.caps.per_month",
      c.perMonth,
      history.counterpartySpentLastMonth,
      `monthly cap for ${label}`,
    );
  }
}

function evaluateMandate(
  hits: Hits,
  mc: MandateContext,
  ctx: EvaluationContext,
  cp: NormalizedCounterparty,
  at: number,
  fmt: (v: bigint) => string,
): void {
  const m = mc.mandate;
  const { amount, kind } = ctx.intent;
  if (m.agentId !== ctx.agent.id)
    hits.deny("mandate.agent", `The mandate was granted to ${m.agentId}, not ${ctx.agent.id}`);
  else hits.allow("mandate.agent", `The mandate was granted to ${m.agentId}`);
  if (ctx.intent.asset !== "USDC") hits.deny("mandate.asset", "Mandates authorize USD/USDC payments only");

  const validFrom = m.issuedAt.getTime() - MANDATE_IAT_LEEWAY_MS;
  if (at < validFrom) {
    hits.deny("mandate.not_yet_valid", `The mandate is issued at ${m.issuedAt.toISOString()}`, validFrom);
  }
  if (at >= m.expiresAt.getTime())
    hits.deny("mandate.expired", `The mandate expired at ${m.expiresAt.toISOString()}`);
  else hits.allow("mandate.expired", `The mandate is valid until ${m.expiresAt.toISOString()}`);

  const window = m.executionWindow;
  if (window !== null) {
    if (window.notBefore !== null && at < window.notBefore.getTime()) {
      hits.deny(
        "mandate.execution_date",
        `The mandate may not execute before ${window.notBefore.toISOString()}`,
        window.notBefore.getTime(),
      );
    } else if (window.notAfter !== null && at > window.notAfter.getTime()) {
      hits.deny(
        "mandate.execution_date",
        `The mandate may not execute after ${window.notAfter.toISOString()}`,
      );
    } else {
      hits.allow("mandate.execution_date", "Inside the mandate's execution window");
    }
  }

  if (m.amountRange !== null) {
    const { min, max } = m.amountRange;
    if (amount > max || amount < min) {
      hits.deny(
        "mandate.amount_range",
        `${fmt(amount)} is outside the mandate's range ${fmt(min)} to ${fmt(max)}`,
      );
    } else {
      hits.allow(
        "mandate.amount_range",
        `${fmt(amount)} is inside the mandate's range ${fmt(min)} to ${fmt(max)}`,
      );
    }
  }
  for (const set of m.payeeSets) {
    const match = findRelevantMatch(set, cp, kind);
    if (match !== null) hits.allow("mandate.allowed_payees", `${match} is an allowed payee of the mandate`);
    else
      hits.deny(
        "mandate.allowed_payees",
        `${describeCounterparty(cp, kind)} is not an allowed payee of the mandate`,
      );
  }
  for (const set of m.x402DomainSets) {
    if (kind === "x402" && cp.x402Domain !== null && set.has(cp.x402Domain)) {
      hits.allow("mandate.x402_domains", `${cp.x402Domain} is an allowed x402 host of the mandate`);
    } else {
      hits.deny(
        "mandate.x402_domains",
        kind === "x402"
          ? `${describeCounterparty(cp, kind)} is not an allowed x402 host of the mandate`
          : "The mandate only authorizes x402 payments to its listed hosts",
      );
    }
  }
  if (m.budget !== null) {
    const total = mc.spent + amount;
    const detail = `${fmt(amount)} + ${fmt(mc.spent)} already spent under the mandate against its budget of ${fmt(m.budget)}`;
    if (total > m.budget) hits.deny("mandate.budget", detail);
    else hits.allow("mandate.budget", detail);
  }
  const recurrence = m.recurrence;
  if (recurrence !== null) {
    if (recurrence.maxOccurrences !== null) {
      const detail = `${mc.occurrences} of at most ${recurrence.maxOccurrences} payment(s) made under the mandate`;
      if (mc.occurrences >= recurrence.maxOccurrences) hits.deny("mandate.max_occurrences", detail);
      else hits.allow("mandate.max_occurrences", detail);
    }
    const spacing = RECURRENCE_MIN_SPACING_MS[recurrence.frequency];
    const last = mc.lastOccurrenceAt;
    if (spacing > 0 && !isAbsent(last)) {
      const opens = last.getTime() + spacing;
      if (at < opens) {
        hits.deny(
          "mandate.recurrence",
          `${recurrence.frequency} mandate last used at ${last.toISOString()}; next payment from ${iso(opens)}`,
          opens,
        );
      } else {
        hits.allow(
          "mandate.recurrence",
          `${recurrence.frequency} mandate last used at ${last.toISOString()}`,
        );
      }
    }
  }
}

function evaluateSession(
  hits: Hits,
  sc: SessionContext,
  ctx: EvaluationContext,
  cp: NormalizedCounterparty,
  at: number,
  fmt: (v: bigint) => string,
): void {
  const s = sc.scope;
  const { amount, kind } = ctx.intent;
  if (!isAbsent(sc.revokedAt) && sc.revokedAt.getTime() <= at) {
    hits.deny("session.revoked", `The session key was revoked at ${sc.revokedAt.toISOString()}`);
  }
  if (at >= s.expiresAt.getTime())
    hits.deny("session.expired", `The session key expired at ${s.expiresAt.toISOString()}`);
  else hits.allow("session.expired", `The session key is valid until ${s.expiresAt.toISOString()}`);
  if (ctx.intent.asset !== s.asset) hits.deny("session.asset", `The session key may only move ${s.asset}`);

  if (amount > s.maxPerTx)
    hits.deny("session.max_per_tx", `${fmt(amount)} exceeds the session's max_per_tx of ${fmt(s.maxPerTx)}`);
  else
    hits.allow(
      "session.max_per_tx",
      `${fmt(amount)} is within the session's max_per_tx of ${fmt(s.maxPerTx)}`,
    );
  const total = sc.spentToday + amount;
  const detail = `${fmt(amount)} + ${fmt(sc.spentToday)} already spent against the session's max_per_day of ${fmt(s.maxPerDay)}`;
  if (total > s.maxPerDay) hits.deny("session.max_per_day", detail);
  else hits.allow("session.max_per_day", detail);

  if (s.allowedRecipients !== null) {
    if (cp.address !== null && s.allowedRecipients.has(cp.address)) {
      hits.allow("session.allowed_recipients", `${cp.address} is an allowed recipient of the session`);
    } else {
      hits.deny(
        "session.allowed_recipients",
        cp.address === null
          ? "The payee address is unknown, so the session's recipient list cannot be checked"
          : `${cp.address} is not an allowed recipient of the session`,
      );
    }
  }
  if (s.allowedContracts !== null && (kind === "escrow" || kind === "stream")) {
    const contract = normalizeAddress(ctx.intent.contract);
    if (contract !== null && s.allowedContracts.has(contract)) {
      hits.allow("session.allowed_contracts", `${contract} is an allowed contract of the session`);
    } else {
      hits.deny(
        "session.allowed_contracts",
        contract === null
          ? `${kind} payments must name the contract they call`
          : `${contract} is not an allowed contract of the session`,
      );
    }
  }
}

/**
 * Convert a decision to the wire shape (`PolicyDecision` in the API contract):
 * snake_case, ISO timestamps. `retry_at` is always present: the ISO time a
 * time-based denial lifts, or `null`.
 */
export function toPolicyDecisionWire(decision: Decision, id?: string): PolicyDecisionWire {
  const wire: PolicyDecisionWire = {
    outcome: decision.outcome,
    rule_hits: decision.ruleHits.map((h) => ({ rule: h.rule, effect: h.effect, detail: h.detail })),
    approvers_required: decision.approversRequired,
    policy_version: decision.policyVersion,
    evaluated_at: decision.evaluatedAt.toISOString(),
    retry_at: decision.retryAt === null ? null : decision.retryAt.toISOString(),
  };
  if (id !== undefined) wire.id = id;
  return wire;
}

/** Human sign-offs collected for a payment. */
export interface Grants {
  /** Distinct, unexpired approvals recorded for the payment. */
  approvals?: number;
  /** Whether the owner key itself signed the operation. */
  ownerSigned?: boolean;
}

/**
 * Whether a decision lets the payment proceed given the sign-offs collected
 * so far: `allow` always; `require_approval` once `approvals >=
 * approversRequired`; `require_owner` only when the owner signed; `deny`
 * never.
 */
export function isAuthorized(decision: Decision, grants: Grants = {}): boolean {
  switch (decision.outcome) {
    case "allow":
      return true;
    case "require_approval":
      return decision.approversRequired > 0 && (grants.approvals ?? 0) >= decision.approversRequired;
    case "require_owner":
      return grants.ownerSigned === true;
    default:
      return false;
  }
}
