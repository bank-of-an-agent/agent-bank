import type { Address, Hex } from "viem";
import type { ChainContracts } from "../types";
import type { Journal } from "./journal";
import type { ExecContext } from "./vm";

/** What simulated contracts can see of the rest of the simulated chain. */
export interface World {
  readonly chainId: number;
  readonly contracts: ChainContracts;
  readonly journal: Journal;
  /** Dispatch a call with `msg.sender = from`; returns the ABI-encoded return data or throws `SimRevert`. */
  call(ctx: ExecContext, from: Address, to: Address, value: bigint, data: Hex): Hex;
  /** Whether `address` has code (a deployed account or a simulated contract). */
  hasCode(address: Address): boolean;
  /** ERC-1271 `isValidSignature(hash, signature)` of a simulated account. */
  isValidSignature1271(account: Address, hash: Hex, signature: Hex): boolean;
  /** USDC balance (used by contracts that check balances). */
  balanceOf(token: Address, holder: Address): bigint;
}

/** OpenZeppelin `SignatureChecker.isValidSignatureNow`: ERC-1271 for contracts, strict ECDSA otherwise. */
export function isValidSignatureNow(
  world: World,
  signer: Address,
  hash: Hex,
  signature: Hex,
  recover: (hash: Hex, signature: Hex) => Address | null,
): boolean {
  if (world.hasCode(signer)) return world.isValidSignature1271(signer, hash, signature);
  const recovered = recover(hash, signature);
  return recovered !== null && recovered.toLowerCase() === signer.toLowerCase();
}
