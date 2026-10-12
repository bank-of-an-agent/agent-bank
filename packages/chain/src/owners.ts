import { AgentBankError } from "@agentbank/core";
import { encodeFunctionData, getAddress, zeroAddress, type Address } from "viem";
import { ownableValidatorAbi, safeAbi } from "./abis";
import type { Call, ChainContracts } from "./types";

/**
 * Owner key rotation.
 *
 * An account has two owner records that must agree: the Safe's owner (Safe-native `execTransaction`,
 * the owner's exit path) and the OwnableValidator's owner set (owner user operations). Both are
 * linked lists headed by the sentinel `0x…01`; removing an entry needs its predecessor.
 *
 * - Safe `swapOwner(prev, old, new)`: `prev` is the entry before `old` in `getOwners()` order (the
 *   sentinel for the first).
 * - OwnableValidator `addOwner` inserts at the head; `removeOwner(prev, owner)` needs `prev` to point
 *   to `owner` and reverts with `CannotRemoveOwner()` while `ownerCount == threshold`, so a 1-of-1
 *   validator must add the new owner before removing the old one.
 */

/** Sentinel heading Safe and SentinelList linked lists. */
export const SENTINEL_OWNERS: Address = "0x0000000000000000000000000000000000000001";

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The entry before `entry` in a sentinel-headed list given in traversal order. */
function predecessor(list: readonly Address[], entry: Address, what: string): Address {
  const index = list.findIndex((a) => same(a, entry));
  if (index < 0) throw new AgentBankError("invalid_request", `${entry} is not in the ${what}`);
  return index === 0 ? SENTINEL_OWNERS : getAddress(list[index - 1] as Address);
}

function assertOwnerAddress(address: Address, account: Address, field: string): void {
  if (same(address, zeroAddress) || same(address, SENTINEL_OWNERS) || same(address, account)) {
    throw new AgentBankError("invalid_request", `${field} is not a valid owner`);
  }
}

/** Input of {@link ownerRotationCalls}. */
export interface OwnerRotationInput {
  account: Address;
  contracts: ChainContracts;
  /** The owner key being replaced (it signs the rotation). */
  currentOwner: Address;
  newOwner: Address;
  /** The Safe's owners in `getOwners()` order (default `[currentOwner]`). */
  safeOwners?: readonly Address[];
  /** The OwnableValidator's owners for the account in `getOwners(account)` order (default `[currentOwner]`). */
  validatorOwners?: readonly Address[];
}

/**
 * Rotate the owner key as ONE owner operation signed by the current owner:
 * `account.swapOwner(prev, current, new)` (a self-call), `OwnableValidator.addOwner(new)`, then
 * `OwnableValidator.removeOwner(prev', current)`. The operation validates against the current owner
 * and leaves both records on the new key. Calls to the OwnableValidator pass `AgentPolicyHook` only if
 * it is allowlisted (`policyHookConfig` adds it as a `Generic` contract).
 */
export function ownerRotationCalls(input: OwnerRotationInput): Call[] {
  const account = getAddress(input.account);
  const currentOwner = getAddress(input.currentOwner);
  const newOwner = getAddress(input.newOwner);
  assertOwnerAddress(newOwner, account, "newOwner");
  if (same(newOwner, currentOwner))
    throw new AgentBankError("invalid_request", "newOwner equals currentOwner");
  const safeOwners = input.safeOwners ?? [currentOwner];
  const validatorOwners = input.validatorOwners ?? [currentOwner];
  if (safeOwners.some((o) => same(o, newOwner)) || validatorOwners.some((o) => same(o, newOwner))) {
    throw new AgentBankError("invalid_request", "newOwner is already an owner");
  }
  const safePrev = predecessor(safeOwners, currentOwner, "Safe owners");
  // After addOwner(new) the validator list is [new, ...validatorOwners] (head insertion).
  const validatorPrev = predecessor([newOwner, ...validatorOwners], currentOwner, "OwnableValidator owners");
  return [
    {
      to: account,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "swapOwner",
        args: [safePrev, currentOwner, newOwner],
      }),
    },
    {
      to: input.contracts.ownableValidator,
      data: encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [newOwner] }),
    },
    {
      to: input.contracts.ownableValidator,
      data: encodeFunctionData({
        abi: ownableValidatorAbi,
        functionName: "removeOwner",
        args: [validatorPrev, currentOwner],
      }),
    },
  ];
}

/** Input of {@link safeNativeOwnerSyncCalls}. */
export interface OwnerSyncInput {
  account: Address;
  contracts: ChainContracts;
  owners: {
    /** The Safe's owners now (after e.g. a guardian recovery): the target set. */
    safe: readonly Address[];
    /** The OwnableValidator's owners for the account now, in `getOwners(account)` order. */
    validator: readonly Address[];
  };
}

/**
 * The OwnableValidator updates that bring its owner set in line with the Safe's owners, for the new
 * Safe owner to execute over the Safe-native path (one `execTransaction` per call, operation CALL,
 * `to` = the OwnableValidator, in order) after the Safe owner changed without the validator, e.g. a
 * guardian recovery. Owner user operations need it: they validate against the OwnableValidator, so
 * until then the old key still signs them and the new one cannot.
 *
 * Adds come first (each at the head of the validator's list), then removals with the predecessor at
 * that point, so `ownerCount` never drops to the threshold while removing. Assumes the validator's
 * threshold is at most the number of Safe owners (it is 1 for Agent Bank accounts). Returns `[]`
 * when the sets already match. Throws `invalid_request` if the validator has no owners for the
 * account (not installed: `addOwner` would revert with `NotInitialized`).
 */
export function safeNativeOwnerSyncCalls(input: OwnerSyncInput): Call[] {
  const account = getAddress(input.account);
  const target = input.owners.safe.map((o) => getAddress(o));
  if (target.length === 0) throw new AgentBankError("invalid_request", "the Safe must have an owner");
  for (const o of target) assertOwnerAddress(o, account, "Safe owner");
  let list = input.owners.validator.map((o) => getAddress(o));
  if (list.length === 0) {
    throw new AgentBankError(
      "invalid_request",
      "the OwnableValidator has no owners for the account (not installed)",
    );
  }
  const calls: Call[] = [];
  for (const owner of target) {
    if (list.some((o) => same(o, owner))) continue;
    calls.push({
      to: input.contracts.ownableValidator,
      data: encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [owner] }),
    });
    list = [owner, ...list];
  }
  for (const owner of [...list]) {
    if (target.some((o) => same(o, owner))) continue;
    const prev = predecessor(list, owner, "OwnableValidator owners");
    calls.push({
      to: input.contracts.ownableValidator,
      data: encodeFunctionData({
        abi: ownableValidatorAbi,
        functionName: "removeOwner",
        args: [prev, owner],
      }),
    });
    list = list.filter((o) => !same(o, owner));
  }
  return calls;
}
