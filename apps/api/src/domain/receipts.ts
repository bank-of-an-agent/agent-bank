import type { OperationReceipt } from "@agentbank/chain";
import { AgentBankError } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { getAddress, isAddress, type Hex } from "viem";
import type { EscrowRow, OwnerOperationRow, PaymentRow, StreamRow } from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import { audit } from "./audit";
import { settleCarriedPermit } from "./owner-ops";
import { failPayment, NOT_FOUND_GRACE_SECONDS, processPaymentReceipt } from "./payments";

/**
 * Receipt polling for operations the API submitted. Division of labor with the reconciler
 * (`@agentbank/reconciliation`, fed by the indexer): money movements and their statuses
 * (`settled`, `locked`, `released`, `refunded`, `active`, …) come from chain evidence there.
 * Here the API handles what only it knows about:
 *
 * - owner operations: `succeeded` / `failed`, plus non-money effects of success (a session
 *   becomes `active`, an executor rule `active`, a locked vault gets its on-chain id);
 * - failures of anything it submitted (reverted or dropped operations): holds are voided and
 *   the co-signer is told to release the spend; pending escrow/stream actions are cleared.
 */

async function receiptOf(deps: AppDeps, userOpHash: string): Promise<OperationReceipt | undefined> {
  try {
    return await deps.chain.getOperationReceipt(userOpHash as Hex);
  } catch (error) {
    deps.logger.warn({ err: error, userOpHash }, "receipt lookup failed");
    return undefined;
  }
}

function dropped(receipt: OperationReceipt, since: Date, now: Date): boolean {
  return receipt.status === "not_found" && now.getTime() - since.getTime() >= NOT_FOUND_GRACE_SECONDS * 1000;
}

/** A vault's pending operation (create, owner-path deposit, early withdrawal) ended. */
export async function clearVaultPending(db: SqlClient, opId: string): Promise<void> {
  await db.query("UPDATE vault SET pending_operation_id = NULL WHERE pending_operation_id = $1", [opId]);
}

/** Advance one submitted owner operation from its receipt. Returns the current row. */
export async function processOwnerOperation(
  deps: AppDeps,
  id: string,
  now: Date,
): Promise<OwnerOperationRow> {
  const op = await one<OwnerOperationRow>(deps.db, "SELECT * FROM owner_operation WHERE id = $1", [id]);
  if (!op) throw new AgentBankError("not_found", "Owner operation not found");
  if (op.status !== "submitted") return op;
  const receipt = await receiptOf(deps, op.user_op_hash);
  if (!receipt || receipt.status === "pending") return op;
  if (receipt.status === "succeeded") {
    return deps.db.transaction(async (tx) => {
      const row = (await one<OwnerOperationRow>(
        tx,
        "UPDATE owner_operation SET status = 'succeeded', tx_hash = $2, updated_at = $3 WHERE id = $1 RETURNING *",
        [op.id, receipt.txHash, now],
      )) as OwnerOperationRow;
      await tx.query("UPDATE account SET deployed = true WHERE id = $1", [op.account_id]);
      switch (op.purpose) {
        case "session.install":
          await tx.query(
            `UPDATE session_key SET status = 'active', onchain_tx = $2
              WHERE id = $1 AND status = 'pending_install'`,
            [op.subject_id, receipt.txHash],
          );
          break;
        case "topup.configure":
          await tx.query(
            "UPDATE auto_topup_rule SET status = 'active', updated_at = $2 WHERE install_operation_id = $1",
            [op.id, now],
          );
          break;
        case "sweep.configure":
          await tx.query("UPDATE sweep_rule SET status = 'active' WHERE install_operation_id = $1", [op.id]);
          break;
        case "account.deploy": {
          // Locked-vault creation: the vault id assigned by TimeLockVaults is in this operation's receipt.
          const created = receipt.logs.find((l) => l.eventName === "VaultCreated");
          const vaultId = created?.args.id;
          if (op.subject_id.startsWith("vlt_") && vaultId !== undefined && vaultId !== null) {
            await tx.query("UPDATE vault SET onchain_id = $2, pending_operation_id = NULL WHERE id = $1", [
              op.subject_id,
              String(vaultId),
            ]);
          }
          break;
        }
        case "vault.withdraw":
          // An early withdrawal consumed the vault owner's EIP-712 nonce (TimeLockVaults).
          await tx.query("UPDATE vault SET early_nonce = early_nonce + 1 WHERE id = $1", [op.subject_id]);
          break;
        case "session.revoke":
          await tx.query("UPDATE session_key SET onchain_tx = $2 WHERE id = $1", [
            op.subject_id,
            receipt.txHash,
          ]);
          break;
        case "owner.swap":
          // `ownerRotationCalls` moved the Safe owner and the OwnableValidator owner to the new key
          // (subject_id): it now signs this account's owner operations.
          if (isAddress(op.subject_id)) {
            const previous = await one<{ owner_address: string }>(
              tx,
              "SELECT owner_address FROM account WHERE id = $1",
              [op.account_id],
            );
            await tx.query("UPDATE account SET owner_address = $2 WHERE id = $1", [
              op.account_id,
              getAddress(op.subject_id),
            ]);
            await audit(tx, now, {
              actor: "system",
              action: "account.owner_rotated",
              subject: op.account_id,
              payload: {
                owner_operation_id: op.id,
                previous_owner_address: previous?.owner_address ?? null,
                new_owner_address: getAddress(op.subject_id),
              },
            });
          }
          break;
        default:
          // payment: money movements are posted by the reconciler.
          break;
      }
      await clearVaultPending(tx, op.id);
      await settleCarriedPermit(tx, op, "succeeded", now);
      return row;
    });
  }
  if (receipt.status === "not_found" && !dropped(receipt, op.updated_at, now)) return op;
  const failed =
    (await one<OwnerOperationRow>(
      deps.db,
      "UPDATE owner_operation SET status = 'failed', tx_hash = $2, updated_at = $3 WHERE id = $1 AND status = 'submitted' RETURNING *",
      [op.id, receipt.txHash, now],
    )) ?? op;
  if (op.purpose === "payment") {
    const payment = await one<PaymentRow>(deps.db, "SELECT * FROM payment WHERE owner_operation_id = $1", [
      op.id,
    ]);
    if (payment && payment.status === "submitted") {
      await failPayment(
        deps,
        payment,
        `Owner operation ${receipt.status === "reverted" ? "reverted" : "was dropped"}`,
        now,
        receipt.txHash,
      );
    }
  }
  await clearVaultPending(deps.db, op.id);
  await settleCarriedPermit(deps.db, op, "failed", now);
  return failed;
}

