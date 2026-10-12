import {
  encodeOwnerSignature,
  recoverOperationSigner,
  type Call,
  type PreparedOperation,
} from "@agentbank/chain";
import { AgentBankError, newId, unixSeconds } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { getAddress, type Hex } from "viem";
import type { AccountRow, OwnerOperationPurpose, OwnerOperationRow } from "../db/rows";
import { one } from "../db/sql";
import type { AppDeps } from "../deps";
import { audit } from "./audit";
import { asPrepared, cosignerAddress, onChain } from "./chain";

/**
 * Owner operations (ADR 0005): on-chain actions only the principal's owner key may authorize
 * (installing or revoking sessions, configuring executors, early vault withdrawal, payments
 * where policy says `require_owner`). The API prepares the user operation, the owner signs
 * `user_op_hash` (EIP-191) in the console or with the SDK, and the API submits it. Agent Bank
 * cannot sign these, and the owner can always bypass Agent Bank with the exit tool.
 */

/** Prepare an owner-path operation, deploying the account first when it is still counterfactual. */
export async function prepareOwnerOperation(
  deps: AppDeps,
  account: AccountRow,
  calls: Call[],
  now: Date,
  options: { setsUpAccount?: boolean } = {},
): Promise<PreparedOperation> {
  const deployed = await onChain("isDeployed", () => deps.chain.isDeployed(getAddress(account.address)));
  if (!deployed && account.role === "agent" && !options.setsUpAccount) {
    // An agent account is only ever deployed by its setup operation, which installs the
    // AgentPolicyHook (the UTC-day cap and recipient allowlist live only there).
    throw new AgentBankError(
      "invalid_state",
      "The agent account is not set up on-chain yet: install a session first (POST /v1/sessions/{id}/install)",
    );
  }
  const deployment = deployed
    ? undefined
    : {
        owner: getAddress(account.owner_address),
        cosigner: await cosignerAddress(deps),
        salt: BigInt(account.salt),
      };
  return onChain("prepareOwnerOperation", () =>
    deps.chain.prepareOwnerOperation({
      account: getAddress(account.address),
      calls,
      ...(deployment ? { deployment } : {}),
      validUntil: unixSeconds(now) + deps.config.ownerOperationTtlSeconds,
    }),
  );
}

export async function insertOwnerOperation(
  tx: SqlClient,
  input: {
    account: AccountRow;
    purpose: OwnerOperationPurpose;
    subjectId: string;
    prepared: PreparedOperation;
    now: Date;
    /** The operation submits the account's pending spend-key permit (setup operation). */
    carriesPermit?: boolean;
  },
): Promise<OwnerOperationRow> {
  const row = await one<OwnerOperationRow>(
    tx,
    `INSERT INTO owner_operation (id, account_id, purpose, subject_id, status, chain_id, user_op, user_op_hash,
                                  expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'requires_signature', $5, $6, $7, $8, $9, $9) RETURNING *`,
    [
      newId("ownerOperation", input.now.getTime()),
      input.account.id,
      input.purpose,
      input.subjectId,
      input.prepared.chainId,
      input.prepared as unknown as object,
      input.prepared.userOpHash,
      new Date(input.prepared.validUntil * 1000),
      input.now,
    ],
  );
  if (input.carriesPermit) {
    await tx.query("UPDATE account SET spend_key_permit_op_id = $2 WHERE id = $1", [
      input.account.id,
      (row as OwnerOperationRow).id,
    ]);
  }
  return row as OwnerOperationRow;
}

/** An owner operation ended: settle the spend-key permit it carried, if any. */
export async function settleCarriedPermit(
  tx: SqlClient,
  op: OwnerOperationRow,
  outcome: "succeeded" | "failed" | "expired",
  now: Date,
): Promise<void> {
  if (outcome === "succeeded") {
    await tx.query(
      "UPDATE account SET spend_key_permit_status = 'executed' WHERE spend_key_permit_op_id = $1 AND spend_key_permit_status = 'pending'",
      [op.id],
    );
    return;
  }
  if (outcome === "expired") {
    await tx.query(
      "UPDATE account SET spend_key_permit_op_id = NULL WHERE spend_key_permit_op_id = $1 AND spend_key_permit_status = 'pending'",
      [op.id],
    );
    return;
  }
  // Reverted or dropped: the permit itself may be the cause (a used nonce), and a permit that
  // cannot execute would block every later setup attempt, so it is dropped; attach a new one.
  const dropped = await one<AccountRow>(
    tx,
    `UPDATE account SET spend_key_permit = NULL, spend_key_permit_status = 'none', spend_key_permit_op_id = NULL
      WHERE spend_key_permit_op_id = $1 AND spend_key_permit_status = 'pending' RETURNING *`,
    [op.id],
  );
  if (dropped) {
    await audit(tx, now, {
      actor: "system",
      action: "account.spend_key_permit_dropped",
      subject: dropped.id,
      payload: { owner_operation_id: op.id },
    });
  }
}

/** Owner operation visible to a principal of `orgId`. */
export async function loadOwnerOperation(
  db: SqlClient,
  orgId: string,
  id: string,
): Promise<OwnerOperationRow> {
  const row = await one<OwnerOperationRow>(
    db,
    `SELECT o.* FROM owner_operation o JOIN account a ON a.id = o.account_id WHERE o.id = $1 AND a.org_id = $2`,
    [id, orgId],
  );
  if (!row) throw new AgentBankError("not_found", "Owner operation not found");
  return row;
}

/**
 * Verify the owner's signature over `user_op_hash` and submit the operation. The signature
 * must recover to the account's owner key (OwnableValidator, EIP-191 over the raw hash).
 */
export async function submitOwnerSignature(
  deps: AppDeps,
  op: OwnerOperationRow,
  signature: string,
  now: Date,
): Promise<{ userOpHash: Hex }> {
  const account = await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [op.account_id]);
  if (!account) throw new AgentBankError("not_found", "Account not found");
  const prepared = asPrepared(op.user_op);
  const hash = deps.chain.hashOperation(prepared);
  if (hash.toLowerCase() !== op.user_op_hash.toLowerCase()) {
    throw new AgentBankError("internal", "Stored owner operation does not match its hash");
  }
  let signer: string;
  try {
    signer = await recoverOperationSigner(hash, signature as Hex);
  } catch {
    throw new AgentBankError("signature_invalid", "Owner signature could not be recovered");
  }
  if (signer.toLowerCase() !== account.owner_address.toLowerCase()) {
    throw new AgentBankError(
      "owner_signature_required",
      "The signature was not produced by the account's owner key",
    );
  }
  if (op.expires_at.getTime() <= now.getTime()) {
    throw new AgentBankError("invalid_state", "The owner operation expired; prepare it again");
  }
  return onChain("submitOperation", () =>
    deps.chain.submitOperation({ op: prepared, signature: encodeOwnerSignature(signature as Hex) }),
  );
}
