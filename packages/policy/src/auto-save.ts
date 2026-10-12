import { AgentBankError } from "@agentbank/core";
import type { CompiledPolicy, SaveTarget, ScheduleEvery } from "./types";

/**
 * Auto-save rules (`auto_save` in the policy). Pure calculators: they return
 * the save actions a rule calls for, and the caller (API worker / co-signer)
 * moves the funds into `pocket:savings` or a vault pocket. Every action moves
 * money between the org's own accounts only. Fractions round down, so a rule
 * never saves more than it says.
 */

/** Which auto-save rule produced an action. */
export type AutoSaveRule = "income_split" | "round_up" | "excess_sweep" | "scheduled";

/** Move `amount` (minor units, always positive) to `to`. */
export interface SaveAction {
  readonly rule: AutoSaveRule;
  readonly amount: bigint;
  readonly to: SaveTarget;
}

/** A due scheduled save, with the information needed to track the rule. */
export interface ScheduledSaveAction extends SaveAction {
  readonly rule: "scheduled";
  /** Stable rule key; persist `lastRunAt` per key. */
  readonly key: string;
  readonly every: ScheduleEvery;
  /** When the rule is next due if this action is executed at `now`. */
  readonly nextRunAt: Date;
}

const DAY_MS = 86_400_000;
/** Rolling periods of scheduled saves, as for policy windows: day 24 h, week 7 d, month 30 d. */
export const SCHEDULE_PERIOD_MS: Readonly<Record<ScheduleEvery, number>> = Object.freeze({
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
});

function requireAmount(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new AgentBankError("invalid_amount", `${name} must be a non-negative bigint of minor units`);
  }
}

/**
 * Income split: save `bps` basis points of an inbound payment (rounded down).
 * `null` when the rule is not configured or the share rounds to zero.
 */
export function incomeSplit(policy: CompiledPolicy, inbound: bigint): SaveAction | null {
  requireAmount(inbound, "inbound");
  const rule = policy.autoSave?.incomeSplit;
  if (!rule) return null;
  const amount = (inbound * BigInt(rule.bps)) / 10_000n;
  return amount > 0n ? Object.freeze({ rule: "income_split", amount, to: rule.to }) : null;
}

/**
 * Round-up: round an outbound payment up to the next multiple of
 * `to_nearest` and save the difference. `null` when the rule is not
 * configured or the payment is already a multiple.
 */
export function roundUp(policy: CompiledPolicy, outbound: bigint): SaveAction | null {
  requireAmount(outbound, "outbound");
  const rule = policy.autoSave?.roundUp;
  if (!rule) return null;
  const remainder = outbound % rule.toNearest;
  if (remainder === 0n) return null;
  return Object.freeze({ rule: "round_up", amount: rule.toNearest - remainder, to: rule.to });
}

/**
 * Excess sweep: anything above `max_balance` goes to `auto_save.excess_sweep.to`,
 * or to the org treasury when no destination is configured (the design's
 * default for `max_balance`). `null` without `max_balance` or when the balance
 * does not exceed it.
 */
export function excessAboveMaxBalance(policy: CompiledPolicy, balance: bigint): SaveAction | null {
  requireAmount(balance, "balance");
  if (policy.maxBalance === null || balance <= policy.maxBalance) return null;
  return Object.freeze({
    rule: "excess_sweep",
    amount: balance - policy.maxBalance,
    to: policy.autoSave?.excessSweep?.to ?? "treasury",
  });
}

/**
 * Scheduled saves that are due at `now`: a rule is due when it never ran or
 * at least one period has passed since it last ran. Missed periods are not
 * caught up (one action per rule at most).
 *
 * @param lastRunAt When the rules last ran: one time for every rule, or a
 *   record keyed by `CompiledScheduledSave.key` (missing keys never ran).
 */
export function scheduledDue(
  policy: CompiledPolicy,
  lastRunAt: Date | null | Readonly<Record<string, Date | null | undefined>>,
  now: Date,
): ScheduledSaveAction[] {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AgentBankError("invalid_request", "now must be a valid Date");
  }
  const at = now.getTime();
  const due: ScheduledSaveAction[] = [];
  for (const rule of policy.autoSave?.scheduled ?? []) {
    const last = lastRunAt === null || lastRunAt instanceof Date ? lastRunAt : (lastRunAt[rule.key] ?? null);
    if (last !== null && Number.isNaN(last.getTime())) {
      throw new AgentBankError("invalid_request", `lastRunAt for ${rule.key} is not a valid Date`);
    }
    const period = SCHEDULE_PERIOD_MS[rule.every];
    if (rule.amount === 0n || (last !== null && at - last.getTime() < period)) continue;
    due.push(
      Object.freeze({
        rule: "scheduled",
        key: rule.key,
        amount: rule.amount,
        to: rule.to,
        every: rule.every,
        nextRunAt: new Date(at + period),
      }),
    );
  }
  return due;
}
