import {
  AgentBankError,
  eoaTypedDataVerifier,
  unixSeconds,
  verifyOwnerAuthorization,
  type OwnerAction,
  type OwnerAuthorization,
  type TypedDataVerifier,
} from "@agentbank/core";
import { hashTypedData, type Address, type Hex } from "viem";
import type { AppDeps } from "../deps";

/**
 * Owner authorizations (EIP-712 `OwnerAuthorization`, core/eip712.ts) guard every loosening
 * change. The (action, subject, payload) triples are built with core's `ownerPayloads` on both
 * sides (console, SDKs, API and co-signer); the payload is hashed with canonical JSON:
 *
 * | helper          | action           | subject    | payload                                              |
 * | --------------- | ---------------- | ---------- | ---------------------------------------------------- |
 * | `sessionGrant`  | `session.grant`  | account id | `{ account_id, public_key, scope }`                  |
 * | `policyLoosen`  | `policy.loosen`  | agent id   | the policy document                                  |
 * | `mandateIssue`  | `mandate.issue`  | agent id   | the mandate object                                   |
 * | `agentUnfreeze` | `agent.unfreeze` | agent id   | `{ reason }`                                         |
 * | `orgUnfreeze`   | `org.unfreeze`   | org id     | `{ reason }`                                         |
 * | `topUpSet`      | `topup.set`      | agent id   | `{ refill_to, when_below, max_per_day }`             |
 * | `sweepSet`      | `sweep.set`      | account id | the request body without `owner_authorization`       |
 * | `treasurySet`   | `treasury.set`   | org id     | `{ account_id }`                                     |
 * | `vaultWithdraw` | `vault.withdraw` | vault id   | `{ amount }`                                         |
 * | `ownerRotate`   | `owner.rotate`   | org id     | `{ new_owner_address }` (signed by the current owner) |
 *
 * Early withdrawals from a locked vault are the exception: TimeLockVaults itself verifies the
 * vault owner's `EarlyWithdrawal` signature, so `owner_authorization` there carries that
 * signature (see routes/savings.ts). The EIP-712 domain is `{ name: "Agent Bank", version: "1",
 * chainId }` with the configured chain's id (`GET /v1/meta` `owner_authorization_chain_id`).
 * Authorizations are valid for at most 15 minutes.
 */

export interface OwnerAuthCheck {
  ownerAddress: string;
  action: OwnerAction;
  subject: string;
  payload: unknown;
  authorization: OwnerAuthorization;
  now: Date;
}

/** EOA signatures first; then ERC-1271/6492 through the chain for smart-contract owners. */
function chainAwareVerifier(deps: AppDeps): TypedDataVerifier {
  return async (args) => {
    if (await eoaTypedDataVerifier(args)) return true;
    try {
      return await deps.chain.verifySignature({
        address: args.address,
        hash: hashTypedData(args.typedData),
        signature: args.signature,
      });
    } catch {
      return false;
    }
  };
}

export async function verifyOwnerAuth(deps: AppDeps, check: OwnerAuthCheck): Promise<void> {
  const a = check.authorization;
  if (!a) throw new AgentBankError("owner_signature_required", "An owner authorization is required");
  await verifyOwnerAuthorization({
    chainId: deps.config.chain.id,
    action: check.action,
    subject: check.subject,
    payload: check.payload,
    issuedAt: a.issued_at,
    expiresAt: a.expires_at,
    owner: check.ownerAddress as Address,
    signer: a.signer as Address,
    signature: a.signature as Hex,
    now: unixSeconds(check.now),
    verifier: chainAwareVerifier(deps),
  });
}
