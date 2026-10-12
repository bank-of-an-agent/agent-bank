import { AgentBankError } from "@agentbank/core";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type { UserOperation } from "viem/account-abstraction";
import type { JsonValue, UserOperationJson } from "./types";

/** A fully-populated v0.7 user operation with bigint fields (viem's shape). */
export type UserOperationV07 = UserOperation<"0.7">;

const UINT_RE = /^(0|[1-9][0-9]*)$/;

/** Parse a base-10 unsigned integer string (as used in JSON-safe types) into a bigint. */
export function parseUint(value: string, field = "value"): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new AgentBankError("invalid_request", `${field} must be a base-10 unsigned integer string`);
  }
  return BigInt(value);
}

function optionalUint(value: string | null, field: string): bigint | undefined {
  return value === null ? undefined : parseUint(value, field);
}

function hexField(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length % 2 !== 0) {
    throw new AgentBankError("invalid_request", `${field} must be 0x-prefixed hex`);
  }
  return value;
}

function addressField(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new AgentBankError("invalid_request", `${field} must be an address`);
  }
  return getAddress(value);
}

/** Convert a viem v0.7 user operation into its JSON-safe form. */
export function userOperationToJson(op: UserOperationV07): UserOperationJson {
  return {
    sender: getAddress(op.sender),
    nonce: op.nonce.toString(),
    factory: op.factory ? getAddress(op.factory) : null,
    factoryData: op.factory ? (op.factoryData ?? "0x") : null,
    callData: op.callData,
    callGasLimit: op.callGasLimit.toString(),
    verificationGasLimit: op.verificationGasLimit.toString(),
    preVerificationGas: op.preVerificationGas.toString(),
    maxFeePerGas: op.maxFeePerGas.toString(),
    maxPriorityFeePerGas: op.maxPriorityFeePerGas.toString(),
    paymaster: op.paymaster ? getAddress(op.paymaster) : null,
    paymasterVerificationGasLimit: op.paymaster ? (op.paymasterVerificationGasLimit ?? 0n).toString() : null,
    paymasterPostOpGasLimit: op.paymaster ? (op.paymasterPostOpGasLimit ?? 0n).toString() : null,
    paymasterData: op.paymaster ? (op.paymasterData ?? "0x") : null,
    signature: op.signature,
  };
}

/**
 * Convert (and validate) a JSON-safe user operation into viem's bigint form. Throws
 * `invalid_request` on malformed input, so it can be applied to untrusted payloads.
 */
export function userOperationFromJson(json: UserOperationJson): UserOperationV07 {
  if (typeof json !== "object" || json === null) {
    throw new AgentBankError("invalid_request", "user operation must be an object");
  }
  const op: UserOperationV07 = {
    sender: addressField(json.sender, "userOp.sender"),
    nonce: parseUint(json.nonce, "userOp.nonce"),
    callData: hexField(json.callData, "userOp.callData"),
    callGasLimit: parseUint(json.callGasLimit, "userOp.callGasLimit"),
    verificationGasLimit: parseUint(json.verificationGasLimit, "userOp.verificationGasLimit"),
    preVerificationGas: parseUint(json.preVerificationGas, "userOp.preVerificationGas"),
    maxFeePerGas: parseUint(json.maxFeePerGas, "userOp.maxFeePerGas"),
    maxPriorityFeePerGas: parseUint(json.maxPriorityFeePerGas, "userOp.maxPriorityFeePerGas"),
    signature: hexField(json.signature, "userOp.signature"),
  };
  if (json.factory !== null && json.factory !== undefined) {
    op.factory = addressField(json.factory, "userOp.factory");
    op.factoryData = hexField(json.factoryData ?? "0x", "userOp.factoryData");
  }
  if (json.paymaster !== null && json.paymaster !== undefined) {
    op.paymaster = addressField(json.paymaster, "userOp.paymaster");
    op.paymasterVerificationGasLimit =
      optionalUint(json.paymasterVerificationGasLimit, "userOp.paymasterVerificationGasLimit") ?? 0n;
    op.paymasterPostOpGasLimit =
      optionalUint(json.paymasterPostOpGasLimit, "userOp.paymasterPostOpGasLimit") ?? 0n;
    op.paymasterData = hexField(json.paymasterData ?? "0x", "userOp.paymasterData");
  }
  return op;
}

/**
 * Convert a decoded ABI value into a JSON-safe value: bigints become base-10 strings, addresses
 * are checksummed, arrays and tuples (objects) are converted recursively.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
    case "boolean":
      return value;
    case "string":
      return isAddress(value, { strict: false }) && value.length === 42 ? getAddress(value) : value;
    case "object": {
      if (Array.isArray(value)) return value.map(toJsonValue);
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonValue(v);
      return out;
    }
    default:
      throw new TypeError(`toJsonValue: unsupported ${typeof value}`);
  }
}
