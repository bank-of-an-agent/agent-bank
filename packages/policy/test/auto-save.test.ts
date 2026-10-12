import { AgentBankError } from "@agentbank/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { excessAboveMaxBalance, incomeSplit, roundUp, scheduledDue, SCHEDULE_PERIOD_MS } from "../src";
import { $, compile, NOW } from "./helpers";

const VAULT = "vault:vlt_01JABCDEFGHJKMNPQRSTVWXYZ0";
const policy = compile({
  max_balance: "500.00",
  auto_save: {
    income_split: { bps: 1_000, to: VAULT },
    excess_sweep: { to: VAULT },
    round_up: { to_nearest: "1.00", to: "treasury" },
    scheduled: [
      { amount: "10.00", every: "day", to: "treasury" },
      { amount: "50.00", every: "week", to: VAULT },
      { amount: "0", every: "month", to: "treasury" },
    ],
  },
});
const bare = compile({});

describe("incomeSplit", () => {
  it("saves a share of inbound payments, rounding down", () => {
    expect(incomeSplit(policy, $("10.00"))).toEqual({ rule: "income_split", amount: $("1.00"), to: VAULT });
    expect(incomeSplit(policy, 15n)).toEqual({ rule: "income_split", amount: 1n, to: VAULT });
    expect(incomeSplit(policy, 9n)).toBeNull();
    expect(incomeSplit(bare, $("10.00"))).toBeNull();
    expect(() => incomeSplit(policy, -1n)).toThrow(AgentBankError);
  });
});

describe("roundUp", () => {
  it("rounds outbound payments up to the next multiple", () => {
    expect(roundUp(policy, $("3.20"))).toEqual({ rule: "round_up", amount: $("0.80"), to: "treasury" });
    expect(roundUp(policy, $("3.00"))).toBeNull();
    expect(roundUp(policy, 0n)).toBeNull();
    expect(roundUp(bare, $("3.20"))).toBeNull();
    expect(() => roundUp(policy, 1 as unknown as bigint)).toThrow(/minor units/);
  });

  it("always lands on a multiple and never saves a full unit", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (outbound) => {
        const action = roundUp(policy, outbound);
        const saved = action?.amount ?? 0n;
        expect((outbound + saved) % $("1.00")).toBe(0n);
        expect(saved < $("1.00")).toBe(true);
      }),
    );
  });
});

describe("excessAboveMaxBalance", () => {
  it("sweeps anything above max_balance", () => {
    expect(excessAboveMaxBalance(policy, $("500.00"))).toBeNull();
    expect(excessAboveMaxBalance(policy, $("650.25"))).toEqual({
      rule: "excess_sweep",
      amount: $("150.25"),
      to: VAULT,
    });
    expect(excessAboveMaxBalance(compile({ max_balance: "1" }), $("3"))).toEqual({
      rule: "excess_sweep",
      amount: $("2"),
      to: "treasury",
    });
    expect(excessAboveMaxBalance(bare, $("1000000"))).toBeNull();
  });
});

describe("scheduledDue", () => {
  it("returns every rule that never ran, skipping zero amounts", () => {
    const due = scheduledDue(policy, null, NOW);
    expect(due.map((a) => [a.key, a.amount, a.to])).toEqual([
      ["day:10000000:treasury", $("10.00"), "treasury"],
      [`week:50000000:${VAULT}`, $("50.00"), VAULT],
    ]);
    expect(due[0]?.nextRunAt).toEqual(new Date(NOW.getTime() + SCHEDULE_PERIOD_MS.day));
  });

  it("uses one last-run time for all rules", () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * SCHEDULE_PERIOD_MS.day);
    expect(scheduledDue(policy, twoDaysAgo, NOW).map((a) => a.every)).toEqual(["day"]);
    expect(scheduledDue(policy, new Date(NOW.getTime() - 1000), NOW)).toEqual([]);
  });

  it("tracks last-run times per rule key", () => {
    const due = scheduledDue(
      policy,
      {
        "day:10000000:treasury": new Date(NOW.getTime() - SCHEDULE_PERIOD_MS.day),
        [`week:50000000:${VAULT}`]: new Date(NOW.getTime() - SCHEDULE_PERIOD_MS.week + 1),
      },
      NOW,
    );
    expect(due.map((a) => a.every)).toEqual(["day"]);
    expect(scheduledDue(policy, {}, NOW)).toHaveLength(2);
    expect(scheduledDue(bare, null, NOW)).toEqual([]);
  });

  it("rejects invalid times", () => {
    expect(() => scheduledDue(policy, null, new Date(Number.NaN))).toThrow(/now/);
    expect(() => scheduledDue(policy, new Date(Number.NaN), NOW)).toThrow(/lastRunAt/);
  });
});
