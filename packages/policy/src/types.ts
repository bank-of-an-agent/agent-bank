import type {
  AssetCode,
  DecisionOutcome,
  OpenPaymentMandate,
  PaymentKind,
  PolicyDocument,
  RuleHit,
  SessionScope,
} from "@agentbank/core";
import type { IdentifierType } from "./normalize";
import type { RuleId } from "./rules";
import type { CompiledTimeWindows } from "./time-windows";

/** Brand carried by every {@link CompiledPolicy}; the evaluator refuses anything else. */
export const COMPILED_POLICY_FORMAT = "agentbank.policy.compiled.v1";
/** Brand carried by every {@link CompiledMandate}. */
export const COMPILED_MANDATE_FORMAT = "agentbank.mandate.compiled.v1";
/** Brand carried by every {@link CompiledSessionScope}. */
export const COMPILED_SESSION_SCOPE_FORMAT = "agentbank.session_scope.compiled.v1";

/** Counterparty mode of a policy (see {@link CompiledPolicy.counterparties}). */
export type CounterpartyMode = "open" | "allowlist" | "denylist";

/** Normalized counterparty identifiers, one set per identifier type. */
export interface CounterpartySet {
  /** Lowercase `0x` addresses. */
  readonly addresses: ReadonlySet<string>;
  /** Agent Bank agent ids, exact. */
  readonly agentIds: ReadonlySet<string>;
  /** ERC-8004 ids, lowercase. */
  readonly erc8004Ids: ReadonlySet<string>;
  /** x402 host names, lowercase without a trailing dot. */
  readonly x402Domains: ReadonlySet<string>;
}

/** A per-counterparty cap (`counterparties.caps[]`), matched by one normalized identifier. */
export interface CompiledCounterpartyCap {
  readonly type: IdentifierType;
  readonly value: string;
  readonly perTx: bigint | null;
  readonly perDay: bigint | null;
  readonly perMonth: bigint | null;
}

/**
 * One step of the approval ladder. Steps are sorted by `above` ascending and
 * `approvers` never decreases from one step to the next (a lower threshold
 * that asks for more approvers carries upward), so the approvers of the
 * highest threshold an amount exceeds is also the maximum of all exceeded
 * thresholds.
 */
export interface ApprovalStep {
  /** Minor units; the step applies when `amount > above`. */
  readonly above: bigint;
  readonly approvers: number;
}

/** Where auto-saved funds go: the org treasury or a vault (`vault:vlt_…`). */
export type SaveTarget = "treasury" | `vault:${string}`;

/** Period of a scheduled auto-save rule. Rolling: day = 24 h, week = 7 d, month = 30 d. */
export type ScheduleEvery = "day" | "week" | "month";

/** A compiled scheduled auto-save rule. */
export interface CompiledScheduledSave {
  /** Stable key derived from the rule's content, for tracking `lastRunAt` per rule. */
  readonly key: string;
  readonly amount: bigint;
  readonly every: ScheduleEvery;
  readonly to: SaveTarget;
}

/** Compiled `auto_save` rules. They move money between the org's own accounts only. */
export interface CompiledAutoSave {
  readonly incomeSplit: { readonly bps: number; readonly to: SaveTarget } | null;
  readonly excessSweep: { readonly to: SaveTarget } | null;
  readonly roundUp: { readonly toNearest: bigint; readonly to: SaveTarget } | null;
  readonly scheduled: readonly CompiledScheduledSave[];
}

/**
 * A policy document compiled for evaluation: amounts parsed once to `bigint`
 * minor units, identifiers normalized, time windows expanded to per-minute
 * tables, approval thresholds normalized. Produced only by `compilePolicy`;
 * immutable and safe to cache and share.
 *
 * `null` caps and limits mean "not configured" (unbounded).
 */
