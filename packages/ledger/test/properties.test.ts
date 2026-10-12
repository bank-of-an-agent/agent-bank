import { ManualClock, newId } from "@agentbank/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { memoryHarness, postgresHarness } from "./support/harness";
import { commandArbitrary, Simulation } from "./support/simulation";

/**
 * Property-based tests. Every step of every random workload is checked against a reference
 * model (predicted outcome, exact lines written, balances), so these properties hold after
 * each command, not just at the end:
 * - entries always balance and all balances sum to zero;
 * - no pocket is ever negative and reserve pockets equal their pending holds;
 * - replaying a request returns an identical result, reusing its key for another request fails;
 * - verifyInvariants() is always clean;
 * - InMemoryLedger and PostgresLedger produce identical outcomes and balances.
 */

const START = "2026-10-11T12:00:00Z";
const ACCOUNTS = 3;

function ids(): { accounts: string[]; vaults: string[] } {
  return {
    accounts: Array.from({ length: ACCOUNTS }, () => newId("account")),
    vaults: Array.from({ length: ACCOUNTS }, () => newId("vault")),
  };
}

describe("ledger properties", () => {
  it("InMemoryLedger matches the reference model after every command", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(commandArbitrary(ACCOUNTS), { minLength: 1, maxLength: 80, size: "max" }),
        async (commands) => {
          const harness = await memoryHarness({ clock: new ManualClock(START) });
          const { accounts, vaults } = ids();
          const sim = await Simulation.create(harness.ledger, harness.clock, accounts, vaults);
          for (const command of commands) {
            await sim.run(command);
            await sim.check();
          }
          await sim.deepCheck();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("PostgresLedger and InMemoryLedger agree on every outcome and balance", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(commandArbitrary(ACCOUNTS), { minLength: 1, maxLength: 40, size: "max" }),
        async (commands) => {
          const memory = await memoryHarness({ clock: new ManualClock(START) });
          const postgres = await postgresHarness({ clock: new ManualClock(START) });
          try {
            const { accounts, vaults } = ids();
            const a = await Simulation.create(memory.ledger, memory.clock, accounts, vaults);
            const b = await Simulation.create(postgres.ledger, postgres.clock, accounts, vaults);
            for (const [index, command] of commands.entries()) {
              const expected = await a.run(command);
              expect(await b.run(command)).toBe(expected);
              if (index % 10 === 9) await b.check();
            }
            await a.deepCheck();
            await b.deepCheck(5);
            expect(b.snapshot()).toEqual(a.snapshot());
            for (const ref of a.refs.values()) {
              expect(await postgres.ledger.balance(ref)).toBe(await memory.ledger.balance(ref));
            }
            const [reportA, reportB] = [
              await memory.ledger.verifyInvariants(),
              await postgres.ledger.verifyInvariants(),
            ];
            expect({ ...reportB, checkedAt: null }).toEqual({ ...reportA, checkedAt: null });
          } finally {
            await postgres.close();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
