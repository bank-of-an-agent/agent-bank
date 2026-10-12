import type { OperationId, RequestInputOf, ResponseOf } from "@agentbank/core/api";
import type { RequestArgsTuple, RequestOptions } from "./client";
import type {
  Account,
  AgentPolicy,
  Agent,
  ApiKey,
  ApiKeyWithSecret,
  Approval,
  AttachSpendKeyInput,
  AutoTopUpRule,
  Balances,
  ChangePlanInput,
  CreateAccountInput,
  CreateAgentInput,
  CreateApiKeyInput,
  CreateEscrowInput,
  CreateMandateInput,
  CreateMemberInput,
  CreateOrgInput,
  CreateOrgResult,
  CreatePaymentInput,
  CreatePaymentRequestInput,
  CreateSessionInput,
  CreateStreamInput,
  CreateTreasuryAccountInput,
  CreateVaultInput,
  CreateWebhookEndpointInput,
  DecideApprovalInput,
  DisputeEscrowInput,
  Escrow,
  Event,
  FeeSummary,
  FreezeInput,
  Fund,
  KybSession,
  LedgerEntry,
  Mandate,
  Member,
  Org,
  OwnerOperation,
  Page,
  Payment,
  PaymentRequest,
  Plan,
  PolicyCheckInput,
  PolicyDecision,
  PrepareOwnerSwapInput,
  PutAutoTopUpInput,
  PutPolicyInput,
  PutSweepRuleInput,
  RegisterX402PayeeInput,
  RotateOwnerInput,
  SandboxFaucetInput,
  SandboxFaucetResult,
  Session,
  SetTreasuryInput,
  Statement,
  Stream,
  SubmitOwnerSignatureInput,
  SubmitSignatureInput,
  Subscription,
  SweepRule,
  UnfreezeInput,
  Vault,
  VaultTransferInput,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  X402PayInput,
  X402PayResponse,
  X402Payee,
  X402SettleResponse,
  X402SupportedResponse,
  X402VerifyInput,
  X402VerifyResponse,
} from "./types";

/**
 * Resource namespaces: one method per API operation, grouped like the
 * OpenAPI tags. Every method takes an optional {@link RequestOptions} last
 * argument (idempotency key, abort signal, timeout, retries, extra headers).
 * Writes get an automatic `Idempotency-Key` that is reused across retries;
 * pass your own `idempotencyKey` to make a retry *across process restarts*
 * safe too.
 *
 * Who may call what is enforced by the API: principal routes need an API
 * key, agent routes need a session key (RFC 9421 signatures).
 *
 * @packageDocumentation
 */

/** The minimal client surface the namespaces need. */
export interface Requester {
  request<K extends OperationId>(operationId: K, ...args: RequestArgsTuple<K>): Promise<ResponseOf<K>>;
}

/** Query parameters of a list operation. */
export type QueryOf<K extends OperationId> = NonNullable<RequestInputOf<K>["query"]>;

abstract class Resource {
  constructor(protected readonly client: Requester) {}
}