export interface CompiledPolicy {
  readonly format: typeof COMPILED_POLICY_FORMAT;
  /** Policy version this was compiled from (`policy.version`). */
  readonly version: number;
  /** Agent the policy is bound to, when the document names one. */
  readonly agent: string | null;
  readonly asset: AssetCode;
  /** Decimals of `asset` (6 for USDC). */
  readonly decimals: number;
  readonly limits: {
    readonly perTx: bigint | null;
    readonly perDay: bigint | null;
    readonly perWeek: bigint | null;
    readonly perMonth: bigint | null;
  };
  readonly counterparties: {
    readonly mode: CounterpartyMode;
    /** The allowlist; `null` unless `mode` is `allowlist`. */
    readonly allow: CounterpartySet | null;
    /** Effective denylist: `deny.*`, plus the top-level lists when `mode` is `denylist`. */
    readonly deny: CounterpartySet;
    /** First-time counterparty cooling period in minutes; 0 when not configured. */
    readonly cooldownMinutes: number;
    readonly caps: readonly CompiledCounterpartyCap[];
  };
  readonly velocity: {
    readonly perMinute: number | null;
    readonly perHour: number | null;
    readonly perDay: number | null;
  };
  /**
   * `null` = no time restriction. (The schema requires at least one window
   * when `time_windows` is present; windows that allow no minute at all would
   * deny everything.)
   */
  readonly timeWindows: CompiledTimeWindows | null;
  readonly maxBalance: bigint | null;
  readonly approvals: readonly ApprovalStep[];
  readonly requireOwnerAbove: bigint | null;
  /** `null` = every payment kind is allowed. */
  readonly allowedKinds: ReadonlySet<PaymentKind> | null;
  readonly autoSave: CompiledAutoSave | null;
  /** The validated document (defaults applied) this was compiled from. */
  readonly source: PolicyDocument;
}

/** AP2 `payment.agent_recurrence` frequencies. */
export type MandateFrequency =
  "ON_DEMAND" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";

/**
 * An AP2 open Payment Mandate compiled for evaluation. Repeated constraints
 * of the same type are intersected (every constraint must hold): the
 * narrowest amount range, the smallest budget and occurrence count, the
 * latest `not_before` and earliest `not_after`; payee and x402-domain
 * constraints are kept as separate sets that must each be satisfied.
 */
export interface CompiledMandate {
  readonly format: typeof COMPILED_MANDATE_FORMAT;
  readonly agentId: string;
  readonly issuedAt: Date;
  /** The mandate is invalid at and after this instant (`exp`). */
  readonly expiresAt: Date;
  /** USDC minor units; `min` is 0 when the mandate sets none. */
  readonly amountRange: { readonly min: bigint; readonly max: bigint } | null;
  readonly payeeSets: readonly CounterpartySet[];
  readonly x402DomainSets: readonly ReadonlySet<string>[];
  /** Cumulative budget in USDC minor units. */
  readonly budget: bigint | null;
  readonly recurrence: {
    readonly frequency: MandateFrequency;
    readonly maxOccurrences: number | null;
  } | null;
  /** Inclusive execution window. */
  readonly executionWindow: { readonly notBefore: Date | null; readonly notAfter: Date | null } | null;
  readonly source: OpenPaymentMandate;
}

/** A session-key scope compiled for evaluation. */
export interface CompiledSessionScope {
  readonly format: typeof COMPILED_SESSION_SCOPE_FORMAT;
  readonly asset: AssetCode;
  readonly maxPerTx: bigint;
  readonly maxPerDay: bigint;
  /** Lowercase addresses; `null` = unrestricted. */
  readonly allowedRecipients: ReadonlySet<string> | null;
  /** Lowercase addresses; `null` = unrestricted. */
  readonly allowedContracts: ReadonlySet<string> | null;
  /** The session key is invalid at and after this instant. */
  readonly expiresAt: Date;
  readonly source: SessionScope;
}

/** Status of an agent or org. Anything other than `active` is treated as frozen. */
export type AccountStatus = "active" | "frozen";

