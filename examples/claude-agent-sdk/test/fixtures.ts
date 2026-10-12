import type { Balances, Payment, PolicyDecision, X402FetchResult } from "@agentbank/sdk";
import { vi } from "vitest";
import type { MoneyBackend } from "../src/money-tools";

/** Test doubles for the Agent Bank client: no network, no keys. */

export const ACCOUNT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const PAYEE = "0x2222222222222222222222222222222222222222";
const NOW = "2026-10-11T12:00:00.000Z";

export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ0",
    object: "payment",
    account_id: ACCOUNT,
    kind: "transfer",
    status: "settled",
    amount: { amount: "1.00", asset: "USDC" },
    fee: { amount: "0.002", asset: "USDC" },
    counterparty: { type: "address", address: PAYEE, agent_id: null, x402_domain: null },
    memo: null,
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
    account_id: ACCOUNT,
    asset: "USDC",
    available: "120.50",
    reserved: "0.00",
    escrow: "0.00",
    fees: "0.00",
    savings: "0.00",
    spend_float: "5.00",
    vaults: [],
    total: "125.50",
    as_of: NOW,
  };
}

export function decision(outcome: PolicyDecision["outcome"]): PolicyDecision {
  return {
    outcome,
    rule_hits: [
      {
        rule: "limits.per_day",
        effect: outcome === "allow" ? "allow" : "deny",
        detail: "1.00 USDC is within the daily limit (rolling 24 h) of 200.00 USDC",
      },
    ],
    approvers_required: 0,
    policy_version: 3,
    evaluated_at: NOW,
  };
}

export function paidFetch(amount: string): X402FetchResult {
  return {
    response: new Response(JSON.stringify({ city: "Lisbon", temp: 21 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    paid: true,
    amount,
    payment: payment({ kind: "x402", amount: { amount, asset: "USDC" } }),
  };
}

/** A fake `AgentClient` whose methods resolve to canned resources. */
export function fakeBackend() {
  return {
    balance: vi.fn(async () => balances()),
    checkSpend: vi.fn(async () => decision("allow")),
    pay: vi.fn(async (input: { amount: string }) =>
      payment({ amount: { amount: input.amount, asset: "USDC" } }),
    ),
    fetchWithPayment: vi.fn(async () => paidFetch("0.01")),
    listTransactions: vi.fn(async () => ({ data: [payment()], next_cursor: null })),
  } satisfies Record<keyof MoneyBackend, unknown>;
}

/** The fake, typed as the backend the tools expect. */
export function asBackend(fake: ReturnType<typeof fakeBackend>): MoneyBackend {
  return fake as unknown as MoneyBackend;
}
