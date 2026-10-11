import { z } from "zod";
import { PolicyDecisionSchema } from "../policy-schema";
import { DomainSchema, idSchema, page, PaginationQuery } from "../schemas";
import * as R from "./resources";

/**
 * The route registry is the single source of truth for the public API:
 * the Fastify app registers exactly these routes with these schemas, the
 * OpenAPI 3.1 document is generated from them, and the SDKs are typed by them.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Who may call a route.
 * - `public`: no authentication.
 * - `principal`: org API key (`Authorization: Bearer abk_…`) or console session.
 * - `agent`: HTTP Message Signature (RFC 9421) by a live session key.
 * - `approver`: a member with the approver or admin role.
 * - `seller`: an x402 seller calling the facilitator.
 * - `staff`: Agent Bank operators (internal dashboards).
 */
export type AuthKind = "public" | "principal" | "agent" | "approver" | "seller" | "staff";

export interface RouteDef {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: readonly string[];
  auth: readonly AuthKind[];
  /** Write routes that require an `Idempotency-Key` header. */
  idempotent?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  status?: 200 | 201 | 202;
  /** Additional response media types (e.g. text/csv for statements). */
  produces?: readonly string[];
  /** Served by a service other than the API (the load balancer routes it). */
  service?: "api" | "facilitator";
}

function route<const T extends RouteDef>(def: T): T {
  return def;
}

const Id = R.IdParam;

const ListQuery = PaginationQuery;

