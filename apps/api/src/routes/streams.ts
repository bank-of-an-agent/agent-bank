import { streamCancelCall } from "@agentbank/chain";
import {
  AgentBankError,
  canonicalSha256,
  newId,
  toPositiveMinor,
  type DecisionInternal,
} from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { getAddress } from "viem";
import type { AccountRow, PaymentRow, StreamRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { accountByAddress, accountById, loadAccount, partyClause } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { streamFee } from "../domain/billing";
import { asPrepared, contractAddress } from "../domain/chain";
import { denialReason } from "../domain/decisions";
import { cosignAndSubmit, prepareFollowUp, signingSession, submitFollowUp } from "../domain/followups";
import { closePayment, createPaymentRecord, paymentById, submitSessionSignature } from "../domain/payments";
import type { AppDeps } from "../deps";
import { requireAgent, type AuthContext } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeStream } from "../serializers";
import { assertMandateUsable, resolvePayee, screenCounterparty } from "./payments";

export function assertStreamsEnabled(deps: AppDeps): void {
  if (!deps.config.features.streams)
    throw new AgentBankError("feature_gated", "Streams are not enabled on this deployment");
}

interface StreamAccess {
  stream: StreamRow;
  role: "payer" | "payee";
  account: AccountRow;
}

async function loadStream(deps: AppDeps, auth: AuthContext, id: string): Promise<StreamAccess> {
  const stream = await one<StreamRow>(deps.db, "SELECT * FROM stream WHERE id = $1", [id]);
  if (!stream) throw new AgentBankError("not_found", "Stream not found");
  const payer = (await accountById(deps.db, stream.payer_account_id)) as AccountRow;
  const payee = await accountByAddress(deps.db, payer.chain_id, stream.payee_address);
  if (auth.kind === "agent") {
    if (auth.accountId === payer.id) return { stream, role: "payer", account: payer };
    if (payee && auth.accountId === payee.id) return { stream, role: "payee", account: payee };
  } else if (auth.kind === "principal") {
    if (payer.org_id === auth.orgId) return { stream, role: "payer", account: payer };
    if (payee && payee.org_id === auth.orgId) return { stream, role: "payee", account: payee };
  }
  throw new AgentBankError("not_found", "Stream not found");
}

export const streamHandlers: Pick<
  Handlers,
  "createStream" | "listStreams" | "getStream" | "submitStreamSignature" | "cancelStream"
