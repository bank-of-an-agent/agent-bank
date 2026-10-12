import type { z } from "zod";
import type * as R from "@agentbank/core/api";
import type { PolicyDecisionSchema, PolicyDocumentSchema, SessionScopeSchema } from "@agentbank/core";

/**
 * Wire types of the Agent Bank REST API (v1), derived from the route
 * registry's Zod schemas in `@agentbank/core` so they can never drift from
 * the server. Resource types are the parsed (output) shapes the API returns;
 * `…Input` types are what callers write (fields with server defaults are
 * optional).
 *
 * Conventions: snake_case fields, money as `{ amount: "25.00", asset: "USDC" }`
 * (decimal strings, never numbers), prefixed ids (`agt_…`, `acct_…`, `pay_…`).
 *
 * @packageDocumentation
 */

// ------------------------------------------------------------------ shared

/** An amount of an asset. `amount` is a decimal string in major units, e.g. `"25.00"`. */
export type Money = z.output<typeof R.Payment>["amount"];
/** One page of a cursor-paginated list. Pass `next_cursor` back as `cursor` to fetch the next page. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}
/** EIP-712 owner authorization attached to requests that need the principal's owner key. */
export type OwnerAuthorization = z.output<typeof R.UnfreezeRequest>["owner_authorization"];

// ------------------------------------------------------------------ orgs & members

/** A verified principal (human or company) that owns agents. */
export type Org = z.output<typeof R.Org>;
/** Body of `POST /v1/orgs` (sign-up). */
export type CreateOrgInput = z.input<typeof R.CreateOrgRequest>;
/** The new org and its first admin API key (secret shown once). */
export type CreateOrgResult = z.output<typeof R.CreateOrgResponse>;
/** An org API key (secret never returned after creation). */
export type ApiKey = z.output<typeof R.ApiKey>;
/** A newly created API key including its one-time `secret`. */
export type ApiKeyWithSecret = z.output<typeof R.ApiKeyWithSecret>;
/** Body of `POST /v1/api-keys`. */
export type CreateApiKeyInput = z.input<typeof R.CreateApiKeyRequest>;
/** KYC/KYB verification session. */
export type KybSession = z.output<typeof R.KybSession>;
/** Body of `POST /v1/orgs/me/owner` (owner-key rotation, signed by the current owner). */
export type RotateOwnerInput = z.input<typeof R.RotateOwnerRequest>;
/** Body of `POST /v1/accounts/{id}/owner-swap`. */
export type PrepareOwnerSwapInput = z.input<typeof R.PrepareOwnerSwapRequest>;
/** Body of the freeze routes (tightening, immediate). */
export type FreezeInput = z.input<typeof R.FreezeRequest>;
/** Body of the unfreeze routes (owner authorization, 1-hour delay). */
export type UnfreezeInput = z.input<typeof R.UnfreezeRequest>;
/** Body of `PUT /v1/orgs/me/treasury`. */
export type SetTreasuryInput = z.input<typeof R.SetTreasuryRequest>;
/** An org member (admin, approver or viewer). */
export type Member = z.output<typeof R.Member>;
/** Body of `POST /v1/members`. */
export type CreateMemberInput = z.input<typeof R.CreateMemberRequest>;

// ------------------------------------------------------------------ agents & accounts

/** A software identity acting for a principal. */
export type Agent = z.output<typeof R.Agent>;
/** Body of `POST /v1/agents`. */
export type CreateAgentInput = z.input<typeof R.CreateAgentRequest>;
/** An agent's (or the org treasury's) ERC-7579 smart account on one chain. */
export type Account = z.output<typeof R.Account>;
/** Body of `POST /v1/agents/{id}/accounts`. */
export type CreateAccountInput = z.input<typeof R.CreateAccountRequest>;
/** Body of `POST /v1/orgs/me/treasury-accounts`. */
export type CreateTreasuryAccountInput = z.input<typeof R.CreateTreasuryAccountRequest>;
/** Available, reserved, escrowed, saved and spend-float balances of an account. */
export type Balances = z.output<typeof R.Balances>;
/**
 * EIP-2612 USDC permit signed by the agent's spend key, granting the smart
 * account an allowance so the owner can always sweep the x402 float back
 * (ADR 0001). Integers are decimal strings.
 */
export type SpendKeyPermit = z.output<typeof R.SpendKeyPermit>;
/** Body of `PUT /v1/accounts/{id}/spend-key`. */
export type AttachSpendKeyInput = z.input<typeof R.AttachSpendKeyRequest>;

// ------------------------------------------------------------------ sessions & owner operations