/** Orgs (principals): sign-up, KYB, freezing, treasury. */
export class Orgs extends Resource {
  /**
   * Create an org and its first admin API key (public route; no credentials
   * needed). The key's `secret` is shown once: store it in a secret manager.
   */
  create(body: CreateOrgInput, options?: RequestOptions): Promise<CreateOrgResult> {
    return this.client.request("createOrg", { ...options, body });
  }
  /** The org the API key belongs to. */
  retrieve(options?: RequestOptions): Promise<Org> {
    return this.client.request("getCurrentOrg", { ...options });
  }
  /** Start or resume KYC/KYB verification. */
  startKyb(options?: RequestOptions): Promise<KybSession> {
    return this.client.request("startKyb", { ...options });
  }
  /** Freeze every agent in the org immediately (tightening: takes effect at once). */
  freeze(body: FreezeInput, options?: RequestOptions): Promise<Org> {
    return this.client.request("freezeOrg", { ...options, body });
  }
  /**
   * Unfreeze the org. Loosening: needs an owner authorization (`org.unfreeze`)
   * and takes effect after a 1-hour delay. See `PrincipalClient.unfreezeOrg`.
   */
  unfreeze(body: UnfreezeInput, options?: RequestOptions): Promise<Org> {
    return this.client.request("unfreezeOrg", { ...options, body });
  }
  /** Create the org treasury smart account. */
  createTreasuryAccount(body: CreateTreasuryAccountInput = {}, options?: RequestOptions): Promise<Account> {
    return this.client.request("createTreasuryAccount", { ...options, body });
  }
  /** Set the org treasury account (owner authorization `treasury.set`). */
  setTreasury(body: SetTreasuryInput, options?: RequestOptions): Promise<Org> {
    return this.client.request("setTreasury", { ...options, body });
  }
  /**
   * Rotate the org owner key (owner authorization `owner.rotate` by the
   * current owner). Swap the Safe owner on every account first
   * (`ownerOperations.prepareOwnerSwap`). See `PrincipalClient.rotateOwner`.
   */
  rotateOwner(body: RotateOwnerInput, options?: RequestOptions): Promise<Org> {
    return this.client.request("rotateOwner", { ...options, body });
  }
}

/** Org API keys (principal automation credentials). */
export class ApiKeys extends Resource {
  /** List API keys (`GET /v1/api-keys`). */
  list(query: QueryOf<"listApiKeys"> = {}, options?: RequestOptions): Promise<Page<ApiKey>> {
    return this.client.request("listApiKeys", { ...options, query });
  }
  /** Create an API key; `secret` is returned once. */
  create(body: CreateApiKeyInput, options?: RequestOptions): Promise<ApiKeyWithSecret> {
    return this.client.request("createApiKey", { ...options, body });
  }
  /** Revoke an API key (`DELETE /v1/api-keys/{id}`). */
  revoke(id: string, options?: RequestOptions): Promise<ApiKey> {
    return this.client.request("revokeApiKey", { ...options, params: { id } });
  }
}

/** Org members (admins, approvers, viewers). */
export class Members extends Resource {
  /** List org members (`GET /v1/members`). */
  list(query: QueryOf<"listMembers"> = {}, options?: RequestOptions): Promise<Page<Member>> {
    return this.client.request("listMembers", { ...options, query });
  }
  /** Invite a member (admin, approver or viewer) (`POST /v1/members`). */
  create(body: CreateMemberInput, options?: RequestOptions): Promise<Member> {
    return this.client.request("createMember", { ...options, body });
  }
}

/** Agents: software identities acting for the principal. */
export class Agents extends Resource {
  /** Create an agent (`POST /v1/agents`). */
  create(body: CreateAgentInput, options?: RequestOptions): Promise<Agent> {
    return this.client.request("createAgent", { ...options, body });
  }
  /** List agents (`GET /v1/agents`). */
  list(query: QueryOf<"listAgents"> = {}, options?: RequestOptions): Promise<Page<Agent>> {
    return this.client.request("listAgents", { ...options, query });
  }
  /** Get an agent (`GET /v1/agents/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Agent> {
    return this.client.request("getAgent", { ...options, params: { id } });
  }
  /** Freeze an agent immediately; the co-signer refuses every operation for it. */
  freeze(id: string, body: FreezeInput, options?: RequestOptions): Promise<Agent> {
    return this.client.request("freezeAgent", { ...options, params: { id }, body });
  }
  /** Unfreeze (owner authorization `agent.unfreeze`, 1-hour delay). See `PrincipalClient.unfreezeAgent`. */
  unfreeze(id: string, body: UnfreezeInput, options?: RequestOptions): Promise<Agent> {
    return this.client.request("unfreezeAgent", { ...options, params: { id }, body });
  }
}

