import { AgentBankError } from "@agentbank/core";
import {
  encodeFunctionData,
  getAddress,
  hexToNumber,
  isHex,
  size,
  slice,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, PERMIT_TYPES } from "./abis";
import { transferFromCall } from "./calls";
import type { Call } from "./types";

/**
 * The x402 spend key (contracts ADR 0001): a per-agent EOA holding a small USDC float, refilled by
 * the agent account under the full policy stack. At provisioning the spend key signs an EIP-2612
 * `permit` giving its parent account an allowance, so the float can always be swept back with
 * `transferFrom` (an owner operation; `AgentPolicyHook` treats a `transferFrom` into the account as
 * an inflow) without the agent runtime.
 */

/** Input of {@link spendKeyPermitTypedData}. */
export interface SpendKeyPermitInput {
  chainId: number;
  /** USDC (FiatToken v2.2; EIP-712 domain name "USDC", version "2"). */
  token: Address;
  /** The spend key (permit owner). */
  owner: Address;
  /** The parent smart account (permit spender). */
  spender: Address;
  /** Allowance, usually `maxUint256` so any float can be swept. */
  value: bigint;
  /** `USDC.nonces(owner)` (0 for a fresh spend key). */
  nonce: bigint;
  /** Unix seconds (inclusive); `maxUint256` never expires. */
  deadline: bigint;
}

/**
 * EIP-712 typed data of the spend key's EIP-2612 `Permit` for USDC. Sign it with the spend key
 * (`signTypedData`) and submit it with {@link permitCall}.
 */
export function spendKeyPermitTypedData(input: SpendKeyPermitInput) {
  return {
    domain: {
      name: "USDC",
      version: "2",
      chainId: input.chainId,
      verifyingContract: getAddress(input.token),
    },
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: {
      owner: getAddress(input.owner),
      spender: getAddress(input.spender),
      value: input.value,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
}

/** A signed EIP-2612 permit. */
export interface PermitInput {
  owner: Address;
  spender: Address;
  value: bigint;
  deadline: bigint;
  /** 65-byte ECDSA signature (EOA owner) or any-length ERC-1271 signature (contract owner). */
  signature: Hex;
}

/**
 * `token.permit(...)`: a 65-byte ECDSA signature uses FiatToken's `(v, r, s)` overload (v normalized
 * to 27/28); anything else uses the `bytes signature` overload (ERC-1271 owners). Anyone may submit
 * it; inside an account it belongs to an owner operation (AgentPolicyHook refuses `permit` calls on
 * the hooked path, so include it before the hook is installed, e.g. in {@link accountSetupCalls}).
 */
export function permitCall(token: Address, input: PermitInput): Call {
  if (!isHex(input.signature)) throw new AgentBankError("invalid_request", "signature must be hex");
  const base = [input.owner, input.spender, input.value, input.deadline] as const;
  if (size(input.signature) === 65) {
    let v = hexToNumber(slice(input.signature, 64, 65));
    if (v === 0 || v === 1) v += 27;
    if (v !== 27 && v !== 28) throw new AgentBankError("signature_invalid", "unsupported signature v value");
    return {
      to: getAddress(token),
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "permit",
        args: [...base, v, slice(input.signature, 0, 32), slice(input.signature, 32, 64)],
      }),
    };
  }
  return {
    to: getAddress(token),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "permit", args: [...base, input.signature] }),
  };
}

/**
 * Sweep a spend key's float back into its account: `token.transferFrom(spendKey, account, amount)`,
 * executed by the account with the provisioning-time permit allowance (owner operation).
 */
export function floatSweepCall(token: Address, spendKey: Address, account: Address, amount: bigint): Call {
  return transferFromCall({ token, from: spendKey, to: account, amount });
}