/** A short-lived, scoped session key registered for an account. */
export type Session = z.output<typeof R.Session>;
/** On-chain enforced scope of a session key (caps, recipients, contracts, expiry). */
export type SessionScope = z.output<typeof SessionScopeSchema>;
/** Session scope as written by callers (`asset` defaults to USDC). */
export type SessionScopeInput = z.input<typeof SessionScopeSchema>;
/** Body of `POST /v1/sessions`. */
export type CreateSessionInput = z.input<typeof R.CreateSessionRequest>;
/** An on-chain operation only the owner key can authorize. */
export type OwnerOperation = z.output<typeof R.OwnerOperation>;
/** Body of `POST /v1/owner-operations/{id}/signature`. */
export type SubmitOwnerSignatureInput = z.input<typeof R.SubmitOwnerSignatureRequest>;

// ------------------------------------------------------------------ mandates & policies

/** An AP2 open payment mandate granted to an agent. */
export type Mandate = z.output<typeof R.Mandate>;
/** Body of `POST /v1/mandates`. */
export type CreateMandateInput = z.input<typeof R.CreateMandateRequest>;
/** An agent's spending policy (parsed, defaults applied). */
export type PolicyDocument = z.output<typeof PolicyDocumentSchema>;
/** A spending policy as written by callers. */
export type PolicyDocumentInput = z.input<typeof PolicyDocumentSchema>;
/** One version of an agent's policy. */
export type PolicyVersion = z.output<typeof R.PolicyVersion>;
/** An agent's current policy and any pending (loosening) change. */
export type AgentPolicy = z.output<typeof R.AgentPolicy>;
/** Body of `PUT /v1/agents/{id}/policy`. */
export type PutPolicyInput = z.input<typeof R.PutPolicyRequest>;
/** What a payment would do, for dry-run policy checks. */
export type PaymentIntentInput = z.input<typeof R.PaymentIntent>;
/** Body of `POST /v1/policy/check`. */
export type PolicyCheckInput = z.input<typeof R.PolicyCheckRequest>;
/** Deterministic decision of the policy engine, with the rules that fired. */
export type PolicyDecision = z.output<typeof PolicyDecisionSchema>;

// ------------------------------------------------------------------ payments

/** Lifecycle status of a payment. */
export type PaymentStatus = z.output<typeof R.PaymentStatus>;
/** Who a payment, escrow or stream pays. */
export type Counterparty = z.output<typeof R.Counterparty>;
/** What the session key must sign (`user_op_hash`) to submit an operation. */
export type SigningRequest = z.output<typeof R.SigningRequest>;
/** A payment (transfer, x402, escrow, stream, payout or refill). */
export type Payment = z.output<typeof R.Payment>;
/** Body of `POST /v1/payments`. */
export type CreatePaymentInput = z.input<typeof R.CreatePaymentRequest>;
/** Body of the `…/signature` routes (session-key signature over `user_op_hash`). */
export type SubmitSignatureInput = z.input<typeof R.SubmitSignatureRequest>;
/** A request for another agent or a human to pay. */
export type PaymentRequest = z.output<typeof R.PaymentRequest>;
/** Body of `POST /v1/payment-requests`. */
export type CreatePaymentRequestInput = z.input<typeof R.CreatePaymentRequestRequest>;

// ------------------------------------------------------------------ x402 (API side)

/** x402 v2 payment requirements as the API accepts them. */
export type X402PaymentRequirements = z.output<typeof R.X402PaymentRequirements>;
/** x402 v2 payment requirements as written by callers. */
export type X402PaymentRequirementsInput = z.input<typeof R.X402PaymentRequirements>;
/** The resource an x402 payment is for. */
export type X402ResourceInfo = z.output<typeof R.X402ResourceInfo>;
/** x402 v2 payment payload as the facilitator routes accept it. */
export type X402PaymentPayload = z.output<typeof R.X402PaymentPayload>;
/** EIP-3009 `TransferWithAuthorization` fields (integers as decimal strings). */
export type Eip3009Authorization = z.output<typeof R.Eip3009Authorization>;
/** Body of `POST /v1/x402/pay`. */
export type X402PayInput = z.input<typeof R.X402PayRequest>;
/** The x402 payment record plus the EIP-3009 authorization and EIP-712 domain to sign. */
export type X402PayResponse = z.output<typeof R.X402PayResponse>;
/** Body of the facilitator's `verify` and `settle` routes. */
export type X402VerifyInput = z.input<typeof R.X402VerifyRequest>;
/** Facilitator verification result. */
export type X402VerifyResponse = z.output<typeof R.X402VerifyResponse>;
/** Facilitator settlement result. */
export type X402SettleResponse = z.output<typeof R.X402SettleResponse>;
/** Schemes and networks the facilitator supports. */
export type X402SupportedResponse = z.output<typeof R.X402SupportedResponse>;
/** Seller configuration for charging per call (x402 receive). */
export type X402Payee = z.output<typeof R.X402Payee>;
/** Body of `POST /v1/x402/payees`. */
export type RegisterX402PayeeInput = z.input<typeof R.RegisterX402PayeeRequest>;

