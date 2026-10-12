import {
  escrowDisputeCall,
  escrowRefundCall,
  escrowReleaseByValidationCall,
  escrowReleaseCall,
} from "@agentbank/chain";
import {
  AgentBankError,
  canonicalSha256,
  newId,
  toPositiveMinor,
  type DecisionInternal,
} from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { getAddress, keccak256, stringToHex, type Address } from "viem";
import type { AccountRow, EscrowRow, PaymentRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { accountByAddress, accountById, loadAccount, partyClause } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { escrowFee } from "../domain/billing";
import { asPrepared, contractAddress } from "../domain/chain";
import { denialReason } from "../domain/decisions";
import { cosignAndSubmit, prepareFollowUp, relay, signingSession, submitFollowUp } from "../domain/followups";
import { createPaymentRecord, paymentById, submitSessionSignature } from "../domain/payments";
import type { AppDeps } from "../deps";
import { requireAgent, type AuthContext } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeEscrow } from "../serializers";
import { assertMandateUsable, resolvePayee, screenCounterparty } from "./payments";

const MAX_ESCROW_SECONDS = 365 * 24 * 3600;

export function assertEscrowEnabled(deps: AppDeps): void {
  if (!deps.config.features.escrow)
    throw new AgentBankError("feature_gated", "Escrow is not enabled on this deployment");
}

interface EscrowAccess {
  escrow: EscrowRow;
  role: "payer" | "payee";
  /** The caller's account in that role (payer account, or the payee's Agent Bank account). */
  account: AccountRow;
}

/** An escrow visible to the caller as payer or payee (agents: their own account only). */
async function loadEscrow(deps: AppDeps, auth: AuthContext, id: string): Promise<EscrowAccess> {
  const escrow = await one<EscrowRow>(deps.db, "SELECT * FROM escrow WHERE id = $1", [id]);
  if (!escrow) throw new AgentBankError("not_found", "Escrow not found");
  const payer = (await accountById(deps.db, escrow.payer_account_id)) as AccountRow;
  const payee = await accountByAddress(deps.db, payer.chain_id, escrow.payee_address);
  if (auth.kind === "agent") {
    if (auth.accountId === payer.id) return { escrow, role: "payer", account: payer };
    if (payee && auth.accountId === payee.id) return { escrow, role: "payee", account: payee };
  } else if (auth.kind === "principal") {
    if (payer.org_id === auth.orgId) return { escrow, role: "payer", account: payer };
    if (payee && payee.org_id === auth.orgId) return { escrow, role: "payee", account: payee };
  }
  throw new AgentBankError("not_found", "Escrow not found");
}

function intentOf(escrow: EscrowRow) {
  return {
    kind: "escrow" as const,
    amount: escrow.amount.toString(),
    asset: "USDC" as const,
    counterparty: {
      address: escrow.payee_address,
      contract: escrow.contract_address,
      ...(escrow.payee_agent_id ? { agent_id: escrow.payee_agent_id } : {}),
    },
  };
}

async function startAction(
  deps: AppDeps,
  auth: AuthContext,
  access: EscrowAccess,
  action: "release" | "refund" | "dispute",
  call: ReturnType<typeof escrowReleaseCall>,
  now: Date,
  extra: { disputeReason?: string } = {},
): Promise<EscrowRow> {
  const session = await signingSession(deps, auth, access.account, now);
  const { prepared, deadline } = await prepareFollowUp(deps, {
    account: access.account,
    session,
    calls: [call],
    now,
  });
  return (await one<EscrowRow>(
    deps.db,
    `UPDATE escrow SET pending_action = $2, user_op = $3, user_op_hash = $4, op_session_id = $5, op_deadline = $6,
            op_submitted_at = NULL, dispute_reason = COALESCE($7, dispute_reason), updated_at = $8
      WHERE id = $1 RETURNING *`,
    [
      access.escrow.id,
      action,
      prepared as unknown as object,
      prepared.userOpHash,
      session.id,
      deadline,
      extra.disputeReason ?? null,
      now,
    ],
  )) as EscrowRow;
}

function assertOnchain(escrow: EscrowRow): bigint {
  if (!escrow.onchain_id) throw new AgentBankError("invalid_state", "The escrow is not locked on-chain yet");
  return BigInt(escrow.onchain_id);
}

