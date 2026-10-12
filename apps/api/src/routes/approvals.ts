import { AgentBankError } from "@agentbank/core";
import { isUniqueViolation, type SqlClient, type SqlParam } from "@agentbank/db";
import type { ApprovalDecisionRow, ApprovalRow, PaymentRow, PolicyDecisionRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { actorOf, audit } from "../domain/audit";
import { emitEvent } from "../domain/events";
import { advancePayment, closePayment, paymentById } from "../domain/payments";
import type { AppDeps } from "../deps";
import { requireApprover, requirePrincipal } from "../http/auth";
import { verifyApprovalAssertion } from "../http/console-auth";
import type { Handlers } from "../http/registry";
import { serializeApproval } from "../serializers";
import { addSeconds } from "../util/time";

/** The wire Approval (with the policy decision that required it and the decisions so far). */
export async function approvalView(db: SqlClient, approval: ApprovalRow, now: Date) {
  const payment = (await paymentById(db, approval.payment_id)) as PaymentRow;
  const decisions = await all<ApprovalDecisionRow>(
    db,
    "SELECT * FROM approval_decision WHERE approval_id = $1 ORDER BY signed_at, member_id",
    [approval.id],
  );
  const decision = payment.decision_id
    ? await one<PolicyDecisionRow>(db, "SELECT * FROM policy_decision WHERE id = $1", [payment.decision_id])
    : undefined;
  return serializeApproval(approval, payment, decisions, decision ?? null, now);
}

async function loadApproval(db: SqlClient, orgId: string, id: string): Promise<ApprovalRow> {
  const row = await one<ApprovalRow>(db, "SELECT * FROM approval WHERE id = $1 AND org_id = $2", [id, orgId]);
  if (!row) throw new AgentBankError("not_found", "Approval not found");
  return row;
}

/** Expire a pending approval whose 15 minutes ran out (the payment expires and its hold is voided). */
export async function expireApproval(deps: AppDeps, approval: ApprovalRow, now: Date): Promise<void> {
  const payment = await paymentById(deps.db, approval.payment_id);
  if (payment && payment.status === "requires_approval") {
    await closePayment(deps, payment, "expired", "approval expired", now, "payment.failed");
  }
  await deps.db.query("UPDATE approval SET status = 'expired' WHERE id = $1 AND status = 'pending'", [
    approval.id,
  ]);
}

export const approvalHandlers: Pick<Handlers, "listApprovals" | "getApproval" | "decideApproval"> = {
  async listApprovals({ query }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    let where = "org_id = $1";
    if (query.status === "pending") {
      params.push(now);
      where += ` AND status = 'pending' AND expires_at > $${params.length}`;
    } else if (query.status === "expired") {
      params.push(now);
      where += ` AND (status = 'expired' OR (status = 'pending' AND expires_at <= $${params.length}))`;
    } else if (query.status) {
      params.push(query.status);
      where += ` AND status = $${params.length}`;
    }
    const sql = `SELECT * FROM approval WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<ApprovalRow>(deps.db, sql, params), query.limit);
    const data = [];
    for (const a of page.items) data.push(await approvalView(deps.db, a, now));
    return { data, next_cursor: page.nextCursor };
  },

  async getApproval({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    return approvalView(deps.db, await loadApproval(deps.db, principal.orgId, params.id), now);
  },

  async decideApproval({ params, body }, { deps, auth, now }) {
    const approver = requireApprover(auth);
    const approval = await loadApproval(deps.db, approver.orgId, params.id);
    if (approval.status !== "pending") {
      if (approval.status === "expired") throw new AgentBankError("approval_expired", "The approval expired");
      throw new AgentBankError("invalid_state", `The approval is already ${approval.status}`);
    }
    if (approval.expires_at.getTime() <= now.getTime()) {
      await expireApproval(deps, approval, now);
      throw new AgentBankError("approval_expired", "The approval expired");
    }
    // Console members prove presence with a passkey; API keys with approvals:decide are trusted
    // automation issued to the member (ADR 0012: the co-signer trusts API-attested approvals).
    if (approver.via === "console") {
      if (!body.webauthn_assertion) {
        throw new AgentBankError(
          "signature_invalid",
          "A passkey assertion is required (POST /auth/approvals/{id}/options)",
        );
      }
      await verifyApprovalAssertion(deps, {
        memberId: approver.memberId,
        approvalId: approval.id,
        decision: body.decision,
        assertion: body.webauthn_assertion,
        now,
      });
    }
    const outcome = await deps.db.transaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO approval_decision (approval_id, member_id, decision, assertion, signed_at) VALUES ($1, $2, $3, $4, $5)`,
          [approval.id, approver.memberId, body.decision, body.webauthn_assertion ?? null, now],
        );
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AgentBankError("conflict", "This member already decided this approval");
        throw error;
      }
      const counts = await one<{ approves: bigint }>(
        tx,
        "SELECT count(*) FILTER (WHERE decision = 'approve')::bigint AS approves FROM approval_decision WHERE approval_id = $1",
        [approval.id],
      );
      let status: ApprovalRow["status"] = "pending";
      if (body.decision === "deny") status = "denied";
      else if ((counts?.approves ?? 0n) >= BigInt(approval.required_approvers)) status = "approved";
      const updated = (await one<ApprovalRow>(
        tx,
        "UPDATE approval SET status = $2 WHERE id = $1 RETURNING *",
        [approval.id, status],
      )) as ApprovalRow;
      if (status === "approved") {
        await tx.query(
          `UPDATE payment SET status = 'requires_signature', signature_deadline = $2, updated_at = $3
            WHERE id = $1 AND status = 'requires_approval'`,
          [approval.payment_id, addSeconds(now, deps.config.paymentSignatureTtlSeconds), now],
        );
      }
      await emitEvent(tx, now, {
        orgId: approval.org_id,
        type: "approval.decided",
        data: await approvalView(tx, updated, now),
      });
      await audit(tx, now, {
        actor: actorOf(auth),
        action: `approval.${body.decision}`,
        subject: approval.id,
        payload: { member_id: approver.memberId, status, passkey: approver.via === "console" },
      });
      return updated;
    });
    const payment = (await paymentById(deps.db, approval.payment_id)) as PaymentRow;
    if (outcome.status === "denied") {
      await closePayment(deps, payment, "denied", "denied by an approver", now, "payment.denied");
    } else if (outcome.status === "approved") {
      await advancePayment(deps, payment, now);
    }
    return approvalView(deps.db, outcome, now);
  },
};