/** Smart accounts and balances. */
export class Accounts extends Resource {
  /**
   * Create the agent's smart account on a chain (counterfactual address; it
   * can receive funds before deployment). Pass `spend_key_address` to enable x402.
   */
  create(agentId: string, body: CreateAccountInput = {}, options?: RequestOptions): Promise<Account> {
    return this.client.request("createAccount", { ...options, params: { id: agentId }, body });
  }
  /** List accounts (`GET /v1/accounts`). */
  list(query: QueryOf<"listAccounts"> = {}, options?: RequestOptions): Promise<Page<Account>> {
    return this.client.request("listAccounts", { ...options, query });
  }
  /** Get an account (`GET /v1/accounts/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Account> {
    return this.client.request("getAccount", { ...options, params: { id } });
  }
  /** Available, reserved, escrowed, saved and spend-float balances. */
  balances(id: string, options?: RequestOptions): Promise<Balances> {
    return this.client.request("getBalances", { ...options, params: { id } });
  }
  /**
   * Attach the agent's x402 spend key with its float-recovery permit (ADR
   * 0001) and the owner's `spend_key.set` authorization; the permit runs
   * on-chain in the account's next owner operation. See
   * `PrincipalClient.provisionSpendKey`.
   */
  attachSpendKey(id: string, body: AttachSpendKeyInput, options?: RequestOptions): Promise<Account> {
    return this.client.request("attachSpendKey", { ...options, params: { id }, body });
  }
}

/** Session keys (scoped, short-lived agent keys). */
export class Sessions extends Resource {
  /**
   * Register a session public key and scope. Needs an owner authorization
   * (`session.grant` over `{account_id, public_key, scope}`). Prefer
   * `PrincipalClient.grantSession`, which also installs the session on-chain.
   */
  create(body: CreateSessionInput, options?: RequestOptions): Promise<Session> {
    return this.client.request("createSession", { ...options, body });
  }
  /** List sessions (`GET /v1/sessions`). */
  list(query: QueryOf<"listSessions"> = {}, options?: RequestOptions): Promise<Page<Session>> {
    return this.client.request("listSessions", { ...options, query });
  }
  /** Get a session (`GET /v1/sessions/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Session> {
    return this.client.request("getSession", { ...options, params: { id } });
  }
  /** Revoke off-chain immediately. The owner should also revoke on-chain as the hard backstop. */
  revoke(id: string, options?: RequestOptions): Promise<Session> {
    return this.client.request("revokeSession", { ...options, params: { id } });
  }
  /** Prepare the owner operation that installs the session on-chain (`install_operation_id`). */
  install(id: string, options?: RequestOptions): Promise<Session> {
    return this.client.request("installSession", { ...options, params: { id } });
  }
}

/** Owner operations: on-chain operations only the owner key can authorize. */
export class OwnerOperations extends Resource {
  /** List owner operations (`GET /v1/owner-operations`). */
  list(query: QueryOf<"listOwnerOperations"> = {}, options?: RequestOptions): Promise<Page<OwnerOperation>> {
    return this.client.request("listOwnerOperations", { ...options, query });
  }
  /** Get an owner operation (`GET /v1/owner-operations/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<OwnerOperation> {
    return this.client.request("getOwnerOperation", { ...options, params: { id } });
  }
  /** Submit the owner key's EIP-191 signature over `user_op_hash`. */
  submitSignature(
    id: string,
    body: SubmitOwnerSignatureInput,
    options?: RequestOptions,
  ): Promise<OwnerOperation> {
    return this.client.request("submitOwnerSignature", { ...options, params: { id }, body });
  }
  /**
   * Prepare the owner operation that swaps the Safe owner of one account to
   * `new_owner_address` (sign it with the **current** owner key). Part of
   * owner-key rotation.
   */
  prepareOwnerSwap(
    accountId: string,
    body: PrepareOwnerSwapInput,
    options?: RequestOptions,
  ): Promise<OwnerOperation> {
    return this.client.request("prepareOwnerSwap", { ...options, params: { id: accountId }, body });
  }
}