export const escrowHandlers: Pick<
  Handlers,
  | "createEscrow"
  | "listEscrows"
  | "getEscrow"
  | "submitEscrowSignature"
  | "releaseEscrow"
  | "refundEscrow"
  | "disputeEscrow"
> = {
  async createEscrow({ body }, { deps, auth, now, idempotencyKey }) {
    assertEscrowEnabled(deps);
    const agent = requireAgent(auth);
    const account = await loadAccount(deps.db, agent, body.account_id);
    const contract = contractAddress(deps, "escrow");
    const key = idempotencyKey as string;
    const existing = await one<EscrowRow>(
      deps.db,
      `SELECT e.* FROM escrow e JOIN payment p ON p.id = e.payment_id WHERE p.account_id = $1 AND p.idempotency_key = $2`,
      [account.id, key],
    );
    if (existing) return new Envelope(serializeEscrow(existing, deps.config.chain.id), 201);

    const amount = toPositiveMinor(body.amount);
    const expiresAt = new Date(body.expires_at);
    if (
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() - now.getTime() > MAX_ESCROW_SECONDS * 1000
    ) {
      throw new AgentBankError("invalid_request", "expires_at must be in the future and within 365 days");
    }
    if (body.release === "arbiter" && !body.arbiter)
      throw new AgentBankError("invalid_request", "release=arbiter needs an arbiter");
    if (body.release === "validator" && !body.validator) {
      throw new AgentBankError("invalid_request", "release=validator needs a validator");
    }
    if (body.validator && body.validator.min_response < 1) {
      // AgentEscrow.lock: validationThreshold must be 1–100 when a validator is configured.
      throw new AgentBankError("invalid_request", "validator.min_response must be between 1 and 100");
    }
    const payee = await resolvePayee(deps, account, body.payee);
    if (payee.refill)
      throw new AgentBankError("invalid_request", "An escrow cannot pay the account's own spend key");
    if (
      body.arbiter &&
      [payee.address, account.address].some((a) => a.toLowerCase() === body.arbiter?.toLowerCase())
    ) {
      throw new AgentBankError("invalid_request", "The arbiter must be neither the payer nor the payee");
    }
    if (body.mandate_id) await assertMandateUsable(deps.db, agent.agentId, body.mandate_id, now);
    const fee = escrowFee(amount);
    let decision: DecisionInternal | null = await screenCounterparty(deps, payee.address, now);
    let source: "api" | "cosigner" = "api";
    if (!decision) {
      decision = await deps.cosigner.evaluate({
        org_id: account.org_id,
        agent_id: agent.agentId,
        account_id: account.id,
        account_address: getAddress(account.address),
        chain_id: deps.config.chain.id,
        intent: {
          kind: "escrow",
          amount: amount.toString(),
          asset: "USDC",
          counterparty: {
            address: payee.address,
            contract,
            ...(payee.agentId ? { agent_id: payee.agentId } : {}),
          },
        },
        ...(body.mandate_id ? { mandate_id: body.mandate_id } : {}),
        session_id: agent.sessionId,
      });
      source = "cosigner";
    }
    if (decision.outcome === "deny") {
      throw new AgentBankError("policy_denied", denialReason(decision), { decision });
    }
    const escrowId = newId("escrow", now.getTime());
    const payment = await createPaymentRecord(
      deps,
      {
        account,
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        kind: "escrow",
        amount,
        fee,
        counterparty: {
          counterparty_type: "escrow",
          counterparty_address: contract,
          counterparty_agent_id: payee.agentId,
          counterparty_x402_domain: null,
        },
        memo: body.memo ?? null,
        mandateId: body.mandate_id ?? null,
        paymentRequestId: null,
        metadata: {},
        escrowId,
        idempotencyKey: key,
        requestHash: canonicalSha256(body),
        decision,
        decisionSource: source,
      },
      now,
      async (tx, p) => {
        await tx.query(
          `INSERT INTO escrow (id, payer_account_id, payee_address, payee_agent_id, amount, fee, asset, status, release_mode,
                               arbiter, validator_json, terms_hash, contract_address, expires_at, pending_action, payment_id,
                               memo, mandate_id, org_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'USDC', 'requires_signature', $7, $8, $9, $10, $11, $12, 'lock', $13, $14, $15, $16,
                   $17, $17)`,
          [
            escrowId,
            account.id,
            payee.address,
            payee.agentId,
            amount,
            fee,
            body.release,
            body.arbiter ? getAddress(body.arbiter) : null,
            body.validator ?? null,
            body.terms ? keccak256(stringToHex(body.terms)) : null,
            contract,
            expiresAt,
            p.id,
            body.memo ?? null,
            body.mandate_id ?? null,
            account.org_id,
            now,
          ],
        );
      },
    );
    const escrow = (await one<EscrowRow>(deps.db, "SELECT * FROM escrow WHERE payment_id = $1", [
      payment.id,
    ])) as EscrowRow;
    return new Envelope(serializeEscrow(escrow, deps.config.chain.id), 201);
  },

  async listEscrows({ query }, { deps, auth }) {
    const params: SqlParam[] = [];
    let where = await partyClause(deps.db, auth, "e", query.account_id, params);
    if (where === null) return { data: [], next_cursor: null };
    if (query.status) {
      params.push(query.status);
      where += ` AND e.status = $${params.length}`;
    }
    const sql = `SELECT e.* FROM escrow e WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params, "e")}`;
    const page = toPage(await all<EscrowRow>(deps.db, sql, params), query.limit);
    return {
      data: page.items.map((row) => serializeEscrow(row, deps.config.chain.id)),
      next_cursor: page.nextCursor,
    };
  },

  async getEscrow({ params }, { deps, auth }) {
    const { escrow } = await loadEscrow(deps, auth, params.id);
    return serializeEscrow(escrow, deps.config.chain.id);
  },

  async submitEscrowSignature({ params, body }, { deps, auth, now }) {
    assertEscrowEnabled(deps);
    const agent = requireAgent(auth);
    const access = await loadEscrow(deps, agent, params.id);
    const { escrow } = access;
    if (escrow.pending_action === "lock") {
      if (access.role !== "payer") throw new AgentBankError("not_found", "Escrow not found");
      const payment = (await paymentById(deps.db, escrow.payment_id as string)) as PaymentRow;
      await submitSessionSignature(
        deps,
        payment,
        { sessionId: body.session_id, signature: body.signature },
        now,
      );
    } else if (escrow.pending_action && escrow.user_op && !escrow.op_submitted_at) {
      if (escrow.op_session_id !== body.session_id) {
        throw new AgentBankError(
          "invalid_request",
          "Sign with the session named in signing_request.session_id",
        );
      }
      if (escrow.op_deadline && escrow.op_deadline.getTime() <= now.getTime()) {
        await deps.db.query(
          "UPDATE escrow SET pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL, op_deadline = NULL, updated_at = $2 WHERE id = $1",
          [escrow.id, now],
        );
        throw new AgentBankError("invalid_state", "The signing deadline passed; start the action again");
      }
      const userOpHash = await submitFollowUp(deps, "escrow", escrow.id, now, () =>
        cosignAndSubmit(deps, {
          account: access.account,
          sessionId: body.session_id,
          prepared: asPrepared(escrow.user_op),
          signature: body.signature,
          subjectId: `${escrow.id}:${escrow.pending_action}:${escrow.user_op_hash}`,
          action: `escrow.${escrow.pending_action as "release" | "refund" | "dispute"}`,
          onchainId: escrow.onchain_id as string,
          intent: intentOf(escrow),
          now,
        }),
      );
      await deps.db.query(
        "UPDATE escrow SET user_op_hash = $2, op_submitted_at = $3, updated_at = $3 WHERE id = $1",
        [escrow.id, userOpHash, now],
      );
    } else if (escrow.op_submitted_at || escrow.status === "locking") {
      // Already submitted: idempotent.
    } else {
      throw new AgentBankError("invalid_state", "The escrow has no operation waiting for a signature");
    }
    const updated = (await one<EscrowRow>(deps.db, "SELECT * FROM escrow WHERE id = $1", [
      escrow.id,
    ])) as EscrowRow;
    return serializeEscrow(updated, deps.config.chain.id);
  },

  async releaseEscrow({ params }, { deps, auth, now }) {
    assertEscrowEnabled(deps);
    const access = await loadEscrow(deps, auth, params.id);
    const { escrow } = access;
    if (access.role !== "payer") throw new AgentBankError("forbidden", "Only the payer releases an escrow");
    if (escrow.status !== "locked")
      throw new AgentBankError("invalid_state", `A ${escrow.status} escrow cannot be released`);
    if (escrow.pending_action)
      throw new AgentBankError("invalid_state", `A ${escrow.pending_action} is already in progress`);
    const escrowId = assertOnchain(escrow);
    const contract = getAddress(escrow.contract_address) as Address;
    if (escrow.release_mode === "arbiter") {
      throw new AgentBankError("invalid_state", "This escrow is released by its arbiter on-chain");
    }
    let updated: EscrowRow;
    if (escrow.release_mode === "validator") {
      // Anyone may release once the ERC-8004 validator approved: a keeper relays it.
      const txHash = await relay(deps, escrowReleaseByValidationCall({ escrow: contract, escrowId }));
      updated = (await one<EscrowRow>(
        deps.db,
        "UPDATE escrow SET tx_hash = $2, updated_at = $3 WHERE id = $1 RETURNING *",
        [escrow.id, txHash, now],
      )) as EscrowRow;
    } else {
      updated = await startAction(
        deps,
        auth,
        access,
        "release",
        escrowReleaseCall({ escrow: contract, escrowId }),
        now,
      );
    }
    await audit(deps.db, now, {
      actor: actorOf(auth),
      action: "escrow.release_requested",
      subject: escrow.id,
    });
    return serializeEscrow(updated, deps.config.chain.id);
  },

  async refundEscrow({ params }, { deps, auth, now }) {
    assertEscrowEnabled(deps);
    const access = await loadEscrow(deps, auth, params.id);
    const { escrow } = access;
    if (escrow.status !== "locked" && escrow.status !== "disputed") {
      throw new AgentBankError("invalid_state", `A ${escrow.status} escrow cannot be refunded`);
    }
    if (escrow.pending_action)
      throw new AgentBankError("invalid_state", `A ${escrow.pending_action} is already in progress`);
    const escrowId = assertOnchain(escrow);
    const call = escrowRefundCall({ escrow: getAddress(escrow.contract_address), escrowId });
    let updated: EscrowRow;
    if (access.role === "payee") {
      updated = await startAction(deps, auth, access, "refund", call, now);
    } else if (now.getTime() >= escrow.expires_at.getTime()) {
      // After expiry anyone may refund (funds can only go back to the payer): a keeper relays it.
      const txHash = await relay(deps, call);
      updated = (await one<EscrowRow>(
        deps.db,
        "UPDATE escrow SET tx_hash = $2, updated_at = $3 WHERE id = $1 RETURNING *",
        [escrow.id, txHash, now],
      )) as EscrowRow;
    } else {
      throw new AgentBankError("invalid_state", "Before expiry only the payee can refund");
    }
    await audit(deps.db, now, {
      actor: actorOf(auth),
      action: "escrow.refund_requested",
      subject: escrow.id,
    });
    return serializeEscrow(updated, deps.config.chain.id);
  },

  async disputeEscrow({ params, body }, { deps, auth, now }) {
    assertEscrowEnabled(deps);
    const access = await loadEscrow(deps, auth, params.id);
    const { escrow } = access;
    if (escrow.status !== "locked")
      throw new AgentBankError("invalid_state", `A ${escrow.status} escrow cannot be disputed`);
    if (!escrow.arbiter)
      throw new AgentBankError("invalid_state", "Only escrows with an arbiter can be disputed");
    if (now.getTime() >= escrow.expires_at.getTime())
      throw new AgentBankError("invalid_state", "The escrow has expired");
    if (escrow.pending_action)
      throw new AgentBankError("invalid_state", `A ${escrow.pending_action} is already in progress`);
    const escrowId = assertOnchain(escrow);
    const updated = await startAction(
      deps,
      auth,
      access,
      "dispute",
      escrowDisputeCall({ escrow: getAddress(escrow.contract_address), escrowId }),
      now,
      { disputeReason: body.reason },
    );
    // `escrow.disputed` is emitted by the reconciler when the contract's Disputed event lands.
    await audit(deps.db, now, {
      actor: actorOf(auth),
      action: "escrow.dispute_requested",
      subject: escrow.id,
      payload: { reason: body.reason },
    });
    return serializeEscrow(updated, deps.config.chain.id);
  },
};
