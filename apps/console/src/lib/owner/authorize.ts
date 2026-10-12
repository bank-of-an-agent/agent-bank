import {
  assertTestnet,
  MAX_OWNER_AUTHORIZATION_SECONDS,
  ownerAuthorizationTypedData,
  ownerPayloads,
  type OwnerAction,
  type OwnerActionPayload,
  type OwnerAuthorization,
} from "@agentbank/core";
import type { OwnerSigner } from "./signer";

/**
 * Owner authorizations: EIP-712 `OwnerAuthorization` over the canonical JSON
 * of a payload. Subjects and payloads come from core's canonical
 * `ownerPayloads` (the same functions the API, the co-signer and the SDK
 * use); the EIP-712 domain chain id is `owner_authorization_chain_id` from
 * `GET /v1/meta`.
 */

export { ownerPayloads };
export type OwnerRequest = OwnerActionPayload;

export const OWNER_AUTHORIZATION_TTL_SECONDS = 600;

/** Plain-language summary of an owner action, shown before the wallet prompt. */
export const OWNER_ACTION_LABELS: Record<OwnerAction, string> = {
  "session.grant": "Grant a session key",
  "policy.loosen": "Loosen a spending policy",
  "mandate.issue": "Issue a payment mandate",
  "agent.unfreeze": "Unfreeze an agent",
  "org.unfreeze": "Unfreeze the organization",
  "topup.set": "Set an auto top-up rule",
  "sweep.set": "Configure the treasury sweep",
  "treasury.set": "Set the org treasury account",
  "vault.withdraw": "Withdraw from a vault",
  "owner.rotate": "Rotate the owner key",
};

/** Sign an owner authorization; the result is the request's `owner_authorization`. */
export async function ownerAuthorize(
  signer: OwnerSigner,
  chainId: number,
  request: OwnerRequest,
  now: number = Math.floor(Date.now() / 1000),
): Promise<OwnerAuthorization> {
  assertTestnet(chainId);
  // A little slack for a browser clock that runs ahead of the server (max skew accepted: 60 s).
  const issuedAt = now - 30;
  const expiresAt = issuedAt + Math.min(OWNER_AUTHORIZATION_TTL_SECONDS, MAX_OWNER_AUTHORIZATION_SECONDS);
  const typedData = ownerAuthorizationTypedData({
    chainId,
    action: request.action,
    subject: request.subject,
    payload: request.payload,
    issuedAt,
    expiresAt,
  });
  const signature = await signer.signTypedData(typedData);
  return { signer: signer.address, signature, issued_at: issuedAt, expires_at: expiresAt };
}
