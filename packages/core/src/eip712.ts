import { verifyTypedData, type Address, type Hex, type TypedDataDomain } from "viem";
import { canonicalKeccak } from "./canonical";
import { AgentBankError } from "./errors";

/**
 * Owner authorizations: every change that needs the principal's owner key is
 * an EIP-712 `OwnerAuthorization` over the canonical JSON of the payload.
 * One message type keeps wallet prompts legible ("action" and "subject" are
 * plain strings) and lets every service verify with the same code.
 */

export const OWNER_ACTIONS = [
  "session.grant",
  "policy.loosen",
  "mandate.issue",
  "agent.unfreeze",
  "org.unfreeze",
  "topup.set",
  "sweep.set",
  "treasury.set",
  "vault.withdraw",
  "owner.rotate",
  "spend_key.set",
  "proofs.disclose",
  "proofs.reservation.release",
] as const;

export type OwnerAction = (typeof OWNER_ACTIONS)[number];

export const OWNER_AUTHORIZATION_TYPES = {
  OwnerAuthorization: [
    { name: "action", type: "string" },
    { name: "subject", type: "string" },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export function agentBankDomain(chainId: number): TypedDataDomain {
  return { name: "Agent Bank", version: "1", chainId };
}

export interface OwnerAuthorizationInput {
  chainId: number;
  action: OwnerAction;
  /** The id the action applies to, e.g. an agent id or account address. */
  subject: string;
  /** The exact payload being authorized; hashed with canonical JSON. */
  payload: unknown;
  issuedAt: number;
  expiresAt: number;
}

export function ownerAuthorizationTypedData(input: OwnerAuthorizationInput) {
  return {
    domain: agentBankDomain(input.chainId),
    types: OWNER_AUTHORIZATION_TYPES,
    primaryType: "OwnerAuthorization" as const,
    message: {
      action: input.action,
      subject: input.subject,
      payloadHash: canonicalKeccak(input.payload),
      issuedAt: BigInt(input.issuedAt),
      expiresAt: BigInt(input.expiresAt),
    },
  };
}

export type OwnerAuthorizationTypedData = ReturnType<typeof ownerAuthorizationTypedData>;

/**
 * Signature verifier. The default handles EOAs; services that must accept
 * smart-contract owners (ERC-1271 / ERC-6492) pass a chain-aware verifier,
 * e.g. viem's `publicClient.verifyTypedData`.
 */
export type TypedDataVerifier = (args: {
  address: Address;
  signature: Hex;
  typedData: OwnerAuthorizationTypedData;
}) => Promise<boolean>;

export const eoaTypedDataVerifier: TypedDataVerifier = async ({ address, signature, typedData }) => {
  try {
    return await verifyTypedData({ address, signature, ...typedData });
  } catch {
    return false;
  }
};

/** Maximum validity window of a single owner authorization. */
export const MAX_OWNER_AUTHORIZATION_SECONDS = 15 * 60;

export interface VerifyOwnerAuthorizationArgs extends OwnerAuthorizationInput {
  owner: Address;
  signer: Address;
  signature: Hex;
  now?: number;
  verifier?: TypedDataVerifier;
}

/** Verify an owner authorization; throws `owner_signature_required` / `signature_invalid`. */
export async function verifyOwnerAuthorization(args: VerifyOwnerAuthorizationArgs): Promise<void> {
  if (args.signer.toLowerCase() !== args.owner.toLowerCase()) {
    throw new AgentBankError("owner_signature_required", "Authorization was not signed by the org owner key");
  }
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (args.expiresAt <= args.issuedAt || args.expiresAt - args.issuedAt > MAX_OWNER_AUTHORIZATION_SECONDS) {
    throw new AgentBankError("signature_invalid", "Owner authorization window must be at most 15 minutes");
  }
  if (now < args.issuedAt - 60 || now > args.expiresAt) {
    throw new AgentBankError("signature_invalid", "Owner authorization is expired or not yet valid");
  }
  const typedData = ownerAuthorizationTypedData(args);
  const verifier = args.verifier ?? eoaTypedDataVerifier;
  const ok = await verifier({ address: args.owner, signature: args.signature, typedData });
  if (!ok) throw new AgentBankError("signature_invalid", "Owner authorization signature is invalid");
}
