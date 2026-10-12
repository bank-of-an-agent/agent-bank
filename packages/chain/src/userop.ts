import { AgentBankError, assertTestnet } from "@agentbank/core";
import { getAddress, type Address, type Hex } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { decodeCalls } from "./decode";
import { decodeNonce } from "./erc7579";
import { userOperationFromJson, type UserOperationV07 } from "./json";
import type {
  ChainContracts,
  DecodedCall,
  OperationSigner,
  PreparedOperation,
  UserOperationJson,
} from "./types";

/** ERC-4337 v0.7 user operation hash of a JSON-safe user operation (its signature is not hashed). */
export function hashUserOperation(
  userOp: UserOperationJson | UserOperationV07,
  chainId: number,
  entryPoint: Address,
): Hex {
  const op =
    typeof userOp.nonce === "string"
      ? userOperationFromJson(userOp as UserOperationJson)
      : (userOp as UserOperationV07);
  return getUserOperationHash({
    chainId,
    entryPointAddress: entryPoint,
    entryPointVersion: "0.7",
    userOperation: { ...op, signature: "0x" },
  });
}

/** Which signer path a nonce routes to: the validator in its key decides (Safe7579). */
export function signerForNonce(nonce: bigint, contracts: ChainContracts): OperationSigner | null {
  const { validator } = decodeNonce(nonce);
  if (validator === getAddress(contracts.smartSessions)) return "session";
  if (validator === getAddress(contracts.ownableValidator)) return "owner";
  return null;
}

/**
 * Validate an untrusted prepared operation against a gateway: chain, entry point, sender and the
 * signer path implied by the nonce. Returns the parsed user operation. Throws `invalid_request`
 * (or `mainnet_locked` / `unsupported_chain`).
 */
export function checkPreparedOperation(
  op: PreparedOperation,
  gateway: { chainId: number; contracts: ChainContracts },
): UserOperationV07 {
  if (typeof op !== "object" || op === null)
    throw new AgentBankError("invalid_request", "operation must be an object");
  assertTestnet(op.chainId);
  if (op.chainId !== gateway.chainId) {
    throw new AgentBankError(
      "invalid_request",
      `operation is for chain ${op.chainId}, gateway is ${gateway.chainId}`,
    );
  }
  if (getAddress(op.entryPoint) !== getAddress(gateway.contracts.entryPoint)) {
    throw new AgentBankError("invalid_request", "operation targets an unknown EntryPoint");
  }
  const userOp = userOperationFromJson(op.userOp);
  if (userOp.sender !== getAddress(op.account)) {
    throw new AgentBankError("invalid_request", "operation account does not match the user operation sender");
  }
  const signer = signerForNonce(userOp.nonce, gateway.contracts);
  if (signer === null || signer !== op.signer) {
    throw new AgentBankError("invalid_request", "operation nonce does not route to the declared signer");
  }
  return userOp;
}

/** Decode the calls of a (validated) prepared operation from its raw calldata. */
export function decodePreparedOperation(op: PreparedOperation, contracts: ChainContracts): DecodedCall[] {
  return decodeCalls(op.userOp.callData, { contracts, account: getAddress(op.account) });
}

/** Unix seconds now. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
