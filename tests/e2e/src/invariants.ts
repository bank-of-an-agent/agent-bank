import { suspenseRef } from "@agentbank/ledger";
import { expect } from "vitest";
import type { Stack } from "./stack";

/**
 * The global invariants the scenario suite asserts after every scenario (design § Reconciliation
 * and Data model):
 *
 * - `ledger.verifyInvariants()` is clean (entries balance, cached balances match the journal, no
 *   negative pocket, holds and reversals consistent);
 * - the reconciler's own invariants hold (each chain event matches at most one entry, orphaned
 *   entries reversed, every settled payment has an allow decision or an approval, every settled
 *   payment's hold is posted);
 * - the on-chain USDC balance of every watched address equals what the ledger expects (the sum of
 *   the pockets located there);
 * - `sys:suspense` is zero (nothing unexplained moved).
 */
export async function assertGlobalInvariants(stack: Stack, context = ""): Promise<void> {
  const where = context ? ` (${context})` : "";
  // Let any in-flight settlement finish before snapshotting.
  await stack.pump();

  const ledger = await stack.ledger.verifyInvariants();
  expect(ledger.violations, `ledger invariants${where}: ${JSON.stringify(ledger.violations)}`).toEqual([]);
  expect(ledger.ok, `ledger invariants ok${where}`).toBe(true);

  const recon = await stack.reconciler.verify();
  expect(recon.violations, `reconciliation invariants${where}: ${JSON.stringify(recon.violations)}`).toEqual(
    [],
  );
  expect(recon.ok, `reconciliation invariants ok${where}`).toBe(true);

  const rows = await stack.expectedOnChain();
  for (const row of rows) {
    expect(
      row.onchain,
      `on-chain USDC == ledger expected for ${row.address}${where} (on-chain ${row.onchain}, expected ${row.expected})`,
    ).toBe(row.expected);
  }

  const suspense = await stack.ledger.balance(suspenseRef("USDC"));
  expect(suspense, `sys:suspense is zero${where}`).toBe(0n);
}

/** Current `sys:suspense` balance (USDC minor units). */
export function suspenseBalance(stack: Stack): Promise<bigint> {
  return stack.ledger.balance(suspenseRef("USDC"));
}
