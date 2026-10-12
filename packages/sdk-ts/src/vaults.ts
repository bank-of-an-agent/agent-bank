import { getAddress, isAddress, type Address } from "viem";
import { PermissionDeniedError } from "./errors";
import type { Meta, Vault } from "./types";

/**
 * Early withdrawals from locked vaults (`TimeLockVaults`).
 *
 * Before its unlock date, a locked vault only releases funds on the vault
 * owner's (the org owner key's) signature over the contract's own EIP-712
 * `EarlyWithdrawal { vaultId, amount, nonce, deadline }`. The API runs a
 * challenge–response: `POST /v1/vaults/{id}/withdraw` without a signature
 * answers `owner_signature_required` with `typed_data` describing what to
 * sign; the owner signs it and the request is retried with
 * `owner_authorization: { signer, signature, issued_at, expires_at: deadline }`;
 * the API then prepares an owner operation (`vault.withdraw`) that the owner
 * signs too. The generic `vault.withdraw` OwnerAuthorization
 * (`ownerPayloads.vaultWithdraw`) is **not** used for this.
 *
 * The SDK never signs the API's object as-is: it checks it against what the
 * owner asked for and signs a structure it builds itself.
 *
 * @packageDocumentation
 */

/** EIP-712 domain name and version of the `TimeLockVaults` contract. */
export const TIME_LOCK_VAULTS_EIP712 = { name: "AgentBank TimeLockVaults", version: "1" } as const;

/** EIP-712 types the vault owner signs for an early withdrawal. */
export const EARLY_WITHDRAWAL_TYPES = {
  EarlyWithdrawal: [
    { name: "vaultId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The API prepares deadlines 15 minutes out; anything further than an hour is refused. */
export const MAX_EARLY_WITHDRAWAL_DEADLINE_SECONDS = 3600;

/** The validated `EarlyWithdrawal` typed data to sign (integers as bigint). */
export interface EarlyWithdrawalTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof EARLY_WITHDRAWAL_TYPES;
  primaryType: "EarlyWithdrawal";
  message: { vaultId: bigint; amount: bigint; nonce: bigint; deadline: bigint };
}

/** What the owner asked for, to check the API's challenge against. */
export interface ExpectedEarlyWithdrawal {
  /** Deployment facts (`GET /v1/meta`): chain id and the `vaults` contract. */
  meta: Pick<Meta, "chain_id" | "contracts">;
  /** The vault (its `contract_address` and `onchain_id`). */
  vault: Pick<Vault, "id" | "contract_address" | "onchain_id">;
  /** The requested amount in USDC minor units. */
  amountMinor: bigint;
  /** Unix seconds (default: now). */
  now?: number;
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

function refuse(reason: string): never {
  throw new PermissionDeniedError("forbidden", `Refusing to sign the early withdrawal: ${reason}`);
}

/**
 * Validate the API's `typed_data` challenge for an early withdrawal and build
 * the typed data to sign. Refuses anything that is not exactly the requested
 * withdrawal: another domain, chain, contract (it must be the deployment's
 * `vaults` contract and the vault's `contract_address`), vault or amount, or
 * a deadline that is past or more than an hour away.
 *
 * @throws {@link PermissionDeniedError} (`forbidden`) with the reason.
 */
export function earlyWithdrawalTypedData(
  described: unknown,
  expected: ExpectedEarlyWithdrawal,
): EarlyWithdrawalTypedData {
  const root = record(described);
  const domain = record(root?.domain);
  const message = record(root?.message);
  if (!root || !domain || !message || root.primaryType !== "EarlyWithdrawal") {
    refuse("the API did not describe a TimeLockVaults EarlyWithdrawal");
  }
  if (domain.name !== TIME_LOCK_VAULTS_EIP712.name || domain.version !== TIME_LOCK_VAULTS_EIP712.version) {
    refuse("the signing domain is not TimeLockVaults");
  }
  if (uint(domain.chainId) !== BigInt(expected.meta.chain_id)) {
    refuse(`the signature would be for chain ${String(domain.chainId)}, not this deployment`);
  }
  const contract = typeof domain.verifyingContract === "string" ? domain.verifyingContract : "";
  if (!isAddress(contract, { strict: false })) refuse("the verifying contract is not an address");
  const verifyingContract = getAddress(contract);
  const known = [expected.meta.contracts.vaults, expected.vault.contract_address].filter(
    (a): a is string => typeof a === "string" && a.length > 0,
  );
  if (
    known.length === 0 ||
    known.some((a) => !isAddress(a, { strict: false }) || getAddress(a) !== verifyingContract)
  ) {
    refuse("the verifying contract is not this deployment's TimeLockVaults contract");
  }
  const vaultId = uint(message.vaultId);
  const amount = uint(message.amount);
  const nonce = uint(message.nonce);
  const deadline = uint(message.deadline);
  if (vaultId === null || amount === null || nonce === null || deadline === null) {
    refuse("the withdrawal fields are not unsigned integers");
  }
  if (expected.vault.onchain_id === null || vaultId !== uint(expected.vault.onchain_id)) {
    refuse("the withdrawal names another vault");
  }
  if (amount !== expected.amountMinor) refuse("the amount differs from the requested amount");
  const now = BigInt(expected.now ?? Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + BigInt(MAX_EARLY_WITHDRAWAL_DEADLINE_SECONDS)) {
    refuse("the deadline is in the past or more than an hour away");
  }
  return {
    domain: {
      name: TIME_LOCK_VAULTS_EIP712.name,
      version: TIME_LOCK_VAULTS_EIP712.version,
      chainId: expected.meta.chain_id,
      verifyingContract,
    },
    types: EARLY_WITHDRAWAL_TYPES,
    primaryType: "EarlyWithdrawal",
    message: { vaultId, amount, nonce, deadline },
  };
}
