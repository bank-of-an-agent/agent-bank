import type { ApprovalStep } from "./types";

/**
 * Approvers an amount needs under an approval ladder, with the highest
 * threshold it exceeds (`amount > above`). `{ approvers: 0, above: 0n }`
 * when it exceeds none.
 */
export function approversFor(
  steps: readonly ApprovalStep[],
  amount: bigint,
): { approvers: number; above: bigint } {
  let result = { approvers: 0, above: 0n };
  for (const step of steps) {
    if (amount > step.above) result = { approvers: step.approvers, above: step.above };
    else break;
  }
  return result;
}