/** AP2 payment mandates. */
export class Mandates extends Resource {
  /** Grant authority with a signed AP2 open payment mandate (owner authorization `mandate.issue`). */
  create(body: CreateMandateInput, options?: RequestOptions): Promise<Mandate> {
    return this.client.request("createMandate", { ...options, body });
  }
  /** List mandates (`GET /v1/mandates`). */
  list(query: QueryOf<"listMandates"> = {}, options?: RequestOptions): Promise<Page<Mandate>> {
    return this.client.request("listMandates", { ...options, query });
  }
  /** Get a mandate (`GET /v1/mandates/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Mandate> {
    return this.client.request("getMandate", { ...options, params: { id } });
  }
  /** Revoke a mandate (`DELETE /v1/mandates/{id}`). */
  revoke(id: string, options?: RequestOptions): Promise<Mandate> {
    return this.client.request("revokeMandate", { ...options, params: { id } });
  }
}

/** Spending policies. */
export class Policies extends Resource {
  /** The agent's current policy and any pending loosening change. */
  retrieve(agentId: string, options?: RequestOptions): Promise<AgentPolicy> {
    return this.client.request("getPolicy", { ...options, params: { id: agentId } });
  }
  /**
   * Replace the policy. Tightening applies immediately; loosening needs an
   * owner authorization (`policy.loosen`) and a 1-hour delay. See `PrincipalClient.setPolicy`.
   */
  put(agentId: string, body: PutPolicyInput, options?: RequestOptions): Promise<AgentPolicy> {
    return this.client.request("putPolicy", { ...options, params: { id: agentId }, body });
  }
  /** Dry-run a payment against policy. Nothing is held or sent. */
  check(body: PolicyCheckInput, options?: RequestOptions): Promise<PolicyDecision> {
    return this.client.request("checkPolicy", { ...options, body });
  }
}

/** Payments (agent-to-agent and external transfers). */
export class Payments extends Resource {
  /**
   * Create a payment: places a hold and evaluates policy. The result is
   * `requires_signature` (sign `signing_request.user_op_hash`),
   * `requires_approval` or `denied`. `AgentClient.pay` does the whole flow.
   */
  create(body: CreatePaymentInput, options?: RequestOptions): Promise<Payment> {
    return this.client.request("createPayment", { ...options, body });
  }
  /** List payments (`GET /v1/payments`). */
  list(query: QueryOf<"listPayments"> = {}, options?: RequestOptions): Promise<Page<Payment>> {
    return this.client.request("listPayments", { ...options, query });
  }
  /** Get a payment (`GET /v1/payments/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Payment> {
    return this.client.request("getPayment", { ...options, params: { id } });
  }
  /** Submit the session-key signature; the co-signer re-checks policy and co-signs. */
  submitSignature(id: string, body: SubmitSignatureInput, options?: RequestOptions): Promise<Payment> {
    return this.client.request("submitPaymentSignature", { ...options, params: { id }, body });
  }
  /** Cancel a payment that has not been submitted (voids the hold). */
  cancel(id: string, options?: RequestOptions): Promise<Payment> {
    return this.client.request("cancelPayment", { ...options, params: { id } });
  }
}

