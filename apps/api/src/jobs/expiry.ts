import type { Hex } from "viem";
import type { AccountRow, ApprovalRow, OwnerOperationRow, PaymentRow } from "../db/rows";
import { all, one } from "../db/sql";
import { usdcAddress } from "../domain/chain";
import { expirePayment, paymentById } from "../domain/payments";
import { settleCarriedPermit } from "../domain/owner-ops";
import { clearVaultPending } from "../domain/receipts";
import type { AppDeps } from "../deps";
import { expireApproval } from "../routes/approvals";

/**
 * Expiry (worker): payments whose signing deadline passed, approvals past their 15 minutes,
 * owner operations nobody signed, x402 authorizations nobody used, payment requests, sessions,
 * and stale escrow/stream follow-up operations. Holds are voided and the co-signer told.
 */

/** Grace after an x402 authorization's validBefore before its hold is released. */
const X402_GRACE_SECONDS = 600;

export async function expirePending(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  let changed = 0;

  const unsigned = await all<PaymentRow>(
    deps.db,
    `SELECT * FROM payment WHERE status = 'requires_signature' AND kind <> 'x402' AND owner_operation_id IS NULL
        AND signature_deadline IS NOT NULL AND signature_deadline <= $1 LIMIT 200`,
    [now],
  );
  for (const payment of unsigned) {
    await expirePayment(deps, payment, now);
    changed++;
  }

  const approvals = await all<ApprovalRow>(
    deps.db,
    "SELECT * FROM approval WHERE status = 'pending' AND expires_at <= $1 LIMIT 200",
    [now],
  );
  for (const approval of approvals) {
    await expireApproval(deps, approval, now);
    changed++;
  }

  const ops = await all<OwnerOperationRow>(
    deps.db,
    "SELECT * FROM owner_operation WHERE status = 'requires_signature' AND expires_at <= $1 LIMIT 200",
    [now],
  );
  for (const op of ops) {
    await deps.db.query(
      "UPDATE owner_operation SET status = 'expired', updated_at = $2 WHERE id = $1 AND status = 'requires_signature'",
      [op.id, now],
    );
    if (op.purpose === "payment") {
      const payment = await one<PaymentRow>(deps.db, "SELECT * FROM payment WHERE owner_operation_id = $1", [
        op.id,
      ]);
      if (payment && payment.status === "requires_signature") await expirePayment(deps, payment, now);
    }
    await clearVaultPending(deps.db, op.id);
    await settleCarriedPermit(deps.db, op, "expired", now);
    changed++;
  }

  // x402: release the float only when the authorization can no longer be used and was not.
  const x402 = await all<PaymentRow>(
    deps.db,
    `SELECT * FROM payment WHERE status = 'requires_signature' AND kind = 'x402'
        AND signature_deadline IS NOT NULL AND signature_deadline <= $1 LIMIT 200`,
    [new Date(now.getTime() - X402_GRACE_SECONDS * 1000)],
  );
  for (const payment of x402) {
    const account = await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [
      payment.account_id,
    ]);
    if (!account?.spend_key_address || !payment.x402_nonce) continue;
    let used: boolean;
    try {
      used = await deps.chain.authorizationState(
        usdcAddress(deps),
        account.spend_key_address as Hex,
        payment.x402_nonce as Hex,
      );
    } catch (error) {
      deps.logger.warn({ err: error, paymentId: payment.id }, "authorizationState failed; retrying later");
      continue;
    }
    if (used) continue; // settled on-chain: the reconciler posts it
    const fresh = await paymentById(deps.db, payment.id);
    if (fresh?.status === "requires_signature") {
      await expirePayment(deps, fresh, now);
      changed++;
    }
  }

  const requests = await deps.db.query(
    "UPDATE payment_request SET status = 'expired' WHERE status = 'open' AND expires_at <= $1",
    [now],
  );
  changed += requests.rowCount;
  const sessions = await deps.db.query(
    "UPDATE session_key SET status = 'expired' WHERE status IN ('pending_install', 'active') AND expires_at <= $1",
    [now],
  );
  changed += sessions.rowCount;
  for (const table of ["escrow", "stream"] as const) {
    const stale = await deps.db.query(
      `UPDATE ${table} SET pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL,
              op_deadline = NULL, updated_at = $1
        WHERE pending_action IS NOT NULL AND pending_action NOT IN ('lock', 'create')
          AND op_submitted_at IS NULL AND op_deadline IS NOT NULL AND op_deadline <= $1`,
      [now],
    );
    changed += stale.rowCount;
  }
  return changed;
}

/** Housekeeping: spent nonces, old idempotency records, used challenges, expired console sessions. */
export async function prune(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const day = 86_400_000;
  let removed = 0;
  removed += (
    await deps.db.query("DELETE FROM request_nonce WHERE expires_at < $1", [
      new Date(now.getTime() - 3_600_000),
    ])
  ).rowCount;
  removed += (
    await deps.db.query("DELETE FROM idempotency_record WHERE created_at < $1", [
      new Date(now.getTime() - 7 * day),
    ])
  ).rowCount;
  removed += (
    await deps.db.query("DELETE FROM webauthn_challenge WHERE expires_at < $1", [
      new Date(now.getTime() - day),
    ])
  ).rowCount;
  removed += (
    await deps.db.query("DELETE FROM console_session WHERE expires_at < $1", [
      new Date(now.getTime() - 30 * day),
    ])
  ).rowCount;
  return removed;
}
