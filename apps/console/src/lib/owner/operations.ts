import type { ResponseOf } from "@agentbank/core/api";

/**
 * Owner operations: on-chain operations (ERC-4337 user operations) that only
 * the owner key can authorize. Agent Bank prepares them; the owner signs the
 * raw 32 bytes of `user_op_hash` with EIP-191 and Agent Bank submits them.
 */

export type OwnerOperation = ResponseOf<"getOwnerOperation">;
export type OwnerOperationPurpose = OwnerOperation["purpose"];

/** Plain-language summary of each purpose, shown before the owner signs. */
export const OWNER_OPERATION_PURPOSES: Record<OwnerOperationPurpose, string> = {
  "session.install": "Install a session key on-chain (Smart Sessions)",
  "session.revoke": "Revoke a session key on-chain (the hard backstop)",
  "topup.configure": "Install or update the auto top-up executor on the treasury",
  "sweep.configure": "Install the treasury sweep executor",
  "vault.withdraw": "Withdraw early from a locked vault",
  payment: "A payment the owner key must sign",
  "account.deploy": "Deploy the smart account or create a locked vault on-chain",
  "owner.swap": "Swap the account's on-chain owner to a new key",
};

export function purposeLabel(purpose: string): string {
  return (OWNER_OPERATION_PURPOSES as Record<string, string>)[purpose] ?? purpose;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Only exactly 32 bytes are ever signed, so a compromised API cannot make the key sign other text. */
export function isOperationHash(value: string): value is `0x${string}` {
  return BYTES32.test(value);
}

/**
 * Idempotency key for submitting one signature: retries of the same signature
 * replay, while a signature from another key gets its own key.
 */
export function signatureIdempotencyKey(operationId: string, signature: string): string {
  return `oop_sig_${operationId}_${signature.slice(2, 18)}`;
}

/** Where the thing an operation applies to is shown in the console. */
export function operationHref(
  op: Pick<OwnerOperation, "purpose" | "subject_id" | "account_id">,
  agentOfAccount: (accountId: string) => string | null | undefined,
): string | null {
  const agentId = agentOfAccount(op.account_id);
  switch (op.purpose) {
    case "session.install":
    case "session.revoke":
      return agentId ? `/agents/${agentId}#sessions` : null;
    case "topup.configure":
      return `/agents/${op.subject_id}`;
    case "payment":
      return `/payments/${op.subject_id}`;
    case "owner.swap":
      return "/settings#owner";
    case "sweep.configure":
    case "vault.withdraw":
      return "/treasury";
    case "account.deploy":
      return op.subject_id.startsWith("vlt_") ? "/treasury" : agentId ? `/agents/${agentId}` : "/treasury";
  }
}
