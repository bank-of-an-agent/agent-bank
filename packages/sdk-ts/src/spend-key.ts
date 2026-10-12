import { assertTestnet } from "@agentbank/core";
import { getAddress, maxUint256, type Address } from "viem";
import { InvalidRequestError } from "./errors";
import type { SpendSigner } from "./signers";
import type { SpendKeyPermit } from "./types";

/**
 * Spend-key float recovery (ADR 0001).
 *
 * Agents pay x402 from a per-agent EOA, the **spend key**, which holds a
 * small USDC float outside the smart account. So that the owner can always
 * sweep that float back without the agent, the spend key signs an EIP-2612
 * USDC `permit` at provisioning time: owner = spend key, spender = the
 * agent's smart account, value = max uint256, deadline = max uint256. The
 * account's setup owner operation executes it on-chain; afterwards the
 * account (or the owner's exit tool) can `transferFrom` the float home.
 *
 * The spender is the smart account's counterfactual address, which only the
 * API can compute, so the order is: create the account → sign the permit for
 * `account.address` → `PUT /v1/accounts/{id}/spend-key` → install the first
 * session. `PrincipalClient.provisionSpendKey` and
 * `PrincipalClient.setupAgentAccount` do this for you.
 *
 * @packageDocumentation
 */

/** EIP-712 types of an EIP-2612 `Permit` (as implemented by USDC FiatToken). */
export const EIP2612_PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * ABI of EIP-2612 `nonces(owner)`, to read the spend key's current permit
 * nonce with your own RPC client when the key is not fresh, e.g.
 * `publicClient.readContract({ address: usdc, abi: EIP2612_NONCES_ABI, functionName: "nonces", args: [spendKey.address] })`.
 */
export const EIP2612_NONCES_ABI = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Permit parameters callers may set; everything else comes from the account and `GET /v1/meta`. */
export interface SpendKeyPermitOptions {
  /**
   * USDC `nonces(spendKey)` at signing time (default 0, correct for a fresh
   * key from `generateSpendKey()`). Pass it for a key that has signed permits
   * before; see {@link EIP2612_NONCES_ABI}.
   */
  nonce?: bigint | number | string;
  /** Allowance in USDC minor units (default max uint256). Must be positive. */
  value?: bigint | number | string;
  /** Unix-seconds deadline (default max uint256, i.e. never expires). */
  deadline?: bigint | number | string;
}

/** Input of {@link signSpendKeyPermit}. */
export interface SignSpendKeyPermitInput extends SpendKeyPermitOptions {
  /** The agent's spend key: the permit owner and signer. */
  spendKey: SpendSigner;
  /** The agent's smart account address (spender), as returned by `createAccount`. */
  account: string;
  /** Chain id of USDC (the deployment chain; testnets only). */
  chainId: number;
  /** USDC contract address (verifying contract), e.g. `meta.usdc.address`. */
  usdc: string;
  /** EIP-712 domain name of USDC (default `"USDC"`; `meta.usdc.eip712_name`). */
  name?: string;
  /** EIP-712 domain version of USDC (default `"2"`; `meta.usdc.eip712_version`). */
  version?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function uint(value: bigint | number | string, field: string): bigint {
  let parsed: bigint;
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("unsafe");
    parsed = BigInt(value);
  } catch {
    throw new InvalidRequestError("invalid_request", `${field} must be a non-negative integer`);
  }
  if (parsed < 0n || parsed > maxUint256) {
    throw new InvalidRequestError("invalid_request", `${field} must be between 0 and 2^256-1`);
  }
  return parsed;
}

function address(value: string, field: string): Address {
  if (!ADDRESS_RE.test(value))
    throw new InvalidRequestError("invalid_request", `${field} must be an address`);
  return getAddress(value);
}

/** Resolve and validate the permit fields (shared by signing and verification). */
function resolve(input: Omit<SignSpendKeyPermitInput, "spendKey"> & { owner: string }) {
  assertTestnet(input.chainId);
  const owner = address(input.owner, "spendKey");
  const spender = address(input.account, "account");
  if (owner === spender) {
    throw new InvalidRequestError(
      "invalid_request",
      "The spender must be the smart account, not the spend key",
    );
  }
  const value = uint(input.value ?? maxUint256, "value");
  if (value === 0n) {
    throw new InvalidRequestError(
      "invalid_request",
      "A zero allowance would not let the owner sweep the float back",
    );
  }
  const deadline = uint(input.deadline ?? maxUint256, "deadline");
  if (deadline <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new InvalidRequestError("invalid_request", "deadline is in the past");
  }
  return {
    owner,
    spender,
    value,
    nonce: uint(input.nonce ?? 0n, "nonce"),
    deadline,
    domain: {
      name: input.name ?? "USDC",
      version: input.version ?? "2",
      chainId: input.chainId,
      verifyingContract: address(input.usdc, "usdc"),
    },
  };
}

/**
 * The EIP-712 typed data of the spend-key permit (domain, `Permit` types and
 * message), e.g. to verify a signature or to sign with a custom signer.
 */
export function spendKeyPermitTypedData(
  input: Omit<SignSpendKeyPermitInput, "spendKey"> & { owner: string },
) {
  const r = resolve(input);
  return {
    domain: r.domain,
    types: EIP2612_PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: r.owner, spender: r.spender, value: r.value, nonce: r.nonce, deadline: r.deadline },
  };
}

/**
 * Sign the spend key's float-recovery permit (EIP-2612 on USDC): owner =
 * spend key, spender = the agent's smart account, value and deadline max
 * uint256 by default. Returns the wire `SpendKeyPermit` for
 * `PUT /v1/accounts/{id}/spend-key`.
 *
 * Refuses mainnet chains, a zero allowance, past deadlines, and a spender
 * equal to the spend key.
 *
 * @example
 * ```ts
 * const meta = await client.meta();
 * const permit = await signSpendKeyPermit({
 *   spendKey,
 *   account: account.address,
 *   chainId: account.chain_id,
 *   usdc: meta.usdc.address,
 * });
 * await client.accounts.attachSpendKey(account.id, { spend_key_address: spendKey.address, permit });
 * ```
 */
export async function signSpendKeyPermit(input: SignSpendKeyPermitInput): Promise<SpendKeyPermit> {
  const typedData = spendKeyPermitTypedData({ ...input, owner: input.spendKey.address });
  const signature = await input.spendKey.signTypedData(typedData);
  return {
    value: typedData.message.value.toString(),
    deadline: typedData.message.deadline.toString(),
    nonce: typedData.message.nonce.toString(),
    signature,
  };
}
