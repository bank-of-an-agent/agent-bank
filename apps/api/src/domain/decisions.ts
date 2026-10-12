import { newId, type DecisionInternal } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { PolicyDecisionRow } from "../db/rows";
import { one } from "../db/sql";

/** Record a policy decision (from the co-signer, a dry run, or an API-level refusal such as screening). */
export async function recordDecision(
  tx: SqlClient,
  input: {
    decision: Pick<
      DecisionInternal,
      "outcome" | "rule_hits" | "approvers_required" | "policy_version" | "evaluated_at"
    > & {
      id?: string | undefined;
    };
    agentId: string;
    paymentId: string | null;
    source: PolicyDecisionRow["source"];
    now: Date;
  },
): Promise<PolicyDecisionRow> {
  const d = input.decision;
  const id =
    d.id && /^dec_[0-9A-HJKMNP-TV-Z]{26}$/.test(d.id) ? d.id : newId("decision", input.now.getTime());
  const existing = await one<PolicyDecisionRow>(tx, "SELECT * FROM policy_decision WHERE id = $1", [id]);
  const evaluatedAt = Number.isNaN(Date.parse(d.evaluated_at)) ? input.now : new Date(d.evaluated_at);
  if (existing) {
    // The co-signer may reuse a decision id; keep ours unique.
    return recordDecision(tx, { ...input, decision: { ...d, id: undefined } });
  }
  const row = await one<PolicyDecisionRow>(
    tx,
    `INSERT INTO policy_decision (id, payment_id, agent_id, policy_version, outcome, rule_hits_json, approvers_required,
                                  source, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      id,
      input.paymentId,
      input.agentId,
      d.policy_version,
      d.outcome,
      d.rule_hits,
      d.approvers_required,
      input.source,
      evaluatedAt,
    ],
  );
  return row as PolicyDecisionRow;
}

/** A synthetic API-side denial (e.g. sanctions screening) in decision form. */
export function apiDenial(rule: string, detail: string, now: Date): DecisionInternal {
  return {
    id: newId("decision", now.getTime()),
    outcome: "deny",
    rule_hits: [{ rule, effect: "deny", detail }],
    approvers_required: 0,
    policy_version: 0,
    evaluated_at: now.toISOString(),
  };
}

/** Human-readable reason of a denial from its rule hits. */
export function denialReason(decision: Pick<DecisionInternal, "rule_hits">): string {
  const hits = decision.rule_hits.filter((h) => h.effect === "deny");
  const first = hits[0] ?? decision.rule_hits[0];
  return first ? `${first.rule}: ${first.detail}`.slice(0, 500) : "denied by policy";
}
