import { assertTestnet } from "@agentbank/core";
import { SpendKeyPermit } from "@agentbank/core/api";
import { spendKeyPermitTypedData } from "@agentbank/sdk";
import { getAddress, isAddress, verifyTypedData, type Hex } from "viem";
import type { z } from "zod";

/**
 * x402 spend keys (ADR 0001). An agent pays x402 from a per-agent EOA, the
 * spend key, which holds a small USDC float outside its smart account. So the
 * owner can always sweep that float home, the spend key signs an EIP-2612
 * USDC permit (spender = the agent's smart account, max allowance, no
 * deadline) that the account's next owner operation executes; the owner key
 * authorizes the key with `spend_key.set`, pinning it in the co-signer.
 *
 * The console builds the permit with the SDK (`signSpendKeyPermit`,
 * `spendKeyPermitTypedData`). A sandbox key generated here exists only in the
 * browser's memory until the principal downloads it; it is never sent to the
 * console server or the API.
 */

export type Permit = z.infer<typeof SpendKeyPermit>;

export interface UsdcDomain {
  address: string;
  name: string;
  version: string;
}

export interface PermitTarget {
  /** The agent's smart account (`account.address`): the permit's spender. */
  account: string;
  chainId: number;
  usdc: UsdcDomain;
}

/** A permit pasted from the agent's runtime: shape first, then the signature itself. */
export async function checkPermit(
  text: string,
  spendKey: string,
  target: PermitTarget,
): Promise<{ ok: true; permit: Permit } | { ok: false; message: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "The permit is not valid JSON." };
  }
  const parsed = SpendKeyPermit.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Expected { value, deadline, nonce, signature } as the SDK returns it." };
  }
  if (!isAddress(spendKey, { strict: false })) return { ok: false, message: "Enter the spend key address." };
  try {
    assertTestnet(target.chainId);
    const typedData = spendKeyPermitTypedData({
      owner: spendKey,
      account: target.account,
      chainId: target.chainId,
      usdc: target.usdc.address,
      name: target.usdc.name,
      version: target.usdc.version,
      value: parsed.data.value,
      deadline: parsed.data.deadline,
      nonce: parsed.data.nonce,
    });
    const valid = await verifyTypedData({
      ...typedData,
      address: getAddress(spendKey),
      signature: parsed.data.signature as Hex,
    });
    if (!valid) {
      return {
        ok: false,
        message: "The signature is not the spend key's permit for this account and this chain's USDC.",
      };
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The permit could not be checked.",
    };
  }
  return { ok: true, permit: parsed.data };
}

/** The one-time download of a sandbox spend key, labelled testnet-only inside and in its name. */
export function spendKeyFile(input: {
  privateKey: Hex;
  address: string;
  accountId: string;
  accountAddress: string;
  agentId: string | null;
  agentName: string;
  chain: string;
  chainId: number;
  createdAt: Date;
}): { filename: string; text: string } {
  assertTestnet(input.chainId);
  const slug =
    input.agentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
  const body = {
    warning:
      "TESTNET ONLY. Agent Bank sandbox x402 spend key. Whoever holds this private key controls the agent's spend-key float. Never use it on mainnet.",
    kind: "agentbank.spend_key",
    testnet_only: true,
    chain: input.chain,
    chain_id: input.chainId,
    agent_id: input.agentId,
    account_id: input.accountId,
    account_address: input.accountAddress,
    address: input.address,
    private_key: input.privateKey,
    created_at: input.createdAt.toISOString(),
  };
  return {
    filename: `agentbank-spend-key-${slug}-${input.address.slice(2, 8).toLowerCase()}.testnet.json`,
    text: `${JSON.stringify(body, null, 2)}\n`,
  };
}