> = {
  async createStream({ body }, { deps, auth, now, idempotencyKey }) {
    assertStreamsEnabled(deps);
    const agent = requireAgent(auth);
    const account = await loadAccount(deps.db, agent, body.account_id);
    const contract = contractAddress(deps, "streams");
    const key = idempotencyKey as string;
    const existing = await one<StreamRow>(
      deps.db,
      `SELECT s.* FROM stream s JOIN payment p ON p.id = s.payment_id WHERE p.account_id = $1 AND p.idempotency_key = $2`,
      [account.id, key],
    );
    if (existing) return new Envelope(serializeStream(existing, deps.config.chain.id), 201);

    const perInterval = toPositiveMinor(body.amount_per_interval);
    const deposit = toPositiveMinor(body.deposit);
    if (deposit < perInterval)
      throw new AgentBankError("invalid_request", "deposit must cover at least one interval");
    const start = body.start_at ? new Date(body.start_at) : now;
    if (start.getTime() < now.getTime() - 60_000)
      throw new AgentBankError("invalid_request", "start_at cannot be in the past");
    const stop = body.stop_at ? new Date(body.stop_at) : null;
    if (stop && stop.getTime() <= start.getTime())
      throw new AgentBankError("invalid_request", "stop_at must be after start_at");
    const payee = await resolvePayee(deps, account, body.payee);
    if (payee.refill)
      throw new AgentBankError("invalid_request", "A stream cannot pay the account's own spend key");
    if (body.mandate_id) await assertMandateUsable(deps.db, agent.agentId, body.mandate_id, now);
    const fee = streamFee(deposit);
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
          kind: "stream",
          amount: deposit.toString(),
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
    if (decision.outcome === "deny")
      throw new AgentBankError("policy_denied", denialReason(decision), { decision });
    const streamId = newId("stream", now.getTime());
    const payment = await createPaymentRecord(
      deps,
      {
        account,
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        kind: "stream",
        amount: deposit,
        fee,
        counterparty: {
          counterparty_type: "stream",
          counterparty_address: contract,
          counterparty_agent_id: payee.agentId,
          counterparty_x402_domain: null,
        },
        memo: null,
        mandateId: body.mandate_id ?? null,
        paymentRequestId: null,
        metadata: {},
        streamId,
        idempotencyKey: key,
        requestHash: canonicalSha256(body),
        decision,
        decisionSource: source,
      },
      now,
      async (tx, p) => {
        await tx.query(
          `INSERT INTO stream (id, payer_account_id, payee_address, payee_agent_id, kind, amount_per_interval, interval_seconds,
                               deposit, settled, settle_every_seconds, start_at, stop_at, status, contract_address,
                               pending_action, payment_id, org_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, 'requires_signature', $12, 'create', $13, $14, $15, $15)`,
          [
            streamId,
            account.id,
            payee.address,
            payee.agentId,
            body.kind,
            perInterval,
            body.interval_seconds,
            deposit,
            body.settle_every_seconds,
            start,
            stop,
            contract,
            p.id,
            account.org_id,
            now,
          ],
        );
      },
    );
    const stream = (await one<StreamRow>(deps.db, "SELECT * FROM stream WHERE payment_id = $1", [
      payment.id,
    ])) as StreamRow;
    return new Envelope(serializeStream(stream, deps.config.chain.id), 201);
  },

  async listStreams({ query }, { deps, auth }) {
    const params: SqlParam[] = [];
    let where = await partyClause(deps.db, auth, "s", query.account_id, params);
    if (where === null) return { data: [], next_cursor: null };
    if (query.status) {
      params.push(query.status);
      where += ` AND s.status = $${params.length}`;
    }
    const sql = `SELECT s.* FROM stream s WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params, "s")}`;
    const page = toPage(await all<StreamRow>(deps.db, sql, params), query.limit);
    return {
      data: page.items.map((row) => serializeStream(row, deps.config.chain.id)),
      next_cursor: page.nextCursor,
    };
  },

  async getStream({ params }, { deps, auth }) {
    const { stream } = await loadStream(deps, auth, params.id);
    return serializeStream(stream, deps.config.chain.id);
  },

  async submitStreamSignature({ params, body }, { deps, auth, now }) {
    assertStreamsEnabled(deps);
    const agent = requireAgent(auth);
    const access = await loadStream(deps, agent, params.id);
    const { stream } = access;
    if (stream.pending_action === "create") {
      if (access.role !== "payer") throw new AgentBankError("not_found", "Stream not found");
      const payment = (await paymentById(deps.db, stream.payment_id as string)) as PaymentRow;
      await submitSessionSignature(
        deps,
        payment,
        { sessionId: body.session_id, signature: body.signature },
        now,
      );
    } else if (stream.pending_action && stream.user_op && !stream.op_submitted_at) {
      if (stream.op_session_id !== body.session_id) {
        throw new AgentBankError(
          "invalid_request",
          "Sign with the session named in signing_request.session_id",
        );
      }
      if (stream.op_deadline && stream.op_deadline.getTime() <= now.getTime()) {
        await deps.db.query(
          "UPDATE stream SET pending_action = NULL, user_op = NULL, user_op_hash = NULL, op_session_id = NULL, op_deadline = NULL, updated_at = $2 WHERE id = $1",
          [stream.id, now],
        );
        throw new AgentBankError("invalid_state", "The signing deadline passed; start the action again");
      }
      const userOpHash = await submitFollowUp(deps, "stream", stream.id, now, () =>
        cosignAndSubmit(deps, {
          account: access.account,
          sessionId: body.session_id,
          prepared: asPrepared(stream.user_op),
          signature: body.signature,
          subjectId: `${stream.id}:${stream.pending_action}:${stream.user_op_hash}`,
          action: "stream.cancel",
          onchainId: stream.onchain_id as string,
          intent: {
            kind: "stream",
            amount: stream.deposit.toString(),
            asset: "USDC",
            counterparty: {
              address: stream.payee_address,
              contract: stream.contract_address,
              ...(stream.payee_agent_id ? { agent_id: stream.payee_agent_id } : {}),
            },
          },
          now,
        }),
      );
      await deps.db.query(
        "UPDATE stream SET user_op_hash = $2, op_submitted_at = $3, updated_at = $3 WHERE id = $1",
        [stream.id, userOpHash, now],
      );
    } else if (!stream.op_submitted_at) {
      throw new AgentBankError("invalid_state", "The stream has no operation waiting for a signature");
    }
    const updated = (await one<StreamRow>(deps.db, "SELECT * FROM stream WHERE id = $1", [
      stream.id,
    ])) as StreamRow;
    return serializeStream(updated, deps.config.chain.id);
  },

  async cancelStream({ params }, { deps, auth, now }) {
    assertStreamsEnabled(deps);
    const access = await loadStream(deps, auth, params.id);
    const { stream } = access;
    if (stream.status === "canceled") return serializeStream(stream, deps.config.chain.id);
    if (stream.status === "requires_signature" && access.role === "payer") {
      // Not created on-chain yet: cancel the creation (the hold is voided).
      const payment = stream.payment_id ? await paymentById(deps.db, stream.payment_id) : undefined;
      if (payment && (payment.status === "requires_signature" || payment.status === "requires_approval")) {
        await closePayment(deps, payment, "canceled", "stream canceled before creation", now, null);
        await deps.db.query(
          "UPDATE stream SET status = 'canceled', pending_action = NULL, user_op_hash = NULL, updated_at = $2 WHERE id = $1",
          [stream.id, now],
        );
        const updated = (await one<StreamRow>(deps.db, "SELECT * FROM stream WHERE id = $1", [
          stream.id,
        ])) as StreamRow;
        return serializeStream(updated, deps.config.chain.id);
      }
      throw new AgentBankError("invalid_state", "The stream is being created; cancel it once it is active");
    }
    if (stream.status !== "active" && stream.status !== "paused") {
      throw new AgentBankError("invalid_state", `A ${stream.status} stream cannot be canceled`);
    }
    // PaymentStreams.cancel: only the payer may cancel (the payee keeps what has accrued).
    if (access.role !== "payer") throw new AgentBankError("forbidden", "Only the payer can cancel a stream");
    if (stream.pending_action)
      throw new AgentBankError("invalid_state", `A ${stream.pending_action} is already in progress`);
    if (!stream.onchain_id)
      throw new AgentBankError("invalid_state", "The stream is not created on-chain yet");
    const session = await signingSession(deps, auth, access.account, now);
    const { prepared, deadline } = await prepareFollowUp(deps, {
      account: access.account,
      session,
      calls: [
        streamCancelCall({
          streams: getAddress(stream.contract_address),
          streamId: BigInt(stream.onchain_id),
        }),
      ],
      now,
    });
    const updated = (await one<StreamRow>(
      deps.db,
      `UPDATE stream SET pending_action = 'cancel', user_op = $2, user_op_hash = $3, op_session_id = $4, op_deadline = $5,
              op_submitted_at = NULL, updated_at = $6
        WHERE id = $1 RETURNING *`,
      [stream.id, prepared as unknown as object, prepared.userOpHash, session.id, deadline, now],
    )) as StreamRow;
    await audit(deps.db, now, {
      actor: actorOf(auth),
      action: "stream.cancel_requested",
      subject: stream.id,
    });
    return serializeStream(updated, deps.config.chain.id);
  },
};
