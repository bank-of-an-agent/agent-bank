import { ManualClock, newId } from "@agentbank/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { USING_POSTGRES_SERVER } from "./support/database";
import { memoryHarness, postgresHarness, type Harness } from "./support/harness";
import { commandArbitrary, Simulation } from "./support/simulation";

/**
 * Phase 1 gate evidence: long randomized workloads (seeded, so reproducible) in which every
 * command is checked against the reference model and every balance, the zero-sum total and
 * the invariant report are re-verified at fixed intervals. "Zero drift" means the ledger and
 * the model never disagree on a single minor unit.
 */

const START = "2026-10-11T12:00:00Z";
const ACCOUNTS = 8;

async function consistencyRun(harness: Harness, operations: number, seed: number, checkEvery: number) {
  const commands = fc.sample(commandArbitrary(ACCOUNTS), { seed, numRuns: operations });
  const accounts = Array.from({ length: ACCOUNTS }, () => newId("account"));
  const vaults = Array.from({ length: ACCOUNTS }, () => newId("vault"));
  const sim = await Simulation.create(harness.ledger, harness.clock, accounts, vaults);
  const started = performance.now();
  let checks = 0;
  for (const [index, command] of commands.entries()) {
    await sim.run(command);
    if ((index + 1) % checkEvery === 0) {
      await sim.check();
      checks += 1;
    }
  }
  await sim.deepCheck(25);
  const report = await harness.ledger.verifyInvariants();
  const seconds = Math.round(performance.now() - started) / 1000;
  const outcomes = sim.summary();
  console.log(
    `[ledger consistency] ${harness.name}${harness.name === "postgres" ? (USING_POSTGRES_SERVER ? " (PostgreSQL server)" : " (PGlite)") : ""}: ` +
      `${operations} operations, seed ${seed}, ${checks + 1} full balance checks, ${seconds}s\n` +
      `  ledger: ${report.accounts} accounts, ${report.entries} entries, ${report.lines} lines, ${report.holds} holds, ` +
      `${report.violations.length} invariant violations, drift 0\n` +
      `  outcomes: ${JSON.stringify(outcomes)}`,
  );
  return { report, outcomes, sim };
}

describe("randomized consistency runs", () => {
  it("10,000 operations on InMemoryLedger reconcile with zero drift", async () => {
    const harness = await memoryHarness({ clock: new ManualClock(START) });
    const { report, outcomes } = await consistencyRun(harness, 10_000, 20_261_011, 250);
    expect(report.ok).toBe(true);
    expect(report.entries).toBeGreaterThan(5_000);
    expect(report.holds).toBeGreaterThan(1_000);
    for (const kind of [
      "deposit",
      "transfer",
      "hold",
      "post",
      "void",
      "expire",
      "reverse",
      "replay",
      "conflict",
    ]) {
      expect(outcomes[kind]?.ok ?? outcomes[kind]?.idempotency_conflict ?? 0).toBeGreaterThan(0);
    }
    expect(outcomes.reverse?.invalid_state ?? 0).toBeGreaterThan(0);
    expect(outcomes.payout?.insufficient_funds ?? 0).toBeGreaterThan(0);
  });

  it("1,000 operations on PostgresLedger reconcile with zero drift", async () => {
    const harness = await postgresHarness({ clock: new ManualClock(START) });
    try {
      const { report } = await consistencyRun(harness, 1_000, 1_011, 100);
      expect(report.ok).toBe(true);
      expect(report.entries).toBeGreaterThan(400);
    } finally {
      await harness.close();
    }
  });
});