/**
 * Who a payment goes to. Provide every identifier the caller has resolved
 * for the payee (they must all describe the same party): the address that
 * actually receives the funds (decoded from the operation by the co-signer),
 * the agent id and ERC-8004 id it maps to, and for x402 the host name of the
 * paid resource (`new URL(resource).hostname`, no port).
 */
export interface IntentCounterparty {
  address?: string | null;
  agentId?: string | null;
  erc8004Id?: string | null;
  x402Domain?: string | null;
}

/** The payment being evaluated. */
export interface EvaluationIntent {
  kind: PaymentKind;
  /** Amount in minor units of `asset`; must be positive. */
  amount: bigint;
  asset: string;
  counterparty: IntentCounterparty;
  /**
   * For `escrow` and `stream`: the contract the operation calls, checked
   * against the session's `allowed_contracts`.
   */
  contract?: string | null;
}

/**
 * Spend history in rolling windows ending at `now` (day = 24 h, week = 7 d,
 * month = 30 d), **excluding** the intent being evaluated. Sums must include
 * pending (held or submitted) outflows as well as settled ones, and the
 * caller must serialize evaluations per agent, otherwise concurrent payments
 * could jointly exceed a cap.
 */
export interface SpendHistory {
  spentLastDay: bigint;
  spentLastWeek: bigint;
  spentLastMonth: bigint;
  /** Payments started in the last 60 s / 60 min / 24 h. */
  countLastMinute: number;
  countLastHour: number;
  countLastDay: number;
  /** Outflows to this counterparty (aggregated across all its identifiers). */
  counterpartySpentLastDay: bigint;
  counterpartySpentLastMonth: bigint;
  /**
   * When the co-signer first saw this counterparty in any intent, including
   * denied ones (so a cooling period can elapse); `null` if never.
   */
  counterpartyFirstSeenAt: Date | null;
}

/** A mandate the payment runs under, with its usage so far (excluding this intent). */
export interface MandateContext {
  mandate: CompiledMandate;
  /** Cumulative spend under the mandate, in USDC minor units. */
  spent: bigint;
  /** Payments made under the mandate so far. */
  occurrences: number;
  /** Time of the latest payment under the mandate, for recurrence spacing. */
  lastOccurrenceAt?: Date | null;
}

/** The session key that will sign the operation, with its spend so far. */
export interface SessionContext {
  scope: CompiledSessionScope;
  /** Spend counted against the scope's `max_per_day` (excluding this intent). */
  spentToday: bigint;
  revokedAt?: Date | null;
}

/** Everything time- or history-dependent the evaluator needs. */
export interface EvaluationContext {
  /** Evaluation time. The evaluator never reads the clock. */
  now: Date;
  agent: {
    id: string;
    status: AccountStatus;
    /** The agent's x402 spend-key address; required for `refill` payments. */
    spendKeyAddress?: string | null;
  };
  org: { status: AccountStatus };
  intent: EvaluationIntent;
  history: SpendHistory;
  mandate?: MandateContext | null;
  session?: SessionContext | null;
}

/** A rule hit with a typed rule id. Structurally a `RuleHit` from `@agentbank/core`. */
export interface PolicyRuleHit extends RuleHit {
  readonly rule: RuleId;
}

/** Deterministic decision of the policy engine. */
export interface Decision {
  readonly outcome: DecisionOutcome;
  /** Every rule evaluated, in evaluation order, with its effect. */
  readonly ruleHits: readonly PolicyRuleHit[];
  /** Approvers needed when `outcome` is `require_approval`; otherwise 0. */
  readonly approversRequired: number;
  /** Version of the policy evaluated; 0 when there was none. */
  readonly policyVersion: number;
  /** Equal to `context.now`. */
  readonly evaluatedAt: Date;
  /**
   * For a denial caused only by time-based rules (cooling period, time
   * windows, mandate start or recurrence spacing): the earliest time worth
   * retrying. Advisory; re-evaluation is authoritative. Otherwise `null`.
   */
  readonly retryAt: Date | null;
}
