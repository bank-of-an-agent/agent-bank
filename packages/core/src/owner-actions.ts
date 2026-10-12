import type { OwnerAction } from "./eip712";

/**
 * Canonical subject and payload for every owner action. Signers (SDKs,
 * console) and verifiers (API, co-signer) must build the `OwnerAuthorization`
 * from these functions, so both sides hash exactly the same JSON.
 *
 * Conventions:
 * - `subject` is the id of the resource the action applies to.
 * - `payload` is the request body without `owner_authorization`, after the
 *   schema's defaults are applied (hash the parsed body, not the raw bytes).
 * - The EIP-712 domain chain id is the deployment chain id from
 *   `GET /v1/meta` (`owner_authorization_chain_id`).
 */
export interface OwnerActionPayload<A extends OwnerAction = OwnerAction> {
  action: A;
  subject: string;
  payload: unknown;
}

export const ownerPayloads = {
  /** `POST /v1/sessions`: subject = account id; payload = `{ account_id, public_key, scope }`. */
  sessionGrant: (body: {
    account_id: string;
    public_key: string;
    scope: unknown;
  }): OwnerActionPayload<"session.grant"> => ({
    action: "session.grant",
    subject: body.account_id,
    payload: { account_id: body.account_id, public_key: body.public_key, scope: body.scope },
  }),
  /** `PUT /v1/agents/{id}/policy`: subject = agent id; payload = the policy document. */
  policyLoosen: (agentId: string, policy: unknown): OwnerActionPayload<"policy.loosen"> => ({
    action: "policy.loosen",
    subject: agentId,
    payload: policy,
  }),
  /** `POST /v1/mandates`: subject = agent id; payload = the mandate object. */
  mandateIssue: (agentId: string, mandate: unknown): OwnerActionPayload<"mandate.issue"> => ({
    action: "mandate.issue",
    subject: agentId,
    payload: mandate,
  }),
  /** `POST /v1/agents/{id}/unfreeze`: subject = agent id; payload = `{ reason }`. */
  agentUnfreeze: (agentId: string, reason: string): OwnerActionPayload<"agent.unfreeze"> => ({
    action: "agent.unfreeze",
    subject: agentId,
    payload: { reason },
  }),
  /** `POST /v1/orgs/me/unfreeze`: subject = org id; payload = `{ reason }`. */
  orgUnfreeze: (orgId: string, reason: string): OwnerActionPayload<"org.unfreeze"> => ({
    action: "org.unfreeze",
    subject: orgId,
    payload: { reason },
  }),
  /** `PUT /v1/agents/{id}/auto-topup`: subject = agent id; payload = `{ refill_to, when_below, max_per_day }`. */
  topUpSet: (
    agentId: string,
    rule: { refill_to: unknown; when_below: unknown; max_per_day: unknown },
  ): OwnerActionPayload<"topup.set"> => ({
    action: "topup.set",
    subject: agentId,
    payload: { refill_to: rule.refill_to, when_below: rule.when_below, max_per_day: rule.max_per_day },
  }),
  /** `PUT /v1/accounts/{id}/sweep-rule`: subject = account id; payload = the body without `owner_authorization`. */
  sweepSet: (accountId: string, rule: Record<string, unknown>): OwnerActionPayload<"sweep.set"> => ({
    action: "sweep.set",
    subject: accountId,
    payload: rule,
  }),
  /** `PUT /v1/orgs/me/treasury`: subject = org id; payload = `{ account_id }`. */
  treasurySet: (orgId: string, accountId: string): OwnerActionPayload<"treasury.set"> => ({
    action: "treasury.set",
    subject: orgId,
    payload: { account_id: accountId },
  }),
  /** `POST /v1/vaults/{id}/withdraw`: subject = vault id; payload = `{ amount }`. */
  vaultWithdraw: (vaultId: string, amount: unknown): OwnerActionPayload<"vault.withdraw"> => ({
    action: "vault.withdraw",
    subject: vaultId,
    payload: { amount },
  }),
  /**
   * `POST /v1/orgs/me/owner`: voluntary owner-key rotation signed by the **current** owner;
   * subject = org id; payload = `{ new_owner_address }`. (Guardian recovery after a lost key is an
   * on-chain Safe recovery followed by the owner-recovery runbook.)
   */
  ownerRotate: (orgId: string, newOwnerAddress: string): OwnerActionPayload<"owner.rotate"> => ({
    action: "owner.rotate",
    subject: orgId,
    payload: { new_owner_address: newOwnerAddress },
  }),
  /**
   * `PUT /v1/accounts/{id}/spend-key`: subject = account id; payload = `{ account_id, spend_key_address }`.
   * Pins the agent's x402 spend key in the co-signer; refills may only ever go to it (ADR 0001).
   */
  spendKeySet: (accountId: string, spendKeyAddress: string): OwnerActionPayload<"spend_key.set"> => ({
    action: "spend_key.set",
    subject: accountId,
    payload: { account_id: accountId, spend_key_address: spendKeyAddress },
  }),
} as const;

/**
 * How operation hashes are signed (session key, co-signer and owner alike):
 * EIP-191 personal sign over the **raw 32 bytes** of `user_op_hash`
 * (viem: `signMessage({ message: { raw: hash } })`), which is what the
 * Smart Sessions / OwnableValidator path verifies with
 * `toEthSignedMessageHash(bytes32)`.
 */
export const OPERATION_HASH_SIGNING = "eip191-raw-bytes32" as const;
