import { getAddress, type Address, type Hex } from "viem";
import type { ExactEvmAuthorization } from "./protocol";

/**
 * EIP-3009 `TransferWithAuthorization`: the message an x402 `exact` EVM
 * payment signs. USDC verifies it on-chain in `transferWithAuthorization`.
 *
 * @packageDocumentation
 */

/** EIP-712 types of `TransferWithAuthorization` (identical to USDC's and `@x402/evm`'s). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** EIP-712 domain of an EIP-3009 token (USDC on Base Sepolia: name "USDC", version "2"). */
export interface Eip3009Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** Build the EIP-712 typed data to sign for an EIP-3009 authorization. */
export function transferWithAuthorizationTypedData(
  domain: Eip3009Domain,
  authorization: ExactEvmAuthorization,
) {
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: getAddress(domain.verifyingContract) as Address,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: getAddress(authorization.from) as Address,
      to: getAddress(authorization.to) as Address,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as Hex,
    },
  };
}