export const routes = {
  // ------------------------------------------------------------ orgs
  createOrg: route({
    operationId: "createOrg",
    method: "POST",
    path: "/v1/orgs",
    summary: "Create an organization (principal)",
    description:
      "Creates an org and its first admin API key. KYC/KYB starts in `pending`; sandbox orgs are auto-approved by the sandbox provider.",
    tags: ["Orgs"],
    auth: ["public"],
    idempotent: true,
    body: R.CreateOrgRequest,
    response: R.CreateOrgResponse,
    status: 201,
  }),
  getCurrentOrg: route({
    operationId: "getCurrentOrg",
    method: "GET",
    path: "/v1/orgs/me",
    summary: "Get the authenticated org",
    tags: ["Orgs"],
    auth: ["principal"],
    response: R.Org,
  }),
  startKyb: route({
    operationId: "startKyb",
    method: "POST",
    path: "/v1/orgs/me/kyb",
    summary: "Start or resume KYC/KYB verification",
    tags: ["Orgs"],
    auth: ["principal"],
    idempotent: true,
    response: R.KybSession,
  }),
  freezeOrg: route({
    operationId: "freezeOrg",
    method: "POST",
    path: "/v1/orgs/me/freeze",
    summary: "Freeze every agent in the org immediately",
    description: "Tightening: takes effect at once. The co-signer refuses every operation for the org.",
    tags: ["Orgs"],
    auth: ["principal"],
    idempotent: true,
    body: R.FreezeRequest,
    response: R.Org,
  }),
  unfreezeOrg: route({
    operationId: "unfreezeOrg",
    method: "POST",
    path: "/v1/orgs/me/unfreeze",
    summary: "Unfreeze the org (owner signature, 1-hour delay)",
    tags: ["Orgs"],
    auth: ["principal"],
    idempotent: true,
    body: R.UnfreezeRequest,
    response: R.Org,
  }),
  createTreasuryAccount: route({
    operationId: "createTreasuryAccount",
    method: "POST",
    path: "/v1/orgs/me/treasury-accounts",
    summary: "Create the org treasury smart account",
    tags: ["Orgs", "Treasury"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateTreasuryAccountRequest,
    response: R.Account,
    status: 201,
  }),
  setTreasury: route({
    operationId: "setTreasury",
    method: "PUT",
    path: "/v1/orgs/me/treasury",
    summary: "Set the org treasury account (owner signature)",
    tags: ["Orgs", "Treasury"],
    auth: ["principal"],
    idempotent: true,
    body: R.SetTreasuryRequest,
    response: R.Org,
  }),
  listApiKeys: route({
    operationId: "listApiKeys",
    method: "GET",
    path: "/v1/api-keys",
    summary: "List API keys",
    tags: ["Orgs"],
    auth: ["principal"],
    query: ListQuery,
    response: page(R.ApiKey),
  }),
  createApiKey: route({
    operationId: "createApiKey",
    method: "POST",
    path: "/v1/api-keys",
    summary: "Create an API key (secret shown once)",
    tags: ["Orgs"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateApiKeyRequest,
    response: R.ApiKeyWithSecret,
    status: 201,
  }),
  revokeApiKey: route({
    operationId: "revokeApiKey",
    method: "DELETE",
    path: "/v1/api-keys/{id}",
    summary: "Revoke an API key",
    tags: ["Orgs"],
    auth: ["principal"],
    params: Id("apiKey"),
    response: R.ApiKey,
  }),
  listMembers: route({
    operationId: "listMembers",
    method: "GET",
    path: "/v1/members",
    summary: "List org members",
    tags: ["Orgs"],
    auth: ["principal"],
    query: ListQuery,
    response: page(R.Member),
  }),
  createMember: route({
    operationId: "createMember",
    method: "POST",
    path: "/v1/members",
    summary: "Invite a member (admin, approver or viewer)",
    tags: ["Orgs"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateMemberRequest,
    response: R.Member,
    status: 201,
  }),

  // ------------------------------------------------------------ agents
  createAgent: route({
    operationId: "createAgent",
    method: "POST",
    path: "/v1/agents",
    summary: "Create an agent",
    tags: ["Agents"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateAgentRequest,
    response: R.Agent,
    status: 201,
  }),
  listAgents: route({
    operationId: "listAgents",
    method: "GET",
    path: "/v1/agents",
    summary: "List agents",
    tags: ["Agents"],
    auth: ["principal"],
    query: ListQuery.extend({ status: z.enum(["active", "frozen"]).optional() }),
    response: page(R.Agent),
  }),
  getAgent: route({
    operationId: "getAgent",
    method: "GET",
    path: "/v1/agents/{id}",
    summary: "Get an agent",
    tags: ["Agents"],
    auth: ["principal", "agent"],
    params: Id("agent"),
    response: R.Agent,
  }),
  freezeAgent: route({
    operationId: "freezeAgent",
    method: "POST",
    path: "/v1/agents/{id}/freeze",
    summary: "Freeze an agent immediately",
    description: "Tightening: immediate. The co-signer refuses every operation for this agent.",
    tags: ["Agents"],
    auth: ["principal"],
    idempotent: true,
    params: Id("agent"),
    body: R.FreezeRequest,
    response: R.Agent,
  }),
  unfreezeAgent: route({
    operationId: "unfreezeAgent",
    method: "POST",
    path: "/v1/agents/{id}/unfreeze",
    summary: "Unfreeze an agent (owner signature, 1-hour delay)",
    tags: ["Agents"],
    auth: ["principal"],
    idempotent: true,
    params: Id("agent"),
    body: R.UnfreezeRequest,
    response: R.Agent,
  }),

  // ------------------------------------------------------------ accounts
  createAccount: route({
    operationId: "createAccount",
    method: "POST",
    path: "/v1/agents/{id}/accounts",
    summary: "Create the agent's smart account on a chain",
    description:
      "Computes the counterfactual ERC-7579 Safe address (CREATE2). The account can receive funds before it is deployed; it deploys with the first operation.",
    tags: ["Accounts"],
    auth: ["principal"],
    idempotent: true,
    params: Id("agent"),
    body: R.CreateAccountRequest,
    response: R.Account,
    status: 201,
  }),
  listAccounts: route({
    operationId: "listAccounts",
    method: "GET",
    path: "/v1/accounts",
    summary: "List accounts",
    tags: ["Accounts"],
    auth: ["principal", "agent"],
    query: ListQuery.extend({ agent_id: idSchema("agent").optional() }),
    response: page(R.Account),
  }),
  getAccount: route({
    operationId: "getAccount",
    method: "GET",
    path: "/v1/accounts/{id}",
    summary: "Get an account",
    tags: ["Accounts"],
    auth: ["principal", "agent"],
    params: Id("account"),
    response: R.Account,
  }),
  getBalances: route({
    operationId: "getBalances",
    method: "GET",
    path: "/v1/accounts/{id}/balances",
    summary: "Get available, reserved, escrowed and saved balances",
    tags: ["Accounts"],
    auth: ["principal", "agent"],
    params: Id("account"),
    response: R.Balances,
  }),

  // ------------------------------------------------------------ sessions
  createSession: route({
    operationId: "createSession",
    method: "POST",
    path: "/v1/sessions",
    summary: "Register a session key and its scope (owner signs the install)",
    tags: ["Sessions"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateSessionRequest,
    response: R.Session,
    status: 201,
  }),
  getSession: route({
    operationId: "getSession",
    method: "GET",
    path: "/v1/sessions/{id}",
    summary: "Get a session",
    tags: ["Sessions"],
    auth: ["principal", "agent"],
    params: Id("session"),
    response: R.Session,
  }),
  revokeSession: route({
    operationId: "revokeSession",
    method: "DELETE",
    path: "/v1/sessions/{id}",
    summary: "Revoke a session key",
    description:
      "Off-chain revocation is immediate (the co-signer refuses). The owner should also revoke on-chain as the hard backstop.",
    tags: ["Sessions"],
    auth: ["principal"],
    params: Id("session"),
    response: R.Session,
  }),

  installSession: route({
    operationId: "installSession",
    method: "POST",
    path: "/v1/sessions/{id}/install",
    summary: "Prepare the owner operation that installs the session on-chain",
    description:
      "Returns the session with `install_operation_id`; sign that owner operation's `user_op_hash` with the owner key and submit it to `POST /v1/owner-operations/{id}/signature`.",
    tags: ["Sessions"],
    auth: ["principal"],
    idempotent: true,
    params: Id("session"),
    response: R.Session,
  }),
  getOwnerOperation: route({
    operationId: "getOwnerOperation",
    method: "GET",
    path: "/v1/owner-operations/{id}",
    summary: "Get an owner operation",
    tags: ["Owner operations"],
    auth: ["principal"],
    params: Id("ownerOperation"),
    response: R.OwnerOperation,
  }),
  submitOwnerSignature: route({
    operationId: "submitOwnerSignature",
    method: "POST",
    path: "/v1/owner-operations/{id}/signature",
    summary: "Submit the owner-key signature for an owner operation",
    description: "Owner-signed operations need no co-signer: the owner key alone can always act on its account.",
    tags: ["Owner operations"],
    auth: ["principal"],
    idempotent: true,
    params: Id("ownerOperation"),
    body: R.SubmitOwnerSignatureRequest,
    response: R.OwnerOperation,
  }),

  // ------------------------------------------------------------ mandates & policy
  createMandate: route({
    operationId: "createMandate",
    method: "POST",
    path: "/v1/mandates",
    summary: "Grant an agent authority with a signed AP2 mandate",
    tags: ["Mandates"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateMandateRequest,
    response: R.Mandate,
    status: 201,
  }),
  getMandate: route({
    operationId: "getMandate",
    method: "GET",
    path: "/v1/mandates/{id}",
    summary: "Get a mandate",
    tags: ["Mandates"],
    auth: ["principal", "agent"],
    params: Id("mandate"),
    response: R.Mandate,
  }),
  revokeMandate: route({
    operationId: "revokeMandate",
    method: "DELETE",
    path: "/v1/mandates/{id}",
    summary: "Revoke a mandate",
    tags: ["Mandates"],
    auth: ["principal"],
    params: Id("mandate"),
    response: R.Mandate,
  }),
  getPolicy: route({
    operationId: "getPolicy",
    method: "GET",
    path: "/v1/agents/{id}/policy",
    summary: "Get the agent's current and pending policy",
    tags: ["Policies"],
    auth: ["principal", "agent"],
    params: Id("agent"),
    response: R.AgentPolicy,
  }),
  putPolicy: route({
    operationId: "putPolicy",
    method: "PUT",
    path: "/v1/agents/{id}/policy",
    summary: "Replace the agent's policy",
    description:
      "Tightening applies immediately. Loosening requires an owner authorization and takes effect after a 1-hour delay.",
    tags: ["Policies"],
    auth: ["principal"],
    idempotent: true,
    params: Id("agent"),
    body: R.PutPolicyRequest,
    response: R.AgentPolicy,
  }),
  checkPolicy: route({
    operationId: "checkPolicy",
    method: "POST",
    path: "/v1/policy/check",
    summary: "Dry-run a payment against policy",
    tags: ["Policies"],
    auth: ["principal", "agent"],
    body: R.PolicyCheckRequest,
    response: PolicyDecisionSchema,
  }),

  // ------------------------------------------------------------ payments
  createPayment: route({
    operationId: "createPayment",
    method: "POST",
    path: "/v1/payments",
    summary: "Pay another account or address",
    description:
      "Places a hold, evaluates policy and returns either `requires_signature` (sign `signing_request.user_op_hash` with the session key), `requires_approval`, or `denied`.",
    tags: ["Payments"],
    auth: ["agent"],
    idempotent: true,
    body: R.CreatePaymentRequest,
    response: R.Payment,
    status: 201,
  }),
  listPayments: route({
    operationId: "listPayments",
    method: "GET",
    path: "/v1/payments",
    summary: "List payments",
    tags: ["Payments"],
    auth: ["principal", "agent"],
    query: ListQuery.extend({
      account_id: idSchema("account").optional(),
      status: R.PaymentStatus.optional(),
    }),
    response: page(R.Payment),
  }),
  getPayment: route({
    operationId: "getPayment",
    method: "GET",
    path: "/v1/payments/{id}",
    summary: "Get a payment",
    tags: ["Payments"],
    auth: ["principal", "agent"],
    params: Id("payment"),
    response: R.Payment,
  }),
  submitPaymentSignature: route({
    operationId: "submitPaymentSignature",
    method: "POST",
    path: "/v1/payments/{id}/signature",
    summary: "Submit the session-key signature; the co-signer re-checks policy and co-signs",
    tags: ["Payments"],
    auth: ["agent"],
    idempotent: true,
    params: Id("payment"),
    body: R.SubmitSignatureRequest,
    response: R.Payment,
  }),
  cancelPayment: route({
    operationId: "cancelPayment",
    method: "POST",
    path: "/v1/payments/{id}/cancel",
    summary: "Cancel a payment that has not been submitted",
    tags: ["Payments"],
    auth: ["principal", "agent"],
    idempotent: true,
    params: Id("payment"),
    response: R.Payment,
  }),
  createPaymentRequest: route({
    operationId: "createPaymentRequest",
    method: "POST",
    path: "/v1/payment-requests",
    summary: "Ask another agent or a human to pay",
    tags: ["Payments"],
    auth: ["agent", "principal"],
    idempotent: true,
    body: R.CreatePaymentRequestRequest,
    response: R.PaymentRequest,
    status: 201,
  }),
  getPaymentRequest: route({
    operationId: "getPaymentRequest",
    method: "GET",
    path: "/v1/payment-requests/{id}",
    summary: "Get a payment request",
    tags: ["Payments"],
    auth: ["agent", "principal"],
    params: Id("paymentRequest"),
    response: R.PaymentRequest,
  }),

  // ------------------------------------------------------------ x402
  x402Pay: route({
    operationId: "x402Pay",
    method: "POST",
    path: "/v1/x402/pay",
    summary: "Answer an x402 402 challenge within policy",
    description:
      "Checks the challenge against policy and returns an EIP-3009 authorization for the agent's spend key to sign (see ADR 0001).",
    tags: ["x402"],
    auth: ["agent"],
    idempotent: true,
    body: R.X402PayRequest,
    response: R.X402PayResponse,
  }),
  x402Verify: route({
    operationId: "x402Verify",
    method: "POST",
    path: "/v1/x402/verify",
    summary: "Facilitator: verify an x402 payment",
    tags: ["x402"],
    auth: ["seller", "public"],
    body: R.X402VerifyRequest,
    response: R.X402VerifyResponse,
    service: "facilitator",
  }),
  x402Settle: route({
    operationId: "x402Settle",
    method: "POST",
    path: "/v1/x402/settle",
    summary: "Facilitator: settle an x402 payment on-chain",
    tags: ["x402"],
    auth: ["seller", "public"],
    body: R.X402VerifyRequest,
    response: R.X402SettleResponse,
    service: "facilitator",
  }),
  x402Supported: route({
    operationId: "x402Supported",
    method: "GET",
    path: "/v1/x402/supported",
    summary: "Facilitator: supported schemes and networks",
    tags: ["x402"],
    auth: ["public"],
    response: R.X402SupportedResponse,
    service: "facilitator",
  }),
  registerX402Payee: route({
    operationId: "registerX402Payee",
    method: "POST",
    path: "/v1/x402/payees",
    summary: "Register an account to charge per call (x402 receive)",
    tags: ["x402"],
    auth: ["principal"],
    idempotent: true,
    body: R.RegisterX402PayeeRequest,
    response: R.X402Payee,
    status: 201,
  }),

  // ------------------------------------------------------------ escrow
  createEscrow: route({
    operationId: "createEscrow",
    method: "POST",
    path: "/v1/escrows",
    summary: "Lock funds for a task",
    tags: ["Escrow"],
    auth: ["agent"],
    idempotent: true,
    body: R.CreateEscrowRequest,
    response: R.Escrow,
    status: 201,
  }),
  getEscrow: route({
    operationId: "getEscrow",
    method: "GET",
    path: "/v1/escrows/{id}",
    summary: "Get an escrow",
    tags: ["Escrow"],
    auth: ["principal", "agent"],
    params: Id("escrow"),
    response: R.Escrow,
  }),
  submitEscrowSignature: route({
    operationId: "submitEscrowSignature",
    method: "POST",
    path: "/v1/escrows/{id}/signature",
    summary: "Submit the session-key signature for the pending escrow operation",
    tags: ["Escrow"],
    auth: ["agent"],
    idempotent: true,
    params: Id("escrow"),
    body: R.SubmitSignatureRequest,
    response: R.Escrow,
  }),
  releaseEscrow: route({
    operationId: "releaseEscrow",
    method: "POST",
    path: "/v1/escrows/{id}/release",
    summary: "Release escrowed funds to the payee",
    tags: ["Escrow"],
    auth: ["agent", "principal"],
    idempotent: true,
    params: Id("escrow"),
    response: R.Escrow,
  }),
  refundEscrow: route({
    operationId: "refundEscrow",
    method: "POST",
    path: "/v1/escrows/{id}/refund",
    summary: "Refund escrowed funds (payee anytime, anyone after expiry)",
    tags: ["Escrow"],
    auth: ["agent", "principal"],
    idempotent: true,
    params: Id("escrow"),
    response: R.Escrow,
  }),
  disputeEscrow: route({
    operationId: "disputeEscrow",
    method: "POST",
    path: "/v1/escrows/{id}/dispute",
    summary: "Dispute an escrow before expiry; the arbiter decides",
    tags: ["Escrow"],
    auth: ["agent", "principal"],
    idempotent: true,
    params: Id("escrow"),
    body: R.DisputeEscrowRequest,
    response: R.Escrow,
  }),

  // ------------------------------------------------------------ streams
  createStream: route({
    operationId: "createStream",
    method: "POST",
    path: "/v1/streams",
    summary: "Start a pre-funded stream or recurring payment",
    tags: ["Streams"],
    auth: ["agent"],
    idempotent: true,
    body: R.CreateStreamRequest,
    response: R.Stream,
    status: 201,
  }),
  getStream: route({
    operationId: "getStream",
    method: "GET",
    path: "/v1/streams/{id}",
    summary: "Get a stream",
    tags: ["Streams"],
    auth: ["principal", "agent"],
    params: Id("stream"),
    response: R.Stream,
  }),
  submitStreamSignature: route({
    operationId: "submitStreamSignature",
    method: "POST",
    path: "/v1/streams/{id}/signature",
    summary: "Submit the session-key signature for the pending stream operation",
    tags: ["Streams"],
    auth: ["agent"],
    idempotent: true,
    params: Id("stream"),
    body: R.SubmitSignatureRequest,
    response: R.Stream,
  }),
  cancelStream: route({
    operationId: "cancelStream",
    method: "POST",
    path: "/v1/streams/{id}/cancel",
    summary: "Cancel a stream: settle accrued, refund the remainder",
    tags: ["Streams"],
    auth: ["agent", "principal"],
    idempotent: true,
    params: Id("stream"),
    response: R.Stream,
  }),

  // ------------------------------------------------------------ approvals
  listApprovals: route({
    operationId: "listApprovals",
    method: "GET",
    path: "/v1/approvals",
    summary: "List approvals",
    tags: ["Approvals"],
    auth: ["approver", "principal"],
    query: ListQuery.extend({ status: z.enum(["pending", "approved", "denied", "expired"]).optional() }),
    response: page(R.Approval),
  }),
  getApproval: route({
    operationId: "getApproval",
    method: "GET",
    path: "/v1/approvals/{id}",
    summary: "Get an approval",
    tags: ["Approvals"],
    auth: ["approver", "principal"],
    params: Id("approval"),
    response: R.Approval,
  }),
  decideApproval: route({
    operationId: "decideApproval",
    method: "POST",
    path: "/v1/approvals/{id}/decide",
    summary: "Approve or deny a queued payment",
    tags: ["Approvals"],
    auth: ["approver"],
    idempotent: true,
    params: Id("approval"),
    body: R.DecideApprovalRequest,
    response: R.Approval,
  }),

  // ------------------------------------------------------------ ledger
  listEntries: route({
    operationId: "listEntries",
    method: "GET",
    path: "/v1/accounts/{id}/entries",
    summary: "List ledger entries touching an account",
    tags: ["Ledger"],
    auth: ["principal", "agent"],
    params: Id("account"),
    query: ListQuery,
    response: page(R.LedgerEntry),
  }),
  getStatement: route({
    operationId: "getStatement",
    method: "GET",
    path: "/v1/statements",
    summary: "Monthly statement (JSON or CSV)",
    tags: ["Ledger"],
    auth: ["principal", "agent"],
    query: z.object({
      account_id: idSchema("account"),
      period: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),
      format: z.enum(["json", "csv"]).default("json"),
    }),
    response: R.Statement,
    produces: ["text/csv"],
  }),

  // ------------------------------------------------------------ savings & treasury
  createVault: route({
    operationId: "createVault",
    method: "POST",
    path: "/v1/vaults",
    summary: "Create a goal or time-locked vault",
    tags: ["Savings"],
    auth: ["principal", "agent"],
    idempotent: true,
    body: R.CreateVaultRequest,
    response: R.Vault,
    status: 201,
  }),
  listVaults: route({
    operationId: "listVaults",
    method: "GET",
    path: "/v1/vaults",
    summary: "List vaults",
    tags: ["Savings"],
    auth: ["principal", "agent"],
    query: ListQuery.extend({ account_id: idSchema("account").optional() }),
    response: page(R.Vault),
  }),
  getVault: route({
    operationId: "getVault",
    method: "GET",
    path: "/v1/vaults/{id}",
    summary: "Get a vault",
    tags: ["Savings"],
    auth: ["principal", "agent"],
    params: Id("vault"),
    response: R.Vault,
  }),
  depositVault: route({
    operationId: "depositVault",
    method: "POST",
    path: "/v1/vaults/{id}/deposit",
    summary: "Move funds into a vault (agents may deposit)",
    tags: ["Savings"],
    auth: ["principal", "agent"],
    idempotent: true,
    params: Id("vault"),
    body: R.VaultTransferRequest,
    response: R.Vault,
  }),
  withdrawVault: route({
    operationId: "withdrawVault",
    method: "POST",
    path: "/v1/vaults/{id}/withdraw",
    summary: "Withdraw from a vault to its account (owner only before unlock)",
    tags: ["Savings"],
    auth: ["principal"],
    idempotent: true,
    params: Id("vault"),
    body: R.VaultTransferRequest,
    response: R.Vault,
  }),
  getAutoTopUp: route({
    operationId: "getAutoTopUp",
    method: "GET",
    path: "/v1/agents/{id}/auto-topup",
    summary: "Get the agent's auto top-up rule",
    tags: ["Treasury"],
    auth: ["principal", "agent"],
    params: Id("agent"),
    response: R.AutoTopUpRule.nullable(),
  }),
  putAutoTopUp: route({
    operationId: "putAutoTopUp",
    method: "PUT",
    path: "/v1/agents/{id}/auto-topup",
    summary: "Refill the agent from the treasury on rules (owner signature)",
    tags: ["Treasury"],
    auth: ["principal"],
    idempotent: true,
    params: Id("agent"),
    body: R.PutAutoTopUpRequest,
    response: R.AutoTopUpRule,
  }),
  listFunds: route({
    operationId: "listFunds",
    method: "GET",
    path: "/v1/funds",
    summary: "Eligible tokenized Treasury funds (neutral list, no recommendation)",
    tags: ["Treasury"],
    auth: ["principal"],
    response: z.object({ data: z.array(R.Fund) }),
  }),
  putSweepRule: route({
    operationId: "putSweepRule",
    method: "PUT",
    path: "/v1/accounts/{id}/sweep-rule",
    summary: "Configure the owner-directed treasury sweep (counsel-gated feature)",
    tags: ["Treasury"],
    auth: ["principal"],
    idempotent: true,
    params: Id("account"),
    body: R.PutSweepRuleRequest,
    response: R.SweepRule,
  }),

  // ------------------------------------------------------------ webhooks & events
  createWebhookEndpoint: route({
    operationId: "createWebhookEndpoint",
    method: "POST",
    path: "/v1/webhook-endpoints",
    summary: "Register a webhook endpoint",
    tags: ["Webhooks"],
    auth: ["principal"],
    idempotent: true,
    body: R.CreateWebhookEndpointRequest,
    response: R.WebhookEndpointWithSecret,
    status: 201,
  }),
  listWebhookEndpoints: route({
    operationId: "listWebhookEndpoints",
    method: "GET",
    path: "/v1/webhook-endpoints",
    summary: "List webhook endpoints",
    tags: ["Webhooks"],
    auth: ["principal"],
    query: ListQuery,
    response: page(R.WebhookEndpoint),
  }),
  deleteWebhookEndpoint: route({
    operationId: "deleteWebhookEndpoint",
    method: "DELETE",
    path: "/v1/webhook-endpoints/{id}",
    summary: "Disable a webhook endpoint",
    tags: ["Webhooks"],
    auth: ["principal"],
    params: Id("webhookEndpoint"),
    response: R.WebhookEndpoint,
  }),
  listEvents: route({
    operationId: "listEvents",
    method: "GET",
    path: "/v1/events",
    summary: "List events",
    tags: ["Webhooks"],
    auth: ["principal"],
    query: ListQuery.extend({ type: R.WebhookEventTypeSchema.optional() }),
    response: page(R.Event),
  }),

  // ------------------------------------------------------------ billing
  listPlans: route({
    operationId: "listPlans",
    method: "GET",
    path: "/v1/billing/plans",
    summary: "List plans",
    tags: ["Billing"],
    auth: ["public"],
    response: z.object({ data: z.array(R.Plan) }),
  }),
  getSubscription: route({
    operationId: "getSubscription",
    method: "GET",
    path: "/v1/billing/subscription",
    summary: "Get the org subscription",
    tags: ["Billing"],
    auth: ["principal"],
    response: R.Subscription,
  }),
  changePlan: route({
    operationId: "changePlan",
    method: "PUT",
    path: "/v1/billing/subscription",
    summary: "Change plan (billed monthly in USDC from the treasury)",
    tags: ["Billing"],
    auth: ["principal"],
    idempotent: true,
    body: R.ChangePlanRequest,
    response: R.Subscription,
  }),
  getFees: route({
    operationId: "getFees",
    method: "GET",
    path: "/v1/billing/fees",
    summary: "Fees charged in a period",
    tags: ["Billing"],
    auth: ["principal"],
    query: z.object({ period: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/) }),
    response: R.FeeSummary,
  }),
  getRevenueReport: route({
    operationId: "getRevenueReport",
    method: "GET",
    path: "/v1/admin/revenue",
    summary: "Revenue by stream, gross margin and volume per org (staff only)",
    tags: ["Admin"],
    auth: ["staff"],
    query: z.object({ period: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/) }),
    response: R.RevenueReport,
  }),
  health: route({
    operationId: "health",
    method: "GET",
    path: "/healthz",
    summary: "Liveness and dependency checks",
    tags: ["Meta"],
    auth: ["public"],
    response: R.Health,
  }),
} as const;

export type Routes = typeof routes;
export type OperationId = keyof Routes;

type Infer<T> = T extends z.ZodType ? z.output<T> : undefined;
type InferIn<T> = T extends z.ZodType ? z.input<T> : undefined;

/** Parsed (output) request types, as the server sees them. */
export type RequestOf<K extends OperationId> = {
  params: Infer<Routes[K] extends { params: infer P } ? P : undefined>;
  query: Infer<Routes[K] extends { query: infer Q } ? Q : undefined>;
  body: Infer<Routes[K] extends { body: infer B } ? B : undefined>;
};

/** Input request types, as SDK callers write them (defaults optional). */
export type RequestInputOf<K extends OperationId> = {
  params: InferIn<Routes[K] extends { params: infer P } ? P : undefined>;
  query: InferIn<Routes[K] extends { query: infer Q } ? Q : undefined>;
  body: InferIn<Routes[K] extends { body: infer B } ? B : undefined>;
};

export type ResponseOf<K extends OperationId> = z.output<Routes[K]["response"]>;

export const ROUTE_LIST: readonly RouteDef[] = Object.values(routes);

/** Domains in x402 challenges are compared lowercase. */
export const X402DomainSchema = DomainSchema;
