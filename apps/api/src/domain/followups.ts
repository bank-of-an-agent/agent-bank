import {
  encodeSessionSignature,
  recoverOperationSigner,
  type Call,
  type PreparedOperation,
} from "@agentbank/chain";
import { AgentBankError, isAgentBankError, unixSeconds, type IntentInternal } from "@agentbank/core";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AccountRow, SessionRow } from "../db/rows";
import { one } from "../db/sql";
import type { AppDeps } from "../deps";
import type { AuthContext } from "../http/auth";
import { addSeconds } from "../util/time";
import { onChain } from "./chain";
import { recordDecision, denialReason } from "./decisions";

/**
 * Follow-up operations on existing escrows and streams (release, refund, dispute, cancel):
 * session-path operations of the acting account, co-signed like payments but without a hold
 * (no new money leaves the account). The agent signs `signing_request.user_op_hash` and submits
 * it to the escrow/stream signature route.
 */

/** The session that will sign: the caller's own session, or the account's newest active one. */
export async function signingSession(
  deps: AppDeps,
  auth: AuthContext,
  account: AccountRow,
  now: Date,
): Promise<SessionRow> {
  const session =
    auth.kind === "agent" && auth.accountId === account.id
      ? await one<SessionRow>(deps.db, "SELECT * FROM session_key WHERE id = $1", [auth.sessionId])
      : await one<SessionRow>(
          deps.db,
          `SELECT * FROM session_key WHERE account_id = $1 AND status = 'active' AND revoked_at IS NULL AND expires_at > $2
            ORDER BY created_at DESC LIMIT 1`,
          [account.id, now],
        );
  if (
    !session ||
    session.status !== "active" ||
    session.revoked_at ||
    session.expires_at.getTime() <= now.getTime()
  ) {
    throw new AgentBankError(
      "invalid_state",
      "The account has no installed, live session to sign this operation",
    );
  }
  if (!session.permission_id)
    throw new AgentBankError("invalid_state", "The session has no on-chain permission");
  return session;
}

export async function prepareFollowUp(
  deps: AppDeps,
  input: { account: AccountRow; session: SessionRow; calls: Call[]; now: Date },
): Promise<{ prepared: PreparedOperation; deadline: Date }> {
  const deadline = addSeconds(input.now, deps.config.paymentSignatureTtlSeconds);
  const prepared = await onChain("prepareOperation", () =>
    deps.chain.prepareOperation({
      account: getAddress(input.account.address),
      session: { permissionId: input.session.permission_id as Hex },
      calls: input.calls,
      validUntil: unixSeconds(deadline),
    }),
  );
  return { prepared, deadline: new Date(prepared.validUntil * 1000) };
}

/** Verify the session signature, have the co-signer co-sign, submit. Returns the user op hash. */
export async function cosignAndSubmit(
  deps: AppDeps,
  input: {
    account: AccountRow;
    sessionId: string;
    prepared: PreparedOperation;
    signature: string;
    /** Id the co-signer records the decision under (escrow or stream id). */
    subjectId: string;
    /** Post-lock action: one contract call and no outflow (`intent.amount` is "0"). */
    action: "escrow.release" | "escrow.refund" | "escrow.dispute" | "stream.cancel";
    onchainId: string;
    intent: IntentInternal;
    now: Date;
  },
): Promise<Hex> {
  const session = await one<SessionRow>(
    deps.db,
    "SELECT * FROM session_key WHERE id = $1 AND account_id = $2",
    [input.sessionId, input.account.id],
  );
  if (!session || session.status !== "active" || session.revoked_at) {
    throw new AgentBankError("session_revoked", "The signing session is not live");
  }
  if (session.expires_at.getTime() <= input.now.getTime())
    throw new AgentBankError("session_expired", "Session expired");
  const hash = deps.chain.hashOperation(input.prepared);
  let signer: string;
  try {
    signer = await recoverOperationSigner(hash, input.signature as Hex);
  } catch {
    throw new AgentBankError("signature_invalid", "Session signature could not be recovered");
  }
  if (signer.toLowerCase() !== session.public_key.toLowerCase()) {
    throw new AgentBankError("signature_invalid", "The signature was not produced by the session key");
  }
  const result = await deps.cosigner.cosign({
    payment_id: input.subjectId,
    org_id: input.account.org_id,
    agent_id: input.account.agent_id as string,
    account_id: input.account.id,
    account_address: getAddress(input.account.address),
    chain_id: deps.config.chain.id,
    session_id: session.id,
    operation: input.prepared as unknown as Record<string, unknown>,
    user_op_hash: hash,
    session_signature: input.signature,
    intent: { ...input.intent, amount: "0" },
    fee: "0",
    action: input.action,
    onchain_id: input.onchainId,
  });
  if (result.decision.outcome !== "allow" || !result.signature) {
    await recordDecision(deps.db, {
      decision: result.decision,
      agentId: input.account.agent_id as string,
      paymentId: null,
      source: "cosigner",
      now: input.now,
    });
    throw new AgentBankError("policy_denied", denialReason(result.decision), { decision: result.decision });
  }
  const signature = encodeSessionSignature({
    permissionId: session.permission_id as Hex,
    sessionSignature: input.signature as Hex,
    cosignerSignature: result.signature as Hex,
  });
  const { userOpHash } = await onChain("submitOperation", () =>
    deps.chain.submitOperation({ op: input.prepared, signature }),
  );
  return userOpHash;
}

/** Relay a permissionless keeper call (stream settle, refund after expiry, top-up). */
export async function relay(deps: AppDeps, call: Call): Promise<Hex> {
  const relayer = deps.config.relayerKey ? privateKeyToAccount(deps.config.relayerKey) : undefined;
  if (!relayer && deps.config.chain.name !== "simulated") {
    throw new AgentBankError("invalid_state", "No relayer is configured (API_RELAYER_KEY)");
  }
  const { txHash } = await onChain("relayCall", () =>
    deps.chain.relayCall({ call, ...(relayer ? { relayer } : {}) }),
  );
  return txHash;
}

const RESTART_CODES = new Set([
  "policy_denied",
  "invalid_state",
  "chain_error",
  "session_revoked",
  "session_expired",
]);

/**
 * Run a follow-up's co-signing and submission. When it fails in a way a new signature cannot
 * fix (refused, stale nonce or deadline, dead session), the pending action is cleared so the
 * caller can start it again; a bad signature or a co-signer outage leaves it signable.
 */
export async function submitFollowUp<T>(
  deps: AppDeps,
  table: "escrow" | "stream",
  id: string,
  now: Date,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAgentBankError(error) && RESTART_CODES.has(error.code)) {
      await deps.db.query(
        `UPDATE ${table} SET pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL,
                op_deadline = NULL, updated_at = $2
          WHERE id = $1 AND op_submitted_at IS NULL`,
        [id, now],
      );
    }
    throw error;
  }
}
