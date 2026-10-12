import type { CosignInternal, DecisionInternal, DecisionOutcome, RuleHit } from "@agentbank/core";
import { mostSevere, toPolicyDecisionWire, type Decision } from "@agentbank/policy";

/**
 * A decision as the co-signer returns it: the policy engine's decision with
 * the co-signer's own checks (`cosigner.*` rule ids: bindings, session,
 * operation, intent match, …) merged in. The outcome is the most severe of
 * all hits; `retryAt` survives only for denials that are purely time-based.
 */
export interface FinalDecision {
  outcome: DecisionOutcome;
  ruleHits: RuleHit[];
  approversRequired: number;
  policyVersion: number;
  evaluatedAt: Date;
  retryAt: Date | null;
}

export const OUTCOME_ORDER: Readonly<Record<DecisionOutcome, number>> = {
  allow: 0,
  require_approval: 1,
  require_owner: 2,
  deny: 3,
};

export function hit(rule: string, effect: RuleHit["effect"], detail: string): RuleHit {
  return { rule, effect, detail };
}

/** Hits that stop a payment (anything but `allow` and `info`). */
export function blocking(hits: readonly RuleHit[]): RuleHit[] {
  return hits.filter((h) => h.effect !== "allow" && h.effect !== "info");
}

export function outcomeOf(hits: readonly RuleHit[], base: DecisionOutcome = "allow"): DecisionOutcome {
  let outcome = base;
  for (const h of blocking(hits)) outcome = mostSevere(outcome, h.effect as DecisionOutcome);
  return outcome;
}

/** A refusal decided before (or instead of) policy evaluation. */
export function refusal(hits: RuleHit[], now: Date, policyVersion = 0): FinalDecision {
  return {
    outcome: outcomeOf(hits, "deny"),
    ruleHits: hits,
    approversRequired: 0,
    policyVersion,
    evaluatedAt: now,
    retryAt: null,
  };
}

/** The more severe of two decisions over the same intent (ties keep `a`). */
export function stricter(a: Decision, b: Decision): Decision {
  return OUTCOME_ORDER[b.outcome] > OUTCOME_ORDER[a.outcome] ? b : a;
}

/** Merge the co-signer's own hits into a policy decision. */
export function merge(policy: Decision, extra: readonly RuleHit[], now: Date): FinalDecision {
  const outcome = outcomeOf(extra, policy.outcome);
  return {
    outcome,
    ruleHits: [...policy.ruleHits.map((h) => hit(h.rule, h.effect, h.detail)), ...extra],
    approversRequired: outcome === "require_approval" ? policy.approversRequired : 0,
    policyVersion: policy.policyVersion,
    evaluatedAt: now,
    retryAt: outcome === "deny" && blocking(extra).length === 0 ? policy.retryAt : null,
  };
}

/** Wire shape (`DecisionInternal`), via the policy package's own mapping (incl. `retry_at`). */
export function toWire(decision: FinalDecision, id: string): DecisionInternal {
  return toPolicyDecisionWire(
    {
      outcome: decision.outcome,
      ruleHits: decision.ruleHits as unknown as Decision["ruleHits"],
      approversRequired: decision.approversRequired,
      policyVersion: decision.policyVersion,
      evaluatedAt: decision.evaluatedAt,
      retryAt: decision.retryAt,
    },
    id,
  ) as DecisionInternal;
}

/**
 * ADR 0012: an API-attested approval with at least the required number of
 * *distinct* approvers satisfies `require_approval`, and only that (never a
 * denial or `require_owner`). The co-signer still enforces every hard limit.
 */
export function applyApproval(decision: FinalDecision, approval: CosignInternal["approval"]): FinalDecision {
  if (decision.outcome !== "require_approval") return decision;
  const approvers = new Set((approval?.approved_by ?? []).map((a) => a.trim()).filter((a) => a.length > 0));
  const required = decision.approversRequired;
  if (approval && required > 0 && approvers.size >= required) {
    return {
      ...decision,
      outcome: "allow",
      ruleHits: [
        ...decision.ruleHits,
        hit(
          "approvals",
          "allow",
          `Approved by ${approvers.size} distinct approver(s) in approval ${approval.approval_id} (attested by the API, ADR 0012)`,
        ),
      ],
    };
  }
  return {
    ...decision,
    ruleHits: [
      ...decision.ruleHits,
      hit(
        "approvals",
        "info",
        approval
          ? `Approval ${approval.approval_id} has ${approvers.size} distinct approver(s); ${required} required`
          : `${required} approver(s) required and no approval was attached`,
      ),
    ],
  };
}
