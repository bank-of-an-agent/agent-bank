import type { DecisionOutcome } from "@agentbank/core";

/**
 * Stable identifiers of every rule the evaluator can report in
 * `Decision.ruleHits` (`rule_hits` on the wire). They are part of the public
 * contract: dashboards, alerts, the audit log and agents key off them, so an
 * id is never renamed or reused for a different check.
 *
 * Structural checks (`policy.*`, `context.invalid`, `engine.error`, status,
 * asset and counterparty validity) only ever report `deny`. Configured policy,
 * mandate and session rules report `allow` when they were checked and passed,
 * and `deny` / `require_owner` / `require_approval` when they fire.
 */
export const RULE_IDS = [
  // structural
  "policy.missing",
  "policy.invalid",
  "policy.agent",
  "context.invalid",
  "engine.error",
  "agent.frozen",
  "org.frozen",
  "kinds.allowed",
  "asset",
  "counterparty.invalid",
  "refill.target",
  // counterparties
  "counterparties.denylist",
  "counterparties.allowlist",
  "counterparties.cooldown",
  "counterparties.caps.per_tx",
  "counterparties.caps.per_day",
  "counterparties.caps.per_month",
  // time
  "time_windows",
  // amount caps
  "limits.per_tx",
  "limits.per_day",
  "limits.per_week",
  "limits.per_month",
  // velocity
  "velocity.per_minute",
  "velocity.per_hour",
  "velocity.per_day",
  // AP2 mandate
  "mandate.agent",
  "mandate.asset",
  "mandate.not_yet_valid",
  "mandate.expired",
  "mandate.execution_date",
  "mandate.amount_range",
  "mandate.allowed_payees",
  "mandate.x402_domains",
  "mandate.budget",
  "mandate.max_occurrences",
  "mandate.recurrence",
  // session key scope
  "session.revoked",
  "session.expired",
  "session.asset",
  "session.max_per_tx",
  "session.max_per_day",
  "session.allowed_recipients",
  "session.allowed_contracts",
  // human controls
  "require_owner_above",
  "approvals",
] as const;

/** A stable rule identifier, e.g. `"limits.per_day"`. */
export type RuleId = (typeof RULE_IDS)[number];

/**
 * Severity of each outcome. The decision is the most severe outcome of all
 * rule hits: `deny` > `require_owner` > `require_approval` > `allow`.
 */
export const OUTCOME_SEVERITY: Readonly<Record<DecisionOutcome, number>> = Object.freeze({
  allow: 0,
  require_approval: 1,
  require_owner: 2,
  deny: 3,
});

/** Return the more severe of two outcomes. */
export function mostSevere(a: DecisionOutcome, b: DecisionOutcome): DecisionOutcome {
  return OUTCOME_SEVERITY[b] > OUTCOME_SEVERITY[a] ? b : a;
}