// ------------------------------------------------------------------ escrow & streams

/** Lifecycle status of an escrow. */
export type EscrowStatus = z.output<typeof R.EscrowStatus>;
/** Funds locked for a task in the escrow contract. */
export type Escrow = z.output<typeof R.Escrow>;
/** Body of `POST /v1/escrows`. */
export type CreateEscrowInput = z.input<typeof R.CreateEscrowRequest>;
/** Body of `POST /v1/escrows/{id}/dispute`. */
export type DisputeEscrowInput = z.input<typeof R.DisputeEscrowRequest>;
/** Lifecycle status of a stream. */
export type StreamStatus = z.output<typeof R.StreamStatus>;
/** A pre-funded per-second stream or recurring payment. */
export type Stream = z.output<typeof R.Stream>;
/** Body of `POST /v1/streams`. */
export type CreateStreamInput = z.input<typeof R.CreateStreamRequest>;

// ------------------------------------------------------------------ approvals & ledger

/** A payment waiting for human approval (expires after 15 minutes). */
export type Approval = z.output<typeof R.Approval>;
/** Body of `POST /v1/approvals/{id}/decide`. */
export type DecideApprovalInput = z.input<typeof R.DecideApprovalRequest>;
/** One signed line of a journal entry. */
export type LedgerLine = z.output<typeof R.LedgerLine>;
/** An immutable, balanced journal entry. */
export type LedgerEntry = z.output<typeof R.LedgerEntry>;
/** Monthly statement generated from the ledger. */
export type Statement = z.output<typeof R.Statement>;

// ------------------------------------------------------------------ savings, treasury, billing

/** A goal (ledger-only) or time-locked vault. */
export type Vault = z.output<typeof R.Vault>;
/** Body of `POST /v1/vaults`. */
export type CreateVaultInput = z.input<typeof R.CreateVaultRequest>;
/** Body of the vault deposit and withdraw routes. */
export type VaultTransferInput = z.input<typeof R.VaultTransferRequest>;
/** Rule refilling an agent from the org treasury. */
export type AutoTopUpRule = z.output<typeof R.AutoTopUpRule>;
/** Body of `PUT /v1/agents/{id}/auto-topup`. */
export type PutAutoTopUpInput = z.input<typeof R.PutAutoTopUpRequest>;
/** Entry of the neutral list of eligible tokenized Treasury funds. */
export type Fund = z.output<typeof R.Fund>;
/** Owner-directed treasury sweep configuration. */
export type SweepRule = z.output<typeof R.SweepRule>;
/** Body of `PUT /v1/accounts/{id}/sweep-rule`. */
export type PutSweepRuleInput = z.input<typeof R.PutSweepRuleRequest>;
/** A subscription plan. */
export type Plan = z.output<typeof R.Plan>;
/** The org's subscription. */
export type Subscription = z.output<typeof R.Subscription>;
/** Body of `PUT /v1/billing/subscription`. */
export type ChangePlanInput = z.input<typeof R.ChangePlanRequest>;
/** Fees charged in a period, by kind. */
export type FeeSummary = z.output<typeof R.FeeSummary>;
/** Liveness and dependency checks. */
export type Health = z.output<typeof R.Health>;
/**
 * Deployment facts (`GET /v1/meta`): chain, USDC, contract addresses,
 * feature flags, and `owner_authorization_chain_id`, the EIP-712 domain chain
 * id for owner authorizations.
 */
export type Meta = z.output<typeof R.Meta>;

// ------------------------------------------------------------------ webhooks & events

/** A registered webhook endpoint. */
export type WebhookEndpoint = z.output<typeof R.WebhookEndpoint>;
/** A newly created webhook endpoint including its one-time HMAC `secret`. */
export type WebhookEndpointWithSecret = z.output<typeof R.WebhookEndpointWithSecret>;
/** Body of `POST /v1/webhook-endpoints`. */
export type CreateWebhookEndpointInput = z.input<typeof R.CreateWebhookEndpointRequest>;
/** An event from the event log (also delivered by webhook). */
export type Event = z.output<typeof R.Event>;
/** RFC 9457 problem details as returned by the API (`application/problem+json`). */
export type Problem = z.output<typeof R.Problem>;