/** Payment requests ("please pay me"). */
export class PaymentRequests extends Resource {
  /** Ask another agent or a human to pay (`POST /v1/payment-requests`). */
  create(body: CreatePaymentRequestInput, options?: RequestOptions): Promise<PaymentRequest> {
    return this.client.request("createPaymentRequest", { ...options, body });
  }
  /** Get a payment request (`GET /v1/payment-requests/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<PaymentRequest> {
    return this.client.request("getPaymentRequest", { ...options, params: { id } });
  }
}

/** x402: paying for HTTP resources (agents) and the facilitator (sellers). */
export class X402 extends Resource {
  /**
   * Answer a 402 challenge within policy: returns the EIP-3009 authorization
   * for the agent's spend key to sign. `AgentClient.fetch` does the whole flow.
   */
  pay(body: X402PayInput, options?: RequestOptions): Promise<X402PayResponse> {
    return this.client.request("x402Pay", { ...options, body });
  }
  /** Facilitator: verify a payment payload (served by the facilitator service). */
  verify(body: X402VerifyInput, options?: RequestOptions): Promise<X402VerifyResponse> {
    return this.client.request("x402Verify", { ...options, body });
  }
  /** Facilitator: settle a payment payload on-chain. */
  settle(body: X402VerifyInput, options?: RequestOptions): Promise<X402SettleResponse> {
    return this.client.request("x402Settle", { ...options, body });
  }
  /** Facilitator: supported schemes and networks. */
  supported(options?: RequestOptions): Promise<X402SupportedResponse> {
    return this.client.request("x402Supported", { ...options });
  }
  /** Register an account to charge per call (x402 receive). */
  registerPayee(body: RegisterX402PayeeInput, options?: RequestOptions): Promise<X402Payee> {
    return this.client.request("registerX402Payee", { ...options, body });
  }
}

/** Escrows: lock funds for a task, release on approval, refund on timeout, dispute to an arbiter. */
export class Escrows extends Resource {
  /** Lock funds for a task (`POST /v1/escrows`). */
  create(body: CreateEscrowInput, options?: RequestOptions): Promise<Escrow> {
    return this.client.request("createEscrow", { ...options, body });
  }
  /** List escrows (`GET /v1/escrows`). */
  list(query: QueryOf<"listEscrows"> = {}, options?: RequestOptions): Promise<Page<Escrow>> {
    return this.client.request("listEscrows", { ...options, query });
  }
  /** Get an escrow (`GET /v1/escrows/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Escrow> {
    return this.client.request("getEscrow", { ...options, params: { id } });
  }
  /** Submit the session-key signature for the pending escrow operation. */
  submitSignature(id: string, body: SubmitSignatureInput, options?: RequestOptions): Promise<Escrow> {
    return this.client.request("submitEscrowSignature", { ...options, params: { id }, body });
  }
  /** Release escrowed funds to the payee (`POST /v1/escrows/{id}/release`). */
  release(id: string, options?: RequestOptions): Promise<Escrow> {
    return this.client.request("releaseEscrow", { ...options, params: { id } });
  }
  /** Refund escrowed funds (payee anytime, anyone after expiry) (`POST /v1/escrows/{id}/refund`). */
  refund(id: string, options?: RequestOptions): Promise<Escrow> {
    return this.client.request("refundEscrow", { ...options, params: { id } });
  }
  /** Dispute an escrow before expiry; the arbiter decides (`POST /v1/escrows/{id}/dispute`). */
  dispute(id: string, body: DisputeEscrowInput, options?: RequestOptions): Promise<Escrow> {
    return this.client.request("disputeEscrow", { ...options, params: { id }, body });
  }
}

/** Streams and recurring payments (pre-funded, settled on an interval). */
export class Streams extends Resource {
  /** Start a pre-funded stream or recurring payment (`POST /v1/streams`). */
  create(body: CreateStreamInput, options?: RequestOptions): Promise<Stream> {
    return this.client.request("createStream", { ...options, body });
  }
  /** List streams (`GET /v1/streams`). */
  list(query: QueryOf<"listStreams"> = {}, options?: RequestOptions): Promise<Page<Stream>> {
    return this.client.request("listStreams", { ...options, query });
  }
  /** Get a stream (`GET /v1/streams/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Stream> {
    return this.client.request("getStream", { ...options, params: { id } });
  }
  /** Submit the session-key signature for the pending stream operation (`POST /v1/streams/{id}/signature`). */
  submitSignature(id: string, body: SubmitSignatureInput, options?: RequestOptions): Promise<Stream> {
    return this.client.request("submitStreamSignature", { ...options, params: { id }, body });
  }
  /** Cancel: settle what has accrued, refund the remainder. */
  cancel(id: string, options?: RequestOptions): Promise<Stream> {
    return this.client.request("cancelStream", { ...options, params: { id } });
  }
}

/** Human approvals of queued payments (expire after 15 minutes). */
export class Approvals extends Resource {
  /** List approvals (`GET /v1/approvals`). */
  list(query: QueryOf<"listApprovals"> = {}, options?: RequestOptions): Promise<Page<Approval>> {
    return this.client.request("listApprovals", { ...options, query });
  }
  /** Get an approval (`GET /v1/approvals/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Approval> {
    return this.client.request("getApproval", { ...options, params: { id } });
  }
  /** Approve or deny a queued payment (`POST /v1/approvals/{id}/decide`). */
  decide(id: string, body: DecideApprovalInput, options?: RequestOptions): Promise<Approval> {
    return this.client.request("decideApproval", { ...options, params: { id }, body });
  }
}

/** The double-entry ledger and statements. */
export class Ledger extends Resource {
  /** Ledger entries touching an account (newest first). */
  listEntries(
    accountId: string,
    query: QueryOf<"listEntries"> = {},
    options?: RequestOptions,
  ): Promise<Page<LedgerEntry>> {
    return this.client.request("listEntries", { ...options, params: { id: accountId }, query });
  }
  /** Monthly statement as JSON. `period` is `YYYY-MM`. */
  statement(query: { account_id: string; period: string }, options?: RequestOptions): Promise<Statement> {
    return this.client.request("getStatement", { ...options, query: { ...query, format: "json" } });
  }
  /** Monthly statement as CSV text. */
  async statementCsv(
    query: { account_id: string; period: string },
    options?: RequestOptions,
  ): Promise<string> {
    const result: unknown = await this.client.request("getStatement", {
      ...options,
      query: { ...query, format: "csv" },
      headers: { accept: "text/csv", ...options?.headers },
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  }
}

/** Vaults (goal vaults are ledger-only; locked vaults use the TimeLockVaults contract). */
export class Vaults extends Resource {
  /** Create a goal or time-locked vault (`POST /v1/vaults`). */
  create(body: CreateVaultInput, options?: RequestOptions): Promise<Vault> {
    return this.client.request("createVault", { ...options, body });
  }
  /** List vaults (`GET /v1/vaults`). */
  list(query: QueryOf<"listVaults"> = {}, options?: RequestOptions): Promise<Page<Vault>> {
    return this.client.request("listVaults", { ...options, query });
  }
  /** Get a vault (`GET /v1/vaults/{id}`). */
  retrieve(id: string, options?: RequestOptions): Promise<Vault> {
    return this.client.request("getVault", { ...options, params: { id } });
  }
  /** Move funds into a vault (agents may deposit). */
  deposit(id: string, body: VaultTransferInput, options?: RequestOptions): Promise<Vault> {
    return this.client.request("depositVault", { ...options, params: { id }, body });
  }
  /**
   * Withdraw to the account (principal only). Goal vaults and unlocked
   * locked vaults need no signature; an early withdrawal from a locked vault
   * answers `owner_signature_required` with TimeLockVaults `EarlyWithdrawal`
   * typed data to sign first. `PrincipalClient.withdrawVault` runs that flow.
   */
  withdraw(id: string, body: VaultTransferInput, options?: RequestOptions): Promise<Vault> {
    return this.client.request("withdrawVault", { ...options, params: { id }, body });
  }
}

/** Org treasury: auto top-up, fund list, sweep rules. */
export class Treasury extends Resource {
  /** Create the org treasury smart account (same operation as `orgs.createTreasuryAccount`). */
  createAccount(body: CreateTreasuryAccountInput = {}, options?: RequestOptions): Promise<Account> {
    return this.client.request("createTreasuryAccount", { ...options, body });
  }
  /** Set the org treasury account (same operation as `orgs.setTreasury`). */
  set(body: SetTreasuryInput, options?: RequestOptions): Promise<Org> {
    return this.client.request("setTreasury", { ...options, body });
  }
  /** Get the agent's auto top-up rule (`GET /v1/agents/{id}/auto-topup`). */
  getAutoTopUp(agentId: string, options?: RequestOptions): Promise<AutoTopUpRule | null> {
    return this.client.request("getAutoTopUp", { ...options, params: { id: agentId } });
  }
  /** Refill the agent from the treasury on rules (owner authorization `topup.set`). */
  putAutoTopUp(agentId: string, body: PutAutoTopUpInput, options?: RequestOptions): Promise<AutoTopUpRule> {
    return this.client.request("putAutoTopUp", { ...options, params: { id: agentId }, body });
  }
  /** Eligible tokenized Treasury funds (a neutral list; no recommendation). */
  listFunds(options?: RequestOptions): Promise<{ data: Fund[] }> {
    return this.client.request("listFunds", { ...options });
  }
  /** List auto top-up rules (`GET /v1/auto-topup-rules`). */
  listAutoTopUpRules(
    query: QueryOf<"listAutoTopUpRules"> = {},
    options?: RequestOptions,
  ): Promise<Page<AutoTopUpRule>> {
    return this.client.request("listAutoTopUpRules", { ...options, query });
  }
  /** The account's treasury sweep rule, or `null` (`GET /v1/accounts/{id}/sweep-rule`). */
  getSweepRule(accountId: string, options?: RequestOptions): Promise<SweepRule | null> {
    return this.client.request("getSweepRule", { ...options, params: { id: accountId } });
  }
  /** Configure the owner-directed treasury sweep (counsel-gated; owner authorization `sweep.set`). */
  putSweepRule(accountId: string, body: PutSweepRuleInput, options?: RequestOptions): Promise<SweepRule> {
    return this.client.request("putSweepRule", { ...options, params: { id: accountId }, body });
  }
}

/** Webhook endpoints and the event log. Verify deliveries with `verifyWebhook` / `parseWebhookEvent`. */
export class Webhooks extends Resource {
  /** Register an endpoint; the HMAC `secret` is returned once. */
  createEndpoint(
    body: CreateWebhookEndpointInput,
    options?: RequestOptions,
  ): Promise<WebhookEndpointWithSecret> {
    return this.client.request("createWebhookEndpoint", { ...options, body });
  }
  /** List webhook endpoints (`GET /v1/webhook-endpoints`). */
  listEndpoints(
    query: QueryOf<"listWebhookEndpoints"> = {},
    options?: RequestOptions,
  ): Promise<Page<WebhookEndpoint>> {
    return this.client.request("listWebhookEndpoints", { ...options, query });
  }
  /** Disable a webhook endpoint (`DELETE /v1/webhook-endpoints/{id}`). */
  deleteEndpoint(id: string, options?: RequestOptions): Promise<WebhookEndpoint> {
    return this.client.request("deleteWebhookEndpoint", { ...options, params: { id } });
  }
  /** List events (`GET /v1/events`). */
  listEvents(query: QueryOf<"listEvents"> = {}, options?: RequestOptions): Promise<Page<Event>> {
    return this.client.request("listEvents", { ...options, query });
  }
}

/** Plans, subscription and fees. */
export class Billing extends Resource {
  /** List plans (`GET /v1/billing/plans`). */
  listPlans(options?: RequestOptions): Promise<{ data: Plan[] }> {
    return this.client.request("listPlans", { ...options });
  }
  /** Get the org subscription (`GET /v1/billing/subscription`). */
  subscription(options?: RequestOptions): Promise<Subscription> {
    return this.client.request("getSubscription", { ...options });
  }
  /** Change plan (billed monthly in USDC from the treasury) (`PUT /v1/billing/subscription`). */
  changePlan(body: ChangePlanInput, options?: RequestOptions): Promise<Subscription> {
    return this.client.request("changePlan", { ...options, body });
  }
  /** Fees charged in a period (`YYYY-MM`). */
  fees(query: QueryOf<"getFees">, options?: RequestOptions): Promise<FeeSummary> {
    return this.client.request("getFees", { ...options, query });
  }
}

/** Sandbox helpers for local development (simulated chain and Anvil only). */
export class Sandbox extends Resource {
  /**
   * Mint test USDC to an account or address (`POST /v1/sandbox/faucet`).
   * Returns 403 `feature_gated` on Base Sepolia, where test USDC comes from
   * Circle's faucet.
   */
  faucet(body: SandboxFaucetInput, options?: RequestOptions): Promise<SandboxFaucetResult> {
    return this.client.request("sandboxFaucet", { ...options, body });
  }
}
