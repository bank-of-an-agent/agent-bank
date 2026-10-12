import type {
  Balances,
  Escrow,
  Payment,
  PaymentRequest,
  PolicyDecision,
  X402FetchResult,
} from "@agentbank/sdk";
import { vi } from "vitest";
import type { AgentBankBackend } from "../src";

export const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const NOW = "2026-10-11T12:00:00.000Z";

export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ0",
    object: "payment",
    account_id: ACCT,
    kind: "transfer",
    status: "settled",
    amount: { amount: "2.50", asset: "USDC" },
    fee: { amount: "0.01", asset: "USDC" },
    counterparty: {
      type: "address",
      address: "0x2222222222222222222222222222222222222222",
      agent_id: null,
      x402_domain: null,
    },
    memo: "dataset",
    mandate_id: null,
    payment_request_id: null,
    decision: null,
    approval_id: null,
    escrow_id: null,
    stream_id: null,
    signing_request: null,
    owner_operation_id: null,
    user_op_hash: null,
    tx_hash: `0x${"ab".repeat(32)}`,
    failure_reason: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    settled_at: NOW,
    ...overrides,
  };
}

export function balances(): Balances {
  return {
    object: "balances",
    account_id: ACCT,
    asset: "USDC",
    available: "120.50",
    reserved: "2.00",
    escrow: "10.00",
    fees: "0.10",
    savings: "0.00",
    spend_float: "5.00",
    vaults: [],
    total: "137.60",
    as_of: NOW,
  };
}

export function decision(outcome: PolicyDecision["outcome"]): PolicyDecision {
  return {
    outcome,
    rule_hits: [
      { rule: "limits.per_day", effect: outcome === "allow" ? "info" : "deny", detail: "daily cap 200.00" },
    ],
    approvers_required: 0,
    policy_version: 4,
    evaluated_at: NOW,
  };
}

export function escrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: "esc_01JABCDEFGHJKMNPQRSTVWXYZ0",
    object: "escrow",
    payer_account_id: ACCT,
    payee: {
      type: "address",
      address: "0x2222222222222222222222222222222222222222",
      agent_id: null,
      x402_domain: null,
    },
    amount: { amount: "40.00", asset: "USDC" },
    fee: { amount: "1.00", asset: "USDC" },
    status: "locked",
    release: "payer",
    arbiter: null,
    validator: null,
    terms_hash: null,
    contract_address: "0x5555555555555555555555555555555555555555",
    onchain_id: "1",
    expires_at: NOW,
    pending_action: null,
    signing_request: null,
    memo: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function paymentRequest(): PaymentRequest {
  return {
    id: "preq_01JABCDEFGHJKMNPQRSTVWXYZ0",
    object: "payment_request",
    account_id: ACCT,
    pay_to: "0x1111111111111111111111111111111111111111",
    amount: { amount: "3.00", asset: "USDC" },
    memo: "invoice 7",
    reference: "INV-7",
    status: "open",
    pay_link: "http://localhost:8080/pay/preq_01JABCDEFGHJKMNPQRSTVWXYZ0",
    paid_by_payment_id: null,
    expires_at: NOW,
    created_at: NOW,
  };
}

export function fetchResult(overrides: Partial<X402FetchResult> = {}): X402FetchResult {
  return {
    response: new Response(JSON.stringify({ temp: 21 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    paid: true,
    amount: "0.01",
    payment: payment({ kind: "x402", status: "requires_signature" }),
    settlement: { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:84532" },
    ...overrides,
  };
}

type Method<K extends keyof AgentBankBackend> = AgentBankBackend[K] extends (...args: infer A) => infer R
  ? (...args: A) => R
  : never;

/** A typed vi.fn for one backend method, with a default implementation. */
function mockMethod<K extends keyof AgentBankBackend>(_name: K, impl: Method<K>) {
  return vi.fn<Method<K>>(impl);
}

/** A mocked SDK backend: every method is a typed vi.fn with a sensible default. */
export function mockBackend() {
  return {
    accountId: ACCT,
    balance: mockMethod("balance", async () => balances()),
    checkSpend: mockMethod("checkSpend", async () => decision("allow")),
    pay: mockMethod("pay", async () => payment()),
    fetchWithPayment: mockMethod("fetchWithPayment", async () => fetchResult()),
    requestPayment: mockMethod("requestPayment", async () => paymentRequest()),
    createEscrow: mockMethod("createEscrow", async () => escrow()),
    releaseEscrow: mockMethod("releaseEscrow", async () => escrow({ status: "released" })),
    listTransactions: mockMethod("listTransactions", async () => ({
      data: [payment(), payment({ id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ1", status: "submitted" })],
      next_cursor: "c2",
    })),
  } satisfies AgentBankBackend;
}
