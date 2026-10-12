import { getAddress, isAddress } from "viem";

/**
 * Early withdrawal from a locked vault. Before the unlock date only the vault
 * owner (the org owner key) can release funds, by signing TimeLockVaults'
 * EIP-712 `EarlyWithdrawal`; the API carries that signature in an owner
 * operation. The API describes what to sign in its `owner_signature_required`
 * problem (`typed_data`); the console checks it against what the owner asked
 * for and signs a structure it builds itself, never the API's object.
 */

/** EIP-712 domain name and version of the `TimeLockVaults` contract. */
export const TIME_LOCK_VAULTS_EIP712 = { name: "AgentBank TimeLockVaults", version: "1" } as const;

export const EARLY_WITHDRAWAL_TYPES = {
  EarlyWithdrawal: [
    { name: "vaultId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The API prepares deadlines 15 minutes out; anything beyond an hour is refused. */
const MAX_DEADLINE_SECONDS = 3600;

export interface EarlyWithdrawalTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: typeof EARLY_WITHDRAWAL_TYPES;
  primaryType: "EarlyWithdrawal";
  message: { vaultId: bigint; amount: bigint; nonce: bigint; deadline: bigint };
}

export interface ExpectedWithdrawal {
  /** Deployment chain id (`GET /v1/meta`). */
  chainId: number;
  /** The vault's `contract_address`. */
  contract: string | null;
  /** The vault's `onchain_id`. */
  onchainId: string | null;
  /** The amount the owner entered, in USDC minor units. */
  amountMinor: bigint;
  /** Unix seconds. */
  now: number;
}

function uint(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]{1,78}$/.test(value)) return BigInt(value);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validate the API's description of the early withdrawal and build the typed
 * data to sign. Refuses anything that is not exactly the withdrawal the owner
 * asked for: another contract, chain, vault or amount, or a far deadline.
 */
export function earlyWithdrawalTypedData(
  described: unknown,
  expected: ExpectedWithdrawal,
): { ok: true; typedData: EarlyWithdrawalTypedData } | { ok: false; reason: string } {
  const root = record(described);
  const domain = record(root?.domain);
  const message = record(root?.message);
  if (!root || !domain || !message || root.primaryType !== "EarlyWithdrawal") {
    return { ok: false, reason: "The API did not describe a TimeLockVaults early withdrawal." };
  }
  if (domain.name !== TIME_LOCK_VAULTS_EIP712.name || domain.version !== TIME_LOCK_VAULTS_EIP712.version) {
    return { ok: false, reason: "The signing domain is not TimeLockVaults." };
  }
  if (uint(domain.chainId) !== BigInt(expected.chainId)) {
    return {
      ok: false,
      reason: `The signature would be for chain ${String(domain.chainId)}, not this deployment.`,
    };
  }
  const contract = typeof domain.verifyingContract === "string" ? domain.verifyingContract : "";
  if (
    !expected.contract ||
    !isAddress(contract, { strict: false }) ||
    getAddress(contract) !== getAddress(expected.contract)
  ) {
    return { ok: false, reason: "The verifying contract is not this vault's contract." };
  }
  const vaultId = uint(message.vaultId);
  const amount = uint(message.amount);
  const nonce = uint(message.nonce);
  const deadline = uint(message.deadline);
  if (vaultId === null || amount === null || nonce === null || deadline === null) {
    return { ok: false, reason: "The withdrawal fields are not unsigned integers." };
  }
  if (expected.onchainId === null || vaultId !== uint(expected.onchainId)) {
    return { ok: false, reason: "The withdrawal names another vault." };
  }
  if (amount !== expected.amountMinor) {
    return { ok: false, reason: "The withdrawal amount differs from the amount you entered." };
  }
  const now = BigInt(expected.now);
  if (deadline <= now || deadline > now + BigInt(MAX_DEADLINE_SECONDS)) {
    return { ok: false, reason: "The withdrawal deadline is in the past or too far away." };
  }
  return {
    ok: true,
    typedData: {
      domain: {
        name: TIME_LOCK_VAULTS_EIP712.name,
        version: TIME_LOCK_VAULTS_EIP712.version,
        chainId: expected.chainId,
        verifyingContract: getAddress(contract),
      },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal",
      message: { vaultId, amount, nonce, deadline },
    },
  };
}
