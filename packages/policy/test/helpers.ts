import { usdc, type OpenPaymentMandate, type PolicyDocumentInput } from "@agentbank/core";
import {
  compileMandate,
  compilePolicy,
  compileSessionScope,
  type CompiledPolicy,
  type Decision,
  type EvaluationContext,
  type EvaluationIntent,
  type SpendHistory,
} from "../src";
import type { SessionScopeInput } from "../src/session";

/** Monday 12 October 2026, 15:00 UTC. */
export const NOW = new Date("2026-10-12T15:00:00.000Z");

/**
 * A deterministic, well-formed agent id (`agt_` + 26-character ULID body), so
 * fixtures and fast-check universes are reproducible. Production code uses
 * `newId("agent")`, whose output these tests also exercise.
 */
export function agentId(n: number): string {
  return `agt_01J${String(n).padStart(23, "0")}`;
}

export const AGENT_ID = agentId(1);
export const OTHER_AGENT_ID = agentId(2);

export const ADDR = {
  alice: "0x1111111111111111111111111111111111111111",
  bob: "0x2222222222222222222222222222222222222222",
  carol: "0x3333333333333333333333333333333333333333",
  mallory: "0x4444444444444444444444444444444444444444",
  spendKey: "0x5dc0000000000000000000000000000000000001",
  escrow: "0xe5c0000000000000000000000000000000000001",
  stream: "0x57e0000000000000000000000000000000000001",
  zero: "0x0000000000000000000000000000000000000000",
} as const;

export const DOMAIN = "api.example-data.com";

/** USDC minor units from a decimal string. */
export const $ = (amount: string): bigint => usdc(amount);

export function history(overrides: Partial<SpendHistory> = {}): SpendHistory {
  return {
    spentLastDay: 0n,
    spentLastWeek: 0n,
    spentLastMonth: 0n,
    countLastMinute: 0,
    countLastHour: 0,
    countLastDay: 0,
    counterpartySpentLastDay: 0n,
    counterpartySpentLastMonth: 0n,
    counterpartyFirstSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export interface ContextOverrides extends Omit<Partial<EvaluationContext>, "intent" | "history" | "agent"> {
  intent?: Partial<EvaluationIntent>;
  history?: Partial<SpendHistory>;
  agent?: Partial<EvaluationContext["agent"]>;
}

/** A context for a 10.00 USDC transfer to alice by an active agent, with an old counterparty. */
export function context(overrides: ContextOverrides = {}): EvaluationContext {
  const { intent, history: h, agent, ...rest } = overrides;
  return {
    now: NOW,
    agent: { id: AGENT_ID, status: "active", spendKeyAddress: ADDR.spendKey, ...agent },
    org: { status: "active" },
    intent: {
      kind: "transfer",
      amount: $("10.00"),
      asset: "USDC",
      counterparty: { address: ADDR.alice },
      ...intent,
    },
    history: history(h),
    ...rest,
  };
}

export function x402(domain: string, amount = "0.10"): Partial<EvaluationIntent> {
  return { kind: "x402", amount: $(amount), counterparty: { x402Domain: domain, address: ADDR.bob } };
}

export function compile(doc: PolicyDocumentInput, version = 1): CompiledPolicy {
  return compilePolicy(doc, version);
}

/** The example policy from the design document. */
export const DESIGN_EXAMPLE: PolicyDocumentInput = {
  agent: AGENT_ID,
  asset: "USDC",
  limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
  counterparties: { mode: "allowlist", x402_domains: [DOMAIN], new_cooldown_minutes: 60 },
  velocity: { max_per_minute: 30 },
  approvals: [
    { above: "100.00", approvers: 1 },
    { above: "1000.00", approvers: 2 },
  ],
  max_balance: "500.00",
};

export function mandate(overrides: Partial<OpenPaymentMandate> = {}): OpenPaymentMandate {
  return {
    vct: "mandate.payment.open.1",
    constraints: [{ type: "payment.amount_range", currency: "USDC", max: 50_000_000 }],
    iat: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000),
    exp: Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000),
    agent_id: AGENT_ID,
    ...overrides,
  };
}

export function mandateContext(
  m: OpenPaymentMandate,
  spent = 0n,
  occurrences = 0,
  lastOccurrenceAt: Date | null = null,
) {
  return { mandate: compileMandate(m), spent, occurrences, lastOccurrenceAt };
}

export function sessionContext(
  scope: Partial<SessionScopeInput> = {},
  spentToday = 0n,
  revokedAt: Date | null = null,
) {
  return {
    scope: compileSessionScope({
      max_per_tx: "50.00",
      max_per_day: "100.00",
      expires_at: "2026-10-13T00:00:00Z",
      ...scope,
    }),
    spentToday,
    revokedAt,
  };
}

/** Effects of the hits for one rule id. */
export function effects(decision: Decision, rule: string): string[] {
  return decision.ruleHits.filter((h) => h.rule === rule).map((h) => h.effect);
}

/** Rule ids whose hits carry the decision's outcome (the reasons for it). */
export function reasons(decision: Decision): string[] {
  return decision.ruleHits.filter((h) => h.effect === decision.outcome).map((h) => h.rule);
}

export function deniedBy(decision: Decision): string[] {
  return decision.ruleHits.filter((h) => h.effect === "deny").map((h) => h.rule);
}
