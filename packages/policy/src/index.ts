/**
 * `@agentbank/policy`: the deterministic policy engine.
 *
 * Pure TypeScript with no I/O, no clock and no randomness: everything time-
 * or history-dependent arrives in the evaluation context, so the same input
 * always yields the same decision. No language model is in the decision path.
 *
 * - {@link compilePolicy} / {@link evaluate}: compile a policy document once,
 *   evaluate payment intents against it (fail closed).
 * - {@link classifyChange}: tighten / loosen / mixed classification of policy
 *   changes, with {@link requiresOwnerSignatureForChange} (owner authorization,
 *   including any `auto_save` edit) and {@link effectiveAt} (1-hour delay for
 *   loosening).
 * - {@link compileMandate} / {@link mandateToSessionScope}: AP2 mandates as
 *   extra deny rules and as session-key scopes.
 * - {@link sessionScopeFromPolicy} / {@link compileSessionScope}: session-key
 *   scopes for the on-chain Smart Sessions policies.
 * - Auto-save calculators: {@link incomeSplit}, {@link roundUp},
 *   {@link excessAboveMaxBalance}, {@link scheduledDue}.
 */

export { RULE_IDS, OUTCOME_SEVERITY, mostSevere, type RuleId } from "./rules";
export {
  COMPILED_MANDATE_FORMAT,
  COMPILED_POLICY_FORMAT,
  COMPILED_SESSION_SCOPE_FORMAT,
  type AccountStatus,
  type ApprovalStep,
  type CompiledAutoSave,
  type CompiledCounterpartyCap,
  type CompiledMandate,
  type CompiledPolicy,
  type CompiledScheduledSave,
  type CompiledSessionScope,
  type CounterpartyMode,
  type CounterpartySet,
  type Decision,
  type EvaluationContext,
  type EvaluationIntent,
  type IntentCounterparty,
  type MandateContext,
  type MandateFrequency,
  type PolicyRuleHit,
  type SaveTarget,
  type ScheduleEvery,
  type SessionContext,
  type SpendHistory,
} from "./types";
export { compilePolicy } from "./compile";
export { evaluate, isAuthorized, toPolicyDecisionWire, type Grants } from "./evaluate";
export {
  classifyChange,
  effectiveAt,
  requiresOwnerSignature,
  requiresOwnerSignatureForChange,
  type ChangeClassification,
  type ChangeDirection,
  type ChangeKind,
  type PolicyChange,
} from "./classify";
export {
  compileMandate,
  mandateToSessionScope,
  MANDATE_IAT_LEEWAY_MS,
  RECURRENCE_MIN_SPACING_MS,
  RECURRENCE_TOLERANCE_MS,
} from "./mandate";
export {
  compileSessionScope,
  sessionScopeFromPolicy,
  MAX_SESSION_CONTRACTS,
  MAX_SESSION_RECIPIENTS,
  UNBOUNDED_SESSION_AMOUNT,
  type SessionScopeInput,
  type SessionScopeOptions,
} from "./session";
export {
  excessAboveMaxBalance,
  incomeSplit,
  roundUp,
  scheduledDue,
  SCHEDULE_PERIOD_MS,
  type AutoSaveRule,
  type SaveAction,
  type ScheduledSaveAction,
} from "./auto-save";
export {
  classifyPayeeId,
  isZeroAddress,
  normalizeAddress,
  normalizeAgentId,
  normalizeDomain,
  normalizeErc8004Id,
  normalizeIdentifier,
  type IdentifierType,
} from "./normalize";
export {
  compareTimeWindows,
  compileTimeWindows,
  isWithinTimeWindows,
  localMinuteOfWeek,
  nextTimeWindowOpening,
  utcOffsetMinutes,
  MINUTES_PER_WEEK,
  type CompiledTimeWindows,
  type TimeWindowComparison,
  type TimeWindowInput,
  type ZoneWindows,
} from "./time-windows";
