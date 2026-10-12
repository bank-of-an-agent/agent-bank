import type { ChainGateway } from "@agentbank/chain";
import {
  BaseError,
  encodeFunctionData,
  ExecutionRevertedError,
  RawContractError,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * ERC-1271 verification exactly as USDC (FiatToken v2.2 `SignatureChecker`) performs it for a
 * payer that has code: a contract wallet, or an EOA carrying an EIP-7702 delegation. FiatToken
 * then never uses `ecrecover`: it calls `isValidSignature(digest, signature)` and accepts only
 * if the call succeeds and returns at least 32 bytes whose first word is the magic value
 * `0x1626ba7e` (left-aligned, zero-padded).
 *
 * `ChainGateway.verifySignature` is not used for this on JSON-RPC gateways: viem's `verifyHash`
 * falls back to ECDSA recovery when ERC-1271 fails, which accepts plain signatures of
 * 7702-delegated EOAs that USDC rejects (seen on Base Sepolia, where the well-known Anvil
 * development addresses carry delegations).
 */

/** `bytes32(IERC1271.isValidSignature.selector)`: the only first word FiatToken accepts. */
export const ERC1271_MAGIC_WORD: Hex = "0x1626ba7e00000000000000000000000000000000000000000000000000000000";

const erc1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

/** Whether `address` (which has code) accepts `signature` over `hash`. Throws when the chain cannot answer. */
export type ContractSignatureVerifier = (input: {
  address: Address;
  hash: Hex;
  signature: Hex;
}) => Promise<boolean>;

/** FiatToken's acceptance rule for the return data of `isValidSignature`. */
export function isErc1271Accepted(data: Hex | undefined): boolean {
  return data !== undefined && size(data) >= 32 && slice(data, 0, 32).toLowerCase() === ERC1271_MAGIC_WORD;
}

function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((e) => e instanceof ExecutionRevertedError || e instanceof RawContractError) !== null
  );
}

/**
 * `isValidSignature` through `eth_call`. A revert or an empty/other answer means "rejected";
 * any other failure (timeout, RPC error) throws so the caller fails closed.
 */
export function erc1271ViaCall(client: Pick<PublicClient, "call">): ContractSignatureVerifier {
  return async ({ address, hash, signature }) => {
    try {
      const { data } = await client.call({
        to: address,
        data: encodeFunctionData({
          abi: erc1271Abi,
          functionName: "isValidSignature",
          args: [hash, signature],
        }),
      });
      return isErc1271Accepted(data);
    } catch (error) {
      if (isRevert(error)) return false;
      throw error;
    }
  };
}

/**
 * The verifier for a gateway: a direct `isValidSignature` call when the gateway exposes a viem
 * client (the EVM gateway), otherwise `verifySignature`, which for the simulator is ERC-1271
 * only for addresses with code (no ECDSA fallback).
 */
export function contractSignatureVerifierFor(gateway: ChainGateway): ContractSignatureVerifier {
  const client = (gateway as { publicClient?: Pick<PublicClient, "call"> }).publicClient;
  if (client && typeof client.call === "function") return erc1271ViaCall(client);
  return (input) => gateway.verifySignature(input);
}
