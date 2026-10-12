import type {
  AgentFetchResult,
  Balances,
  Escrow,
  Payment,
  PaymentRequest,
  PolicyDecision,
  ProofAnswer,
  ProofRequest,
  ProofReservation,
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

export function fetchResult(overrides: Partial<AgentFetchResult> = {}): AgentFetchResult {
  return {
    response: new Response(JSON.stringify({ temp: 21 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    paid: true,
    amount: "0.01",
    payment: payment({ kind: "x402", status: "requires_signature" }),
    settlement: { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:84532" },
    proofPresented: false,
    ...overrides,
  };
}

export const NULLIFIER: `0x${string}` = `0x${"0a".repeat(32)}`;

export function proofRequest(): ProofRequest {
  return {
    type: "agentbank.proof_request.v1",
    scope: "api.seller.example",
    request_id: "9f2c1b0e5a7d4c3b8e6f1a2b3c4d5e6f",
    nonce: `0x${"5e".repeat(31)}`,
    issued_at: 1_760_000_000,
    expires_at: 1_760_000_300,
    constraints: { principal_verification: { min: "2", max: "2" }, per_tx_limit: { min: "5.00" } },
    max_root_age_seconds: 7_200,
    min_anonymity_set: 16,
    chain_id: 84532,
    registry: null,
  };
}

export function proofAnswer(): ProofAnswer {
  return {
    request: proofRequest(),
    presentation: {
      type: "agentbank.proof.v1",
      request_hash: `0x${"0b".repeat(32)}`,
      root: `0x${"0c".repeat(32)}`,
      nullifier: NULLIFIER,
      proof: {
        pi_a: ["1", "2", "1"],
        pi_b: [
          ["1", "2"],
          ["3", "4"],
          ["1", "0"],
        ],
        pi_c: ["1", "2", "1"],
        protocol: "groth16",
        curve: "bn128",
      },
    },
    headerName: "AGENT-PROOF",
    header: "eyJyZXF1ZXN0Ijp7fX0=",
  };
}

export function reservation(overrides: Partial<ProofReservation> = {}): ProofReservation {
  return {
    id: "prv_01JABCDEFGHJKMNPQRSTVWXYZ0",
    object: "proof_reservation",
    account_id: ACCT,
    agent_id: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
    amount: { amount: "500.00", asset: "USDC" },
    scope_tag: "1311768467463790320",
    expires_at: NOW,
    status: "pending",
    hold_id: "hld_01JABCDEFGHJKMNPQRSTVWXYZ0",
    created_at: NOW,
    released_at: null,
    included_in_epoch: null,
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
    proofs: {
      canProve: true as boolean,
      answer: vi.fn<AgentBankBackend["proofs"]["answer"]>(async () => proofAnswer()),
      reserve: vi.fn<AgentBankBackend["proofs"]["reserve"]>(async () => reservation()),
    },
  } satisfies AgentBankBackend;
}
