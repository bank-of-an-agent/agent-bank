import {
  AgentBankError,
  mandateAmountToUsdcMinor,
  maxBig,
  minBig,
  OpenPaymentMandateSchema,
  type OpenPaymentMandate,
  type SessionScope,
} from "@agentbank/core";
import { counterpartySetOf } from "./counterparty";
import { classifyPayeeId, normalizeDomain } from "./normalize";
import { buildSessionScope, type SessionScopeOptions } from "./session";
import {
  COMPILED_MANDATE_FORMAT,
  type CompiledMandate,
  type CompiledPolicy,
  type CounterpartySet,
  type MandateFrequency,
} from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Tolerance subtracted from every recurrence period, for DST shifts (23-hour days) and scheduler jitter. */
export const RECURRENCE_TOLERANCE_MS = 2 * HOUR_MS;

/**
 * Minimum spacing between two payments under a mandate with an
 * `agent_recurrence` frequency: the shortest calendar period (a month is at
 * least 28 days, a quarter at least 89) minus {@link RECURRENCE_TOLERANCE_MS}.
 * Enforced only when the caller passes `lastOccurrenceAt`.
 */
export const RECURRENCE_MIN_SPACING_MS: Readonly<Record<MandateFrequency, number>> = Object.freeze({
  ON_DEMAND: 0,
  DAILY: DAY_MS - RECURRENCE_TOLERANCE_MS,
  WEEKLY: 7 * DAY_MS - RECURRENCE_TOLERANCE_MS,
  BIWEEKLY: 14 * DAY_MS - RECURRENCE_TOLERANCE_MS,
  MONTHLY: 28 * DAY_MS - RECURRENCE_TOLERANCE_MS,
  QUARTERLY: 89 * DAY_MS - RECURRENCE_TOLERANCE_MS,
  ANNUALLY: 365 * DAY_MS - RECURRENCE_TOLERANCE_MS,
});

/** Leeway for a mandate whose `iat` is slightly ahead of the evaluator's clock. */
export const MANDATE_IAT_LEEWAY_MS = 5 * 60_000;

function invalid(detail: string): AgentBankError {
  return new AgentBankError("mandate_invalid", detail);
}

function parseInstant(value: string, path: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`${path} is not a valid timestamp`);
  return date;
}

/**
 * Compile an AP2 v0.2 open Payment Mandate (Agent Bank profile) for
 * evaluation. The mandate is validated with `OpenPaymentMandateSchema`;
 * amounts are converted to USDC minor units (`USD` cents × 10,000, `USDC`
 * micro-units as is). Repeated constraints of one type are intersected.
 *
 * Constraint semantics (all must hold for a payment under the mandate):
 * - `payment.amount_range`: `min <= amount <= max`.
 * - `payment.allowed_payees`: the payee matches one listed id. Each id is
 *   classified by shape (address, `agt_` agent id, dotted host name, else
 *   ERC-8004 id); x402 payments match by host name, others by address, agent
 *   id or ERC-8004 id.
 * - `agentbank.x402_domains`: the payment is an x402 payment to a listed host.
 * - `payment.budget`: cumulative spend including this payment `<= max`.
 * - `payment.agent_recurrence`: at most `max_occurrences` payments, spaced by
 *   at least {@link RECURRENCE_MIN_SPACING_MS} of the frequency.
 * - `payment.execution_date`: `not_before <= now <= not_after`.
 *
 * Throws `AgentBankError("mandate_invalid")` for schema failures, malformed
 * payee ids or domains, an empty amount range or an empty execution window.
 */
