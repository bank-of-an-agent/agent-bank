import { AgentBankError } from "@agentbank/core";
import { encodeFunctionData, getAddress, isHex, size, type Address, type Hex } from "viem";
import { agentAttestationRegistryAbi } from "./abis";
import type { AttestationRootInfo, Call, ChainContracts } from "./types";

/**
 * Calls to `AgentAttestationRegistry` (private-proof roots) and helpers shared by both gateways.
 * Builders check only that values fit their ABI types; the registry's own rules (field order,
 * epochs, validity window, leaf count, caller) are the contract's to enforce, so a gateway reports
 * the contract's error.
 */

const UINT64_MAX = 2n ** 64n - 1n;
const UINT32_MAX = 2 ** 32 - 1;

/** A gateway method needs an Agent Bank contract that is not configured on this chain. */
export class ContractNotConfiguredError extends AgentBankError {
  readonly contract: keyof ChainContracts;

  constructor(contract: keyof ChainContracts, chainId: number) {
    super("invalid_state", `${contract} is not configured on chain ${chainId}`, { contract, chainId });
    this.name = "ContractNotConfiguredError";
    this.contract = contract;
  }
}

function bytes32(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new AgentBankError("invalid_request", `${name} must be 32 bytes of 0x-prefixed hex`);
  }
  return value.toLowerCase() as Hex;
}

function uint64(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new AgentBankError("invalid_request", `${name} must be a uint64 bigint`);
  }
  return value;
}

function uint32(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new AgentBankError("invalid_request", `${name} must be a uint32 integer`);
  }
  return value;
}

/** The arguments of `publishRoot`. */
export interface AttestationRootFields {
  root: Hex;
  epoch: bigint;
  snapshotAt: bigint;
  validUntil: bigint;
  leafCount: number;
}

/** `registry.publishRoot(root, epoch, snapshotAt, validUntil, leafCount)` (attester only). */
export function publishAttestationRootCall(input: AttestationRootFields & { registry: Address }): Call {
  return {
    to: getAddress(input.registry),
    data: encodeFunctionData({
      abi: agentAttestationRegistryAbi,
      functionName: "publishRoot",
      args: [
        bytes32(input.root, "root"),
        uint64(input.epoch, "epoch"),
        uint64(input.snapshotAt, "snapshotAt"),
        uint64(input.validUntil, "validUntil"),
        uint32(input.leafCount, "leafCount"),
      ],
    }),
  };
}

/** `registry.revokeRoots(roots)` (attester or owner). At least one root. */
export function revokeAttestationRootsCall(input: { registry: Address; roots: readonly Hex[] }): Call {
  if (!Array.isArray(input.roots) || input.roots.length === 0)
    throw new AgentBankError("invalid_request", "at least one root is required");
  return {
    to: getAddress(input.registry),
    data: encodeFunctionData({
      abi: agentAttestationRegistryAbi,
      functionName: "revokeRoots",
      args: [input.roots.map((r, i) => bytes32(r, `roots[${i}]`))],
    }),
  };
}

/** `registry.setAttester(newAttester)`: the owner (governance multisig) rotates the attester key. */
export function setAttesterCall(input: { registry: Address; attester: Address }): Call {
  return {
    to: getAddress(input.registry),
    data: encodeFunctionData({
      abi: agentAttestationRegistryAbi,
      functionName: "setAttester",
      args: [getAddress(input.attester)],
    }),
  };
}

/** Check a root argument (32 bytes of hex); returns it lowercase. */
export function parseAttestationRoot(root: Hex): Hex {
  return bytes32(root, "root");
}

/** The registry's `RootInfo` struct as viem decodes it. */
export interface RootInfoStruct {
  epoch: bigint;
  snapshotAt: bigint;
  publishedAt: bigint;
  validUntil: bigint;
  leafCount: number;
  revoked: boolean;
}

/**
 * `rootInfo` + `isValidRoot` as an {@link AttestationRootInfo}; `null` for a root never published
 * (the registry stores a non-zero epoch for every published root).
 */
export function toAttestationRootInfo(info: RootInfoStruct, valid: boolean): AttestationRootInfo | null {
  if (info.epoch === 0n) return null;
  return {
    epoch: info.epoch,
    snapshotAt: info.snapshotAt,
    publishedAt: info.publishedAt,
    validUntil: info.validUntil,
    leafCount: info.leafCount,
    revoked: info.revoked,
    valid,
  };
}

function formatArg(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatArg).join(", ")}]`;
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value);
  return String(value);
}

/**
 * A decoded custom error as `Name(arg, ...)`: integers in base 10, addresses checksummed, bytes
 * as given. Both gateways report registry reverts in this form (e.g. `EpochNotIncreasing(4, 4)`).
 */
export function formatContractError(errorName: string, args: readonly unknown[] = []): string {
  return `${errorName}(${args.map(formatArg).join(", ")})`;
}