async function processEscrowAction(deps: AppDeps, escrow: EscrowRow, now: Date): Promise<boolean> {
  if (!escrow.user_op_hash || !escrow.op_submitted_at) return false;
  const receipt = await receiptOf(deps, escrow.user_op_hash);
  if (!receipt || receipt.status === "pending") return false;
  if (receipt.status === "succeeded") {
    // The reconciler moves the escrow to released/refunded/disputed from the contract's events.
    await deps.db.query(
      `UPDATE escrow SET tx_hash = $2, pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL,
              op_deadline = NULL, op_submitted_at = NULL, updated_at = $3
        WHERE id = $1`,
      [escrow.id, receipt.txHash, now],
    );
    return true;
  }
  if (receipt.status === "not_found" && !dropped(receipt, escrow.op_submitted_at, now)) return false;
  deps.logger.warn(
    { escrowId: escrow.id, action: escrow.pending_action, reason: receipt.revertReason },
    "escrow action failed on-chain",
  );
  await deps.db.query(
    `UPDATE escrow SET pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL, op_deadline = NULL,
            op_submitted_at = NULL, updated_at = $2
      WHERE id = $1`,
    [escrow.id, now],
  );
  return true;
}

async function processStreamAction(deps: AppDeps, stream: StreamRow, now: Date): Promise<boolean> {
  if (!stream.user_op_hash || !stream.op_submitted_at) return false;
  const receipt = await receiptOf(deps, stream.user_op_hash);
  if (!receipt || receipt.status === "pending") return false;
  if (receipt.status === "succeeded") {
    await deps.db.query(
      `UPDATE stream SET tx_hash = $2, pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL,
              op_deadline = NULL, op_submitted_at = NULL, updated_at = $3
        WHERE id = $1`,
      [stream.id, receipt.txHash, now],
    );
    return true;
  }
  if (receipt.status === "not_found" && !dropped(receipt, stream.op_submitted_at, now)) return false;
  deps.logger.warn(
    { streamId: stream.id, action: stream.pending_action, reason: receipt.revertReason },
    "stream action failed on-chain",
  );
  await deps.db.query(
    `UPDATE stream SET pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL, op_deadline = NULL,
            op_submitted_at = NULL, updated_at = $2
      WHERE id = $1`,
    [stream.id, now],
  );
  return true;
}

/** Worker job: poll receipts of everything the API submitted and is still waiting on. */
export async function pollReceipts(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  let changed = 0;
  const ops = await all<{ id: string }>(
    deps.db,
    "SELECT id FROM owner_operation WHERE status = 'submitted' ORDER BY updated_at LIMIT 200",
  );
  for (const { id } of ops) {
    const after = await processOwnerOperation(deps, id, now);
    if (after.status !== "submitted") changed++;
  }
  const payments = await all<PaymentRow>(
    deps.db,
    "SELECT * FROM payment WHERE status = 'submitted' AND owner_operation_id IS NULL AND kind <> 'x402' ORDER BY updated_at LIMIT 200",
  );
  for (const payment of payments) {
    const after = await processPaymentReceipt(deps, payment, now);
    if (after && after.status !== "submitted") changed++;
  }
  const escrows = await all<EscrowRow>(
    deps.db,
    "SELECT * FROM escrow WHERE pending_action IS NOT NULL AND op_submitted_at IS NOT NULL ORDER BY updated_at LIMIT 200",
  );
  for (const escrow of escrows) if (await processEscrowAction(deps, escrow, now)) changed++;
  const streams = await all<StreamRow>(
    deps.db,
    "SELECT * FROM stream WHERE pending_action IS NOT NULL AND op_submitted_at IS NOT NULL ORDER BY updated_at LIMIT 200",
  );
  for (const stream of streams) if (await processStreamAction(deps, stream, now)) changed++;
  return changed;
}
