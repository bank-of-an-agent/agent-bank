import { AgentBankError } from "@agentbank/core";
import { isAddressEqual, size, slice, toFunctionSelector, type Hex } from "viem";
import type { Call, ChainContracts } from "./types";

/** USDC `permit` selectors: `(v, r, s)` and `bytes signature` overloads. */
export const PERMIT_SELECTORS: readonly Hex[] = [
  toFunctionSelector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"),
  toFunctionSelector("permit(address,address,uint256,uint256,bytes)"),
];

/**
 * Throw `invalid_request` unless a keeper may relay `call`: any call to an Agent Bank contract
 * (escrow, streams, vaults, executors) or a USDC `permit` (e.g. a spend key's permit attached after
 * setup). Never native value, never any other USDC function. The relayer has no authority over funds:
 * the contracts and the permit's signer decide.
 */
export function assertRelayableCall(call: Call, contracts: ChainContracts): void {
  if ((call.value ?? 0n) !== 0n)
    throw new AgentBankError("invalid_request", "relayCall never sends native value");
  const agentBank = [
    contracts.escrow,
    contracts.streams,
    contracts.vaults,
    contracts.topUpExecutor,
    contracts.sweepExecutor,
  ];
  if (agentBank.some((a) => a !== undefined && isAddressEqual(a, call.to))) return;
  if (isAddressEqual(call.to, contracts.usdc)) {
    if (size(call.data) >= 4 && PERMIT_SELECTORS.includes(slice(call.data, 0, 4))) return;
    throw new AgentBankError("invalid_request", "relayCall only relays USDC permit calls");
  }
  throw new AgentBankError("invalid_request", "relayCall only targets Agent Bank contracts and USDC permit");
}