export function compileMandate(mandate: OpenPaymentMandate): CompiledMandate {
  const parsed = OpenPaymentMandateSchema.safeParse(mandate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    );
    throw invalid(`Invalid mandate: ${issues.join("; ")}`);
  }
  const source = parsed.data;
  let range: { min: bigint; max: bigint } | null = null;
  let budget: bigint | null = null;
  let frequency: MandateFrequency | null = null;
  let maxOccurrences: number | null = null;
  let notBefore: Date | null = null;
  let notAfter: Date | null = null;
  const payeeSets: CounterpartySet[] = [];
  const x402DomainSets: ReadonlySet<string>[] = [];

  for (const [i, constraint] of source.constraints.entries()) {
    const path = `constraints[${i}]`;
    switch (constraint.type) {
      case "payment.amount_range": {
        const max = mandateAmountToUsdcMinor(constraint.max, constraint.currency);
        const min =
          constraint.min === undefined ? 0n : mandateAmountToUsdcMinor(constraint.min, constraint.currency);
        range = range === null ? { min, max } : { min: maxBig(range.min, min), max: minBig(range.max, max) };
        break;
      }
      case "payment.allowed_payees": {
        const entries = constraint.allowed.map((payee, j) => {
          const id = classifyPayeeId(payee.id);
          if (id === null) throw invalid(`${path}.allowed[${j}].id is not a valid payee id`);
          return id;
        });
        payeeSets.push(counterpartySetOf(entries));
        break;
      }
      case "payment.budget": {
        const max = mandateAmountToUsdcMinor(constraint.max, constraint.currency);
        budget = budget === null ? max : minBig(budget, max);
        break;
      }
      case "payment.agent_recurrence": {
        const f = constraint.frequency;
        if (frequency === null || RECURRENCE_MIN_SPACING_MS[f] > RECURRENCE_MIN_SPACING_MS[frequency]) {
          frequency = f;
        }
        if (constraint.max_occurrences !== undefined) {
          maxOccurrences =
            maxOccurrences === null
              ? constraint.max_occurrences
              : Math.min(maxOccurrences, constraint.max_occurrences);
        }
        break;
      }
      case "payment.execution_date": {
        if (constraint.not_before !== undefined) {
          const t = parseInstant(constraint.not_before, `${path}.not_before`);
          if (notBefore === null || t > notBefore) notBefore = t;
        }
        if (constraint.not_after !== undefined) {
          const t = parseInstant(constraint.not_after, `${path}.not_after`);
          if (notAfter === null || t < notAfter) notAfter = t;
        }
        break;
      }
      case "agentbank.x402_domains": {
        const domains = constraint.allowed.map((raw, j) => {
          const domain = normalizeDomain(raw);
          if (domain === null) throw invalid(`${path}.allowed[${j}] is not a valid domain`);
          return domain;
        });
        x402DomainSets.push(new Set(domains));
        break;
      }
    }
  }

  if (range !== null && range.min > range.max) {
    throw invalid("The payment.amount_range constraints leave no valid amount");
  }
  if (notBefore !== null && notAfter !== null && notBefore > notAfter) {
    throw invalid("The payment.execution_date constraints leave no valid time");
  }
  return Object.freeze({
    format: COMPILED_MANDATE_FORMAT,
    agentId: source.agent_id,
    issuedAt: new Date(source.iat * 1000),
    expiresAt: new Date(source.exp * 1000),
    amountRange: range === null ? null : Object.freeze(range),
    payeeSets: Object.freeze(payeeSets),
    x402DomainSets: Object.freeze(x402DomainSets),
    budget,
    recurrence: frequency === null ? null : Object.freeze({ frequency, maxOccurrences }),
    executionWindow: notBefore === null && notAfter === null ? null : Object.freeze({ notBefore, notAfter }),
    source,
  });
}

function isCompiledMandate(m: OpenPaymentMandate | CompiledMandate): m is CompiledMandate {
  return (m as CompiledMandate).format === COMPILED_MANDATE_FORMAT;
}

/**
 * Session-key scope for a session that acts under a mandate: the
 * intersection of the mandate's constraints and the policy's caps (tightest
 * wins).
 *
 * - `max_per_tx` = min(policy `per_tx`, every policy window cap,
 *   `require_owner_above`, mandate `amount_range.max`, remaining budget).
 * - `max_per_day` = min(policy `per_day`, `per_week`, `per_month`, remaining
 *   budget), and `max_per_tx` never exceeds it.
 * - `allowed_recipients` = policy allowlist addresses (allowlist mode) ∩ the
 *   addresses of every payee constraint that lists only addresses (payee
 *   lists that name agents, domains or ERC-8004 ids cannot be resolved here
 *   and do not narrow the on-chain list), minus denylisted addresses.
 * - `expires_at` = min(now + ttl (default 24 h), mandate `exp`, `not_after`).
 *
 * Throws `mandate_expired` when the mandate (or its execution window) has
 * already ended, and `mandate_invalid` when it names a different agent than
 * the policy.
 */
export function mandateToSessionScope(
  mandate: OpenPaymentMandate | CompiledMandate,
  policy: CompiledPolicy,
  now: Date,
  options: number | SessionScopeOptions = {},
): SessionScope {
  const m = isCompiledMandate(mandate) ? mandate : compileMandate(mandate);
  if (policy.agent !== null && policy.agent !== m.agentId) {
    throw invalid(`The mandate is granted to ${m.agentId} but the policy belongs to ${policy.agent}`);
  }
  const notAfter = m.executionWindow?.notAfter ?? null;
  const ends = notAfter !== null && notAfter < m.expiresAt ? notAfter : m.expiresAt;
  if (ends.getTime() <= now.getTime()) {
    throw new AgentBankError("mandate_expired", `The mandate ended at ${ends.toISOString()}`);
  }
  const opts: SessionScopeOptions = typeof options === "number" ? { ttlSeconds: options } : options;
  let remaining: bigint | null = null;
  if (m.budget !== null) {
    const spent = opts.mandateSpent ?? 0n;
    remaining = m.budget > spent ? m.budget - spent : 0n;
  }
  const addressSets = m.payeeSets
    .filter((s) => s.agentIds.size === 0 && s.erc8004Ids.size === 0 && s.x402Domains.size === 0)
    .map((s) => s.addresses);
  return buildSessionScope(policy, now, opts, {
    perTx: [m.amountRange?.max ?? null, remaining],
    perDay: [remaining],
    recipientSets: addressSets,
    endsAt: ends,
  });
}
