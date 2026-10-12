import {
  eoaTypedDataVerifier,
  ownerAuthorizationTypedData,
  verifyOwnerAuthorization,
  type OwnerAction,
  type OwnerActionPayload,
  type OwnerAuthorization,
  type TypedDataVerifier,
} from "@agentbank/core";
import { getAddress, hashTypedData, type Address, type Hex } from "viem";

/**
 * Owner authorizations (EIP-712 `OwnerAuthorization`, core/eip712.ts) as the
 * co-signer checks them: against the owner key it pinned for the org (never
 * an owner the caller names), over the canonical subject and payload from
 * core's `ownerPayloads` (subject = resource id, payload = the parsed request
 * body without `owner_authorization`), in the deployment's EIP-712 domain.
 */
export interface VerifiedAuthorization {
  /** EIP-712 digest: the single-use key (signatures are malleable, digests are not). */
  digest: Hex;
  action: OwnerAction;
  subject: string;
  payloadHash: Hex;
  signer: Address;
}

/** Throws `owner_signature_required` (wrong signer) or `signature_invalid` (bad window or signature). */
export async function verifyOwnerAction(args: {
  authorization: OwnerAuthorization;
  /** The org's pinned owner key. */
  owner: string;
  /** EIP-712 domain chain id (`OWNER_AUTHORIZATION_CHAIN_ID`, default the deployment chain). */
  chainId: number;
  action: OwnerActionPayload;
  /** Unix seconds. */
  now: number;
  verifier?: TypedDataVerifier | undefined;
}): Promise<VerifiedAuthorization> {
  const { authorization, action } = args;
  const owner = getAddress(args.owner);
  const input = {
    chainId: args.chainId,
    action: action.action,
    subject: action.subject,
    payload: action.payload,
    issuedAt: authorization.issued_at,
    expiresAt: authorization.expires_at,
  };
  await verifyOwnerAuthorization({
    ...input,
    owner,
    signer: getAddress(authorization.signer),
    signature: authorization.signature as Hex,
    now: args.now,
    verifier: args.verifier ?? eoaTypedDataVerifier,
  });
  const typed = ownerAuthorizationTypedData(input);
  return {
    digest: hashTypedData(typed),
    action: action.action,
    subject: action.subject,
    payloadHash: typed.message.payloadHash,
    signer: owner,
  };
}
