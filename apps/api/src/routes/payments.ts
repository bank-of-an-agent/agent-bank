import {
  AgentBankError,
  canonicalSha256,
  newId,
  toPositiveMinor,
  type DecisionInternal,
} from "@agentbank/core";
import type { SqlClient, SqlParam } from "@agentbank/db";
import { getAddress, type Address } from "viem";
import type { AccountRow, MandateRow, PaymentRequestRow, PaymentRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { accountByAddress, accountById, agentAccountOnChain, loadAccount } from "../domain/access";
import { outboundFee } from "../domain/billing";
import { apiDenial } from "../domain/decisions";
import {
  advancePayment,
  closePayment,
  createPaymentRecord,
  paymentById,
  paymentView,
  submitSessionSignature,
} from "../domain/payments";
import type { AppDeps } from "../deps";
import { requireAgent, requirePrincipal, type AuthContext } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { isBlocked, screenOrFail } from "../providers/screening";
import { serializePaymentRequest } from "../serializers";
import { addSeconds } from "../util/time";

export interface ResolvedPayee {
  address: Address;
  agentId: string | null;
  account: AccountRow | undefined;
  refill: boolean;
}

/** Resolve `to` (address, agent id or account id) to an address on the payer's chain. */
export async function resolvePayee(
  deps: AppDeps,
  payer: AccountRow,
  to: { address?: string | undefined; agent_id?: string | undefined; account_id?: string | undefined },
): Promise<ResolvedPayee> {
  let account: AccountRow | undefined;
  let address: Address;
  if (to.account_id) {
    account = await accountById(deps.db, to.account_id);
    if (!account || account.chain_id !== payer.chain_id)
      throw new AgentBankError("not_found", "Payee account not found");
    address = getAddress(account.address);
  } else if (to.agent_id) {
    account = await agentAccountOnChain(deps.db, to.agent_id, payer.chain_id);
    if (!account) throw new AgentBankError("invalid_request", "The payee agent has no account on this chain");
    address = getAddress(account.address);
  } else if (to.address) {
    address = getAddress(to.address);
    account = await accountByAddress(deps.db, payer.chain_id, address);
  } else {
    throw new AgentBankError("invalid_request", "Set exactly one of to.address, to.agent_id, to.account_id");
  }
  if (address.toLowerCase() === payer.address.toLowerCase()) {
    throw new AgentBankError("invalid_request", "An account cannot pay itself");
  }
  const refill =
    payer.spend_key_address !== null && address.toLowerCase() === payer.spend_key_address.toLowerCase();
  return { address, agentId: account?.agent_id ?? null, account, refill };
}

export async function assertMandateUsable(
  db: SqlClient,
  agentId: string,
  mandateId: string,
  now: Date,
): Promise<MandateRow> {
  const mandate = await one<MandateRow>(db, "SELECT * FROM mandate WHERE id = $1 AND agent_id = $2", [
    mandateId,
    agentId,
  ]);
  if (!mandate) throw new AgentBankError("mandate_invalid", "Mandate not found for this agent");
  if (mandate.revoked_at) throw new AgentBankError("mandate_invalid", "The mandate was revoked");
  if (mandate.expires_at.getTime() <= now.getTime())
    throw new AgentBankError("mandate_expired", "The mandate expired");
  return mandate;
}

/** Screen a counterparty; a sanctioned or severe-risk address becomes an API-level denial. */
export async function screenCounterparty(
  deps: AppDeps,
  address: string,
  now: Date,
): Promise<DecisionInternal | null> {
  const result = await screenOrFail(deps.screening, address);
  if (!isBlocked(result)) return null;
  return apiDenial(
    "screening.sanctioned",
    `Counterparty ${address} failed wallet screening (${result.risk} risk)`,
    now,
  );
}

async function loadPayment(db: SqlClient, auth: AuthContext, id: string): Promise<PaymentRow> {
  const payment = await paymentById(db, id);
  const visible =
    payment &&
    ((auth.kind === "principal" && payment.org_id === auth.orgId) ||
      (auth.kind === "agent" && payment.account_id === auth.accountId));
  if (!payment || !visible) throw new AgentBankError("not_found", "Payment not found");
  return payment;
}

export const paymentHandlers: Pick<
  Handlers,
  | "createPayment"
  | "listPayments"
  | "getPayment"
  | "submitPaymentSignature"
  | "cancelPayment"
  | "createPaymentRequest"
  | "getPaymentRequest"
> = {
  async createPayment({ body }, { deps, auth, now, idempotencyKey }) {
    const agent = requireAgent(auth);
    const account = await loadAccount(deps.db, agent, body.account_id);
    const key = idempotencyKey as string;
    const existing = await one<PaymentRow>(
      deps.db,
      "SELECT * FROM payment WHERE account_id = $1 AND idempotency_key = $2",
      [account.id, key],
    );
    if (existing)
      return new Envelope(await paymentView(deps, await advancePayment(deps, existing, now)), 201);

    const amount = toPositiveMinor(body.amount);
    const payee = await resolvePayee(deps, account, body.to);
    if (body.payment_request_id) {
      const request = await one<PaymentRequestRow>(deps.db, "SELECT * FROM payment_request WHERE id = $1", [
        body.payment_request_id,
      ]);
      if (!request) throw new AgentBankError("not_found", "Payment request not found");
      if (request.status !== "open" || request.expires_at.getTime() <= now.getTime()) {
        throw new AgentBankError(
          "invalid_state",
          `The payment request is ${request.status === "open" ? "expired" : request.status}`,
        );
      }
      if (request.amount !== amount)
        throw new AgentBankError("invalid_request", "amount must equal the payment request amount");
      if (request.pay_to.toLowerCase() !== payee.address.toLowerCase()) {
        throw new AgentBankError("invalid_request", "to must be the payment request's pay_to address");
      }
    }
    if (body.mandate_id) await assertMandateUsable(deps.db, agent.agentId, body.mandate_id, now);
    const kind = payee.refill ? "refill" : "transfer";
    const fee = payee.refill ? 0n : outboundFee(amount);

    let decision = await screenCounterparty(deps, payee.address, now);
    let source: "api" | "cosigner" = "api";
    if (!decision) {
      decision = await deps.cosigner.evaluate({
        org_id: account.org_id,
        agent_id: agent.agentId,
        account_id: account.id,
        account_address: getAddress(account.address),
        chain_id: deps.config.chain.id,
        intent: {
          kind,
          amount: amount.toString(),
          asset: "USDC",
          counterparty: { address: payee.address, ...(payee.agentId ? { agent_id: payee.agentId } : {}) },
        },
        ...(body.mandate_id ? { mandate_id: body.mandate_id } : {}),
        session_id: agent.sessionId,
      });
      source = "cosigner";
    }
    const payment = await createPaymentRecord(
      deps,
      {
        account,
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        kind,
        amount,
        fee,
        counterparty: {
          counterparty_type: payee.agentId ? "agent" : "address",
          counterparty_address: payee.address,
          counterparty_agent_id: payee.agentId,
          counterparty_x402_domain: null,
        },
        memo: body.memo ?? null,
        mandateId: body.mandate_id ?? null,
        paymentRequestId: body.payment_request_id ?? null,
        metadata: body.metadata ?? {},
        idempotencyKey: key,
        requestHash: canonicalSha256(body),
        decision,
        decisionSource: source,
      },
      now,
    );
    return new Envelope(await paymentView(deps, payment), 201);
  },

  async listPayments({ query }, { deps, auth }) {
    const params: SqlParam[] = [];
    let where: string;
    if (auth.kind === "agent") {
      if (query.account_id && query.account_id !== auth.accountId) return { data: [], next_cursor: null };
      params.push(auth.accountId);
      where = "account_id = $1";
    } else {
      const principal = requirePrincipal(auth);
      params.push(principal.orgId);
      where = "org_id = $1";
      if (query.account_id) {
        params.push(query.account_id);
        where += ` AND account_id = $${params.length}`;
      }
    }
    if (query.agent_id) {
      if (auth.kind === "agent" && query.agent_id !== auth.agentId) return { data: [], next_cursor: null };
      params.push(query.agent_id);
      where += ` AND agent_id = $${params.length}`;
    }
    if (query.kind) {
      // Locked-vault deposits (internal kind `vault`) are shown as transfers.
      params.push(query.kind === "transfer" ? ["transfer", "vault"] : [query.kind]);
      where += ` AND kind = ANY($${params.length}::text[])`;
    }
    if (query.status) {
      params.push(query.status);
      where += ` AND status = $${params.length}`;
    }
    const sql = `SELECT * FROM payment WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<PaymentRow>(deps.db, sql, params), query.limit);
    const data = [];
    for (const p of page.items) data.push(await paymentView(deps, p));
    return { data, next_cursor: page.nextCursor };
  },

  async getPayment({ params }, { deps, auth }) {
    return paymentView(deps, await loadPayment(deps.db, auth, params.id));
  },

  async submitPaymentSignature({ params, body }, { deps, auth, now }) {
    const agent = requireAgent(auth);
    const payment = await loadPayment(deps.db, agent, params.id);
    const updated = await submitSessionSignature(
      deps,
      payment,
      { sessionId: body.session_id, signature: body.signature },
      now,
    );
    return paymentView(deps, updated);
  },

  async cancelPayment({ params }, { deps, auth, now }) {
    const payment = await loadPayment(deps.db, auth, params.id);
    if (payment.status === "canceled") return paymentView(deps, payment);
    if (payment.status !== "requires_approval" && payment.status !== "requires_signature") {
      throw new AgentBankError("invalid_state", `A ${payment.status} payment cannot be canceled`);
    }
    if (payment.kind === "x402") {
      throw new AgentBankError(
        "invalid_state",
        "An x402 authorization cannot be recalled once issued; it expires on its own",
      );
    }
    const canceled = await closePayment(deps, payment, "canceled", "canceled by request", now, null);
    return paymentView(deps, canceled);
  },

  async createPaymentRequest({ body }, { deps, auth, now }) {
    const account = await loadAccount(deps.db, auth, body.account_id);
    const amount = toPositiveMinor(body.amount);
    const row = (await one<PaymentRequestRow>(
      deps.db,
      `INSERT INTO payment_request (id, account_id, pay_to, amount, asset, memo, reference, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'USDC', $5, $6, 'open', $7, $8) RETURNING *`,
      [
        newId("paymentRequest", now.getTime()),
        account.id,
        getAddress(account.address),
        amount,
        body.memo ?? null,
        body.reference ?? null,
        addSeconds(now, body.expires_in_seconds),
        now,
      ],
    )) as PaymentRequestRow;
    return new Envelope(serializePaymentRequest(row, deps.config.payLinkBaseUrl, now), 201);
  },

  /**
   * Payment requests are meant to be shared (pay links): any authenticated caller who knows the
   * id may read one, so a payer in another org can check it before paying.
   */
  async getPaymentRequest({ params }, { deps, now }) {
    const row = await one<PaymentRequestRow>(deps.db, "SELECT * FROM payment_request WHERE id = $1", [
      params.id,
    ]);
    if (!row) throw new AgentBankError("not_found", "Payment request not found");
    return serializePaymentRequest(row, deps.config.payLinkBaseUrl, now);
  },
};
