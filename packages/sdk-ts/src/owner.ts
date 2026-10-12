import {
  assertTestnet,
  MAX_OWNER_AUTHORIZATION_SECONDS,
  OWNER_ACTIONS,
  ownerAuthorizationTypedData,
  type OwnerAction,
} from "@agentbank/core";
import { InvalidRequestError } from "./errors";
import { nowSeconds } from "./internal/ids";
import type { OwnerSigner } from "./signers";
import type { OwnerAuthorization } from "./types";

/**
 * Owner authorizations: EIP-712 `OwnerAuthorization` signatures by the
 * principal's owner key over the canonical JSON of a payload. The API (and
 * the co-signer) verify them before any loosening change, session install,
 * mandate, unfreeze, top-up, sweep, treasury change or early vault withdrawal.
 *
 * @packageDocumentation
 */

/** Default validity of an owner authorization: 10 minutes (the maximum is 15). */
export const DEFAULT_OWNER_AUTHORIZATION_TTL_SECONDS = 600;

/** Input of {@link ownerAuthorize}. */
export interface OwnerAuthorizeInput {
  /**
   * EIP-712 domain chain id: the deployment's `owner_authorization_chain_id`
   * from `GET /v1/meta` (`PrincipalClient` fetches it for you). Base Sepolia
   * is 84532; sandboxes may use 1337 (simulated) or 31337 (Anvil).
   */
  chainId: number;
  /** What is being authorized, e.g. `"session.grant"` or `"policy.loosen"`. */
  action: OwnerAction;
  /** The id the action applies to (see {@link ownerPayloads} for the convention per action). */
  subject: string;
  /** The exact payload being authorized. Hashed with canonical JSON (RFC 8785 style). */
  payload: unknown;
  /** Validity in seconds (default 600, max 900). */
  ttlSeconds?: number;
  /** Override the issue time (Unix seconds); defaults to now. */
  issuedAt?: number;
}

/**
 * Sign an owner authorization with the principal's owner key.
 *
 * The signature commits to `action`, `subject`, the Keccak-256 of the
 * canonical JSON of `payload`, and a validity window of at most 15 minutes.
 * Refuses mainnet chain ids: Agent Bank is testnet-only until the Phase 5 gate.
 *
 * @returns The `owner_authorization` object to attach to the API request.
 *
 * @example
 * ```ts
 * const { owner_authorization_chain_id: chainId } = await client.meta();
 * const owner_authorization = await ownerAuthorize(owner, {
 *   chainId,
 *   ...ownerPayloads.policyLoosen(agentId, policy),
 * });
 * await client.policies.put(agentId, { policy, owner_authorization });
 * ```
 */
export async function ownerAuthorize(
  owner: OwnerSigner,
  input: OwnerAuthorizeInput,
): Promise<OwnerAuthorization> {
  if (!(OWNER_ACTIONS as readonly string[]).includes(input.action)) {
    throw new InvalidRequestError("invalid_request", `Unknown owner action "${String(input.action)}"`);
  }
  if (!input.subject)
    throw new InvalidRequestError("invalid_request", "Owner authorization subject is required");
  assertTestnet(input.chainId);
  const ttl = input.ttlSeconds ?? DEFAULT_OWNER_AUTHORIZATION_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_OWNER_AUTHORIZATION_SECONDS) {
    throw new InvalidRequestError(
      "invalid_request",
      `ttlSeconds must be an integer between 1 and ${MAX_OWNER_AUTHORIZATION_SECONDS}`,
    );
  }
  const issuedAt = input.issuedAt ?? nowSeconds();
  const expiresAt = issuedAt + ttl;
  const typedData = ownerAuthorizationTypedData({
    chainId: input.chainId,
    action: input.action,
    subject: input.subject,
    payload: input.payload,
    issuedAt,
    expiresAt,
  });
  const signature = await owner.signTypedData(typedData);
  return { signer: owner.address, signature, issued_at: issuedAt, expires_at: expiresAt };
}

/**
 * Canonical `subject` and `payload` per owner action, from `@agentbank/core`
 * (shared with the API and the co-signer so both sides hash the same JSON):
 * the subject is the id of the resource the action applies to, and the
 * payload is the request body without `owner_authorization`, after the
 * schema's defaults are applied. Spread the result into {@link ownerAuthorize}.
 */
export { ownerPayloads, type OwnerActionPayload } from "@agentbank/core";
