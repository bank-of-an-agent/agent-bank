import { formatAmount, parseAmount } from "@agentbank/core";
import {
  AgentBankClient,
  type ClientOptions,
  type FetchLike,
  type RequestOptions,
  type SessionCredentials,
} from "./client";
import { ConflictError, InvalidRequestError, PaymentFailedError, PolicyDeniedError } from "./errors";
import { pollUntil, type WaitOptions } from "./internal/poll";
import { signOperationHash, type SpendSigner } from "./signers";
import type {
  Balances,
  CreateEscrowInput,
  CreateStreamInput,
  Escrow,
  EscrowStatus,
  LedgerEntry,
  Page,
  Payment,
  PaymentIntentInput,
  PaymentRequest,
  PaymentStatus,
  PolicyDecision,
  SigningRequest,
  Stream,
  StreamStatus,
  SubmitSignatureInput,
  X402PayResponse,
} from "./types";
import { transferWithAuthorizationTypedData } from "./x402/eip3009";
import {
  fetchWithX402,
  resolveX402Options,
  wrapFetch,
  X402Error,
  type SelectedRequirement,
  type X402ClientOptions,
  type X402FetchResult,
  type X402Payer,
  type X402PaymentContext,
} from "./x402/client";
import type { ExactEvmPayload } from "./x402/protocol";

export type { WaitOptions } from "./internal/poll";

/** USDC decimals. */
const USDC_DECIMALS = 6;

/** x402 settings of an {@link AgentClient}. */
export interface AgentX402Options extends X402ClientOptions {
  /** Mandate to run x402 payments under (recorded on every payment). */
  mandateId?: string;
  /** `fetch` used for the paid resources themselves (default: the global `fetch`). */
  fetch?: FetchLike;
}

/** Options of {@link AgentClient}. */
export interface AgentClientOptions extends Omit<ClientOptions, "apiKey" | "session"> {
  /** The agent's account (`acct_…`); used whenever a call needs one. */
  accountId: string;
  /** Session id and session key; every API request is signed with it. */
  session: SessionCredentials;
  /** The x402 spend key (needed for {@link AgentClient.fetch} payments). */
  spendKey?: SpendSigner;
  /** x402 client settings. */
  x402?: AgentX402Options;
}

/**
 * Who to pay: an address (`0x…`), an agent id (`agt_…`), an account id
 * (`acct_…`), or the explicit object form.
 */
export type PaymentTarget = string | { address: string } | { agentId: string } | { accountId: string };

/** Input of {@link AgentClient.pay}. */
export interface PayInput {
  to: PaymentTarget;
  /** Decimal string in USDC, e.g. `"12.50"`. Never a number. */
  amount: string;
  memo?: string;
  /** AP2 mandate the payment runs under. */
  mandateId?: string;
  /** Payment request being paid. */
  paymentRequestId?: string;
  metadata?: Record<string, string>;
  /** Pay from another account than the client's (rare). */
  accountId?: string;
}

/** Options of the high-level flows (pay, escrow, stream). */
export interface FlowOptions extends WaitOptions {
  /** Idempotency key of the create call; reuse it to retry the same payment safely. */
  idempotencyKey?: string;
  /**
   * Wait (polling) until the payment settles, fails or is denied
   * (default `false`). A timeout is not an error: inspect the returned status.
   */
  waitForSettlement?: boolean;
  /**
   * When the payment needs human approval, wait for the decision and then
   * sign (default `false`: return the `requires_approval` payment).
   */
  waitForApproval?: boolean;
}

/** Input of {@link AgentClient.checkSpend}. */
export interface CheckSpendInput {
  /** Decimal USDC amount. */
  amount: string;
  /** Counterparty to evaluate (address, agent id or account id), if any. */
  to?: PaymentTarget;
  kind?: PaymentIntentInput["kind"];
  /** For x402 payments: the seller's domain (lowercase hostname). */
  x402Domain?: string;
  mandateId?: string;
}

/** Input of {@link AgentClient.createEscrow}. */
export interface CreateEscrowFlowInput {
  /** Payee address (`0x…`) or agent id (`agt_…`). */
  payee: string | { address: string } | { agentId: string };
  /** Decimal USDC amount to lock. */
  amount: string;
  /** When the escrow expires (ISO 8601 or `Date`). Defaults to `expiresInSeconds` from now. */
  expiresAt?: string | Date;
  /** Expiry relative to now, in seconds (default 7 days). */
  expiresInSeconds?: number;
  release?: CreateEscrowInput["release"];
  arbiter?: string;
  validator?: CreateEscrowInput["validator"];
  terms?: string;
  memo?: string;
  mandateId?: string;
}

/** Input of {@link AgentClient.createStream}. */
export interface CreateStreamFlowInput {
  payee: string | { address: string } | { agentId: string };
  kind?: CreateStreamInput["kind"];
  /** Decimal USDC paid per interval. */
  amountPerInterval: string;
  /** Interval length in seconds (1 for per-second streaming). */
  intervalSeconds: number;
  /** Decimal USDC pre-funded deposit. */
  deposit: string;
  settleEverySeconds?: number;
  startAt?: string | Date;
  stopAt?: string | Date;
  mandateId?: string;
}

const PAYMENT_TERMINAL: ReadonlySet<PaymentStatus> = new Set([
  "settled",
  "failed",
  "denied",
  "canceled",
  "expired",
]);
/** Escrow statuses at which each pending action is complete (for `waitForSettlement`). */
const ESCROW_DONE: Record<NonNullable<Escrow["pending_action"]>, ReadonlySet<EscrowStatus>> = {
  lock: new Set(["locked", "released", "refunded", "disputed", "resolved", "failed", "canceled"]),
  release: new Set(["released", "resolved", "failed", "canceled"]),
  refund: new Set(["refunded", "resolved", "failed", "canceled"]),
  dispute: new Set(["disputed", "resolved", "released", "refunded", "failed", "canceled"]),
};
/** Stream statuses at which each pending action is complete (for `waitForSettlement`). */
const STREAM_DONE: Record<NonNullable<Stream["pending_action"]>, ReadonlySet<StreamStatus>> = {
  create: new Set(["active", "paused", "completed", "canceled", "failed"]),
  cancel: new Set(["canceled", "completed", "failed"]),
  top_up: new Set(["active", "paused", "completed", "canceled", "failed"]),
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Normalize a payment target into the API's `to` object. */
export function toPaymentTarget(target: PaymentTarget): {
  address?: string;
  agent_id?: string;
  account_id?: string;
} {
  if (typeof target === "string") {
    if (ADDRESS_RE.test(target)) return { address: target };
    if (target.startsWith("agt_")) return { agent_id: target };
    if (target.startsWith("acct_")) return { account_id: target };
    throw new InvalidRequestError(
      "invalid_request",
      "Payment target must be an address (0x…), an agent id (agt_…) or an account id (acct_…)",
    );
  }
  if ("address" in target) return { address: target.address };
  if ("agentId" in target) return { agent_id: target.agentId };
  return { account_id: target.accountId };
}

function toPayee(payee: CreateEscrowFlowInput["payee"]): { address?: string; agent_id?: string } {
  const target = toPaymentTarget(payee);
  if (target.account_id) {
    throw new InvalidRequestError(
      "invalid_request",
      "Escrow and stream payees must be an address or an agent id",
    );
  }
  return target;
}

/** Validate a decimal USDC amount and return it in canonical form (`"5"` → `"5.00"`). */
export function normalizeAmount(amount: string, field = "amount"): string {
  if (typeof amount !== "string") {
    throw new InvalidRequestError("invalid_amount", `${field} must be a decimal string such as "12.50"`);
  }
  try {
    return formatAmount(parseAmount(amount, USDC_DECIMALS), USDC_DECIMALS);
  } catch {
    throw new InvalidRequestError(
      "invalid_amount",
      `${field} must be a non-negative decimal string with at most 6 decimals`,
    );
  }
}

function isoTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * High-level client for an **agent**: authenticated with its session key,
 * bound to its account, with the money flows done end to end.
 *
 * - {@link pay}: create the payment → sign `signing_request.user_op_hash`
 *   with the session key (EIP-191) → submit → optionally wait for settlement.
 * - {@link createEscrow} / {@link releaseEscrow} / {@link createStream}: the same two-step flow.
 * - {@link fetch}: an x402-aware `fetch` that pays 402 challenges within
 *   policy, signing EIP-3009 authorizations with the spend key.
 *
 * All low-level namespaces of {@link AgentBankClient} are available too.
 *
 * @example
 * ```ts
 * const agent = new AgentClient({
 *   baseUrl: "http://localhost:8080",
 *   accountId: "acct_…",
 *   session: { id: "ses_…", signer: privateKeyToAccount(sessionKey) },
 *   spendKey: privateKeyToAccount(spendKey),
 * });
 * const payment = await agent.pay({ to: "0x…", amount: "2.50", memo: "dataset" }, { waitForSettlement: true });
 * const report = await agent.fetch("https://api.example-data.com/report");
 * ```
 */
export class AgentClient extends AgentBankClient {
  readonly accountId: string;
  readonly #sessionCredentials: SessionCredentials;
  readonly #spendKey: SpendSigner | undefined;
  readonly #x402: AgentX402Options;
  readonly #payer: X402Payer;

  constructor(options: AgentClientOptions) {
    super(options);
    if (!options.accountId?.startsWith("acct_")) {
      throw new InvalidRequestError("invalid_request", "accountId must be an account id (acct_…)");
    }
    this.accountId = options.accountId;
    this.#sessionCredentials = options.session;
    this.#spendKey = options.spendKey;
    this.#x402 = options.x402 ?? {};
    resolveX402Options(this.#x402);
    this.#payer = createAgentBankPayer({
      client: this,
      accountId: this.accountId,
      ...(options.spendKey ? { spendSigner: options.spendKey } : {}),
      ...(this.#x402.mandateId ? { mandateId: this.#x402.mandateId } : {}),
    });
  }

  /** The session key address. */
  get sessionAddress(): string {
    return this.#sessionCredentials.signer.address;
  }

  /** The spend key address, if a spend key is configured. */
  get spendKeyAddress(): string | undefined {
    return this.#spendKey?.address;
  }

  /** The x402 payer backed by this agent's account and spend key (for {@link wrapFetch}). */
  get x402Payer(): X402Payer {
    return this.#payer;
  }

  /** Balances of the agent's account. */
  balance(options?: RequestOptions): Promise<Balances> {
    return this.accounts.balances(this.accountId, options);
  }

  /** Dry-run a payment against the policy: nothing is held or sent. */
  checkSpend(input: CheckSpendInput, options?: RequestOptions): Promise<PolicyDecision> {
    const target = input.to !== undefined ? toPaymentTarget(input.to) : {};
    if (target.account_id) {
      throw new InvalidRequestError(
        "invalid_request",
        "checkSpend takes an address or agent id as counterparty",
      );
    }
    const intent: PaymentIntentInput = {
      kind: input.kind ?? (input.x402Domain ? "x402" : "transfer"),
      amount: { amount: normalizeAmount(input.amount), asset: "USDC" },
      ...(target.address ? { to_address: target.address } : {}),
      ...(target.agent_id ? { to_agent_id: target.agent_id } : {}),
      ...(input.x402Domain ? { x402_domain: input.x402Domain.toLowerCase() } : {}),
      ...(input.mandateId ? { mandate_id: input.mandateId } : {}),
    };
    return this.policies.check({ account_id: this.accountId, intent }, options);
  }

  /**
   * Pay another agent, account or address.
   *
   * Creates the payment (hold + policy), signs `signing_request.user_op_hash`
   * with the session key and submits it; the co-signer re-checks policy and
   * co-signs. Resolves with the payment (`submitted`, or `settled` with
   * `waitForSettlement`; `requires_approval` when a human must approve).
   *
   * @throws {@link PolicyDeniedError} if policy or the co-signer denies it.
   * @throws {@link PaymentFailedError} if it fails on-chain (while waiting).
   */
  async pay(input: PayInput, options: FlowOptions = {}): Promise<Payment> {
    const amount = normalizeAmount(input.amount);
    const to = toPaymentTarget(input.to);
    const payment = await this.payments.create(
      {
        account_id: input.accountId ?? this.accountId,
        amount: { amount, asset: "USDC" },
        to,
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.mandateId ? { mandate_id: input.mandateId } : {}),
        ...(input.paymentRequestId ? { payment_request_id: input.paymentRequestId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      {
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        signal: options.signal,
      },
    );
    assertPaymentMatches(payment, amount, to);
    return this.completePayment(payment, options);
  }

  /**
   * Drive an existing payment to completion: wait for approval if asked,
   * sign and submit when it `requires_signature`, then optionally wait for
   * settlement. Safe to call again on the same payment.
   */
  async completePayment(payment: Payment | string, options: FlowOptions = {}): Promise<Payment> {
    let current = typeof payment === "string" ? await this.payments.retrieve(payment) : payment;
    if (current.status === "requires_approval" && options.waitForApproval) {
      current = await pollUntil(
        () => this.payments.retrieve(current.id),
        (p) => p.status !== "requires_approval",
        options,
      );
    }
    if (current.status === "denied") throw deniedError(current);
    if (current.status === "requires_signature" && current.signing_request) {
      const signature = await this.#signRequest(current.signing_request);
      current = await this.payments.submitSignature(
        current.id,
        { session_id: this.#sessionCredentials.id, signature },
        { idempotencyKey: signatureKey(current.id, current.signing_request), signal: options.signal },
      );
      if (current.status === "denied") throw deniedError(current);
    }
    if (current.status === "failed") throw new PaymentFailedError(current);
    if (
      options.waitForSettlement &&
      !PAYMENT_TERMINAL.has(current.status) &&
      current.status !== "requires_approval"
    ) {
      current = await this.waitForPayment(current.id, options);
    }
    if (current.status === "denied") throw deniedError(current);
    if (current.status === "failed") throw new PaymentFailedError(current);
    return current;
  }

  /** Poll a payment until it settles, fails, is denied, canceled or expires (or the timeout). */
  waitForPayment(paymentId: string, options: WaitOptions = {}): Promise<Payment> {
    return pollUntil(
      () => this.payments.retrieve(paymentId),
      (p) => PAYMENT_TERMINAL.has(p.status),
      options,
    );
  }

  /** Ask another agent or a human to pay this account; share `pay_link`. */
  requestPayment(
    input: { amount: string; memo?: string; reference?: string; expiresInSeconds?: number },
    options?: RequestOptions,
  ): Promise<PaymentRequest> {
    return this.paymentRequests.create(
      {
        account_id: this.accountId,
        amount: { amount: normalizeAmount(input.amount), asset: "USDC" },
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.expiresInSeconds !== undefined ? { expires_in_seconds: input.expiresInSeconds } : {}),
      },
      options,
    );
  }

  /** Payments of this account, newest first (`kind`: transfer, x402, escrow, stream, payout, refill). */
  listTransactions(
    query: { limit?: number; cursor?: string; status?: PaymentStatus } = {},
    options?: RequestOptions,
  ): Promise<Page<Payment>> {
    return this.payments.list({ account_id: this.accountId, ...query }, options);
  }

  /** Ledger entries of this account (deposits included), newest first. */
  listEntries(
    query: { limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<LedgerEntry>> {
    return this.ledger.listEntries(this.accountId, query, options);
  }

  /**
   * Lock funds in escrow for a task: create → sign the pending `lock`
   * operation with the session key → submit; with `waitForSettlement`, wait
   * until it is `locked`.
   */
  async createEscrow(input: CreateEscrowFlowInput, options: FlowOptions = {}): Promise<Escrow> {
    const expiresAt =
      input.expiresAt !== undefined
        ? isoTime(input.expiresAt)
        : new Date(Date.now() + (input.expiresInSeconds ?? 7 * 24 * 3600) * 1000).toISOString();
    const escrow = await this.escrows.create(
      {
        account_id: this.accountId,
        payee: toPayee(input.payee),
        amount: { amount: normalizeAmount(input.amount), asset: "USDC" },
        expires_at: expiresAt,
        ...(input.release ? { release: input.release } : {}),
        ...(input.arbiter ? { arbiter: input.arbiter } : {}),
        ...(input.validator ? { validator: input.validator } : {}),
        ...(input.terms !== undefined ? { terms: input.terms } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.mandateId ? { mandate_id: input.mandateId } : {}),
      },
      createOptions(options),
    );
    return this.#finishEscrow(escrow, "lock", options);
  }

  /** Release escrowed funds to the payee: request the release, then sign the pending `release` operation. */
  async releaseEscrow(escrowId: string, options: FlowOptions = {}): Promise<Escrow> {
    const escrow = await this.escrows.release(escrowId, createOptions(options));
    return this.#finishEscrow(escrow, "release", options);
  }

  /** Refund escrowed funds to the payer (payee anytime, anyone after expiry), signing the pending `refund`. */
  async refundEscrow(escrowId: string, options: FlowOptions = {}): Promise<Escrow> {
    const escrow = await this.escrows.refund(escrowId, createOptions(options));
    return this.#finishEscrow(escrow, "refund", options);
  }

  /** Dispute an escrow before expiry (the arbiter decides), signing the pending `dispute`. */
  async disputeEscrow(escrowId: string, reason: string, options: FlowOptions = {}): Promise<Escrow> {
    const escrow = await this.escrows.dispute(escrowId, { reason }, createOptions(options));
    return this.#finishEscrow(escrow, "dispute", options);
  }

  /**
   * Sign whatever operation an escrow is waiting for (`pending_action` with
   * an unexpired `signing_request`), e.g. after a crash between creating and
   * signing. Escrows with nothing pending are returned as-is.
   */
  async completeEscrow(escrow: Escrow | string, options: FlowOptions = {}): Promise<Escrow> {
    const current = typeof escrow === "string" ? await this.escrows.retrieve(escrow) : escrow;
    return this.#finishEscrow(current, current.pending_action ?? "lock", options);
  }

  /** Start a pre-funded stream or recurring payment: create → sign the pending `create` → submit. */
  async createStream(input: CreateStreamFlowInput, options: FlowOptions = {}): Promise<Stream> {
    const stream = await this.streams.create(
      {
        account_id: this.accountId,
        payee: toPayee(input.payee),
        ...(input.kind ? { kind: input.kind } : {}),
        amount_per_interval: {
          amount: normalizeAmount(input.amountPerInterval, "amountPerInterval"),
          asset: "USDC",
        },
        interval_seconds: input.intervalSeconds,
        deposit: { amount: normalizeAmount(input.deposit, "deposit"), asset: "USDC" },
        ...(input.settleEverySeconds !== undefined ? { settle_every_seconds: input.settleEverySeconds } : {}),
        ...(input.startAt !== undefined ? { start_at: isoTime(input.startAt) } : {}),
        ...(input.stopAt !== undefined ? { stop_at: isoTime(input.stopAt) } : {}),
        ...(input.mandateId ? { mandate_id: input.mandateId } : {}),
      },
      createOptions(options),
    );
    return this.#finishStream(stream, "create", options);
  }

  /** Cancel a stream (settle what has accrued, refund the rest), signing the pending `cancel`. */
  async cancelStream(streamId: string, options: FlowOptions = {}): Promise<Stream> {
    const stream = await this.streams.cancel(streamId, createOptions(options));
    return this.#finishStream(stream, "cancel", options);
  }

  /**
   * Sign whatever operation a stream is waiting for (`create`, `cancel` or
   * a `top_up` started by Agent Bank). Streams with nothing pending are returned as-is.
   */
  async completeStream(stream: Stream | string, options: FlowOptions = {}): Promise<Stream> {
    const current = typeof stream === "string" ? await this.streams.retrieve(stream) : stream;
    return this.#finishStream(current, current.pending_action ?? "create", options);
  }

  /**
   * Wrap any `fetch` (the global one, undici, a proxy-aware fetch, …) so it
   * pays x402 challenges with this agent's account and spend key, under the
   * same `x402` settings as {@link fetch}. Handy for libraries that accept a
   * custom `fetch`.
   *
   * @example
   * ```ts
   * const paidFetch = agent.wrapFetch(fetch);
   * const res = await paidFetch("https://api.example-data.com/report");
   * ```
   */
  wrapFetch(baseFetch: FetchLike = (i, o) => globalThis.fetch(i, o)): FetchLike {
    return wrapFetch(baseFetch, { ...this.#x402, payer: this.#payer });
  }

  /**
   * `fetch` that pays x402 challenges (HTTP 402) within policy: the API
   * checks the challenge against the owner's rules and returns an EIP-3009
   * authorization that the spend key signs. Refuses prices above
   * `x402.maxAmountPerRequest` (default 1.00 USDC) before asking the API.
   * Use {@link readPaymentResponse} on the result for the settlement.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return (await this.fetchWithPayment(input, init)).response;
  }

  /**
   * Like {@link fetch} but returns payment details: whether it paid, how
   * much, the Agent Bank payment and the seller's settlement.
   *
   * @param overrides Per-call settings; `maxAmountPerRequest` may only lower the configured cap.
   */
  async fetchWithPayment(
    input: string | URL | Request,
    init?: RequestInit,
    overrides: { maxAmountPerRequest?: string } = {},
  ): Promise<X402FetchResult> {
    let maxAmount = this.#x402.maxAmountPerRequest;
    if (overrides.maxAmountPerRequest !== undefined) {
      const configured = resolveX402Options(this.#x402).maxAmount;
      const requested = resolveX402Options({
        ...this.#x402,
        maxAmountPerRequest: overrides.maxAmountPerRequest,
      }).maxAmount;
      maxAmount = formatAmount(requested < configured ? requested : configured, USDC_DECIMALS);
    }
    const fetchImpl: FetchLike = this.#x402.fetch ?? ((i, o) => globalThis.fetch(i, o));
    return fetchWithX402(fetchImpl, input, init, {
      ...this.#x402,
      ...(maxAmount !== undefined ? { maxAmountPerRequest: maxAmount } : {}),
      payer: this.#payer,
    });
  }

  async #signRequest(request: SigningRequest): Promise<`0x${string}`> {
    return signOperationHash(this.#sessionCredentials.signer, request.user_op_hash);
  }

  /**
   * Sign the resource's pending operation, if any: only when `pending_action`
   * is set and its `signing_request` has not expired (the API clears
   * `signing_request` after submission, so a signature is never replayed).
   */
  async #signPending<T extends Escrow | Stream>(
    resource: T,
    submit: (body: SubmitSignatureInput, options: RequestOptions) => Promise<T>,
    options: FlowOptions,
  ): Promise<T> {
    if (resource.status === "failed") throw new PaymentFailedError(resource);
    const request = resource.signing_request;
    if (resource.pending_action === null || !request) return resource;
    if (Date.parse(request.expires_at) <= Date.now()) {
      throw new ConflictError(
        "invalid_state",
        `The pending ${resource.pending_action} operation of ${resource.id} expired before it was signed; request it again`,
      );
    }
    const signature = await this.#signRequest(request);
    const next = await submit(
      { session_id: this.#sessionCredentials.id, signature },
      { idempotencyKey: signatureKey(resource.id, request), signal: options.signal },
    );
    if (next.status === "failed") throw new PaymentFailedError(next);
    return next;
  }

  async #finishEscrow(
    escrow: Escrow,
    action: NonNullable<Escrow["pending_action"]>,
    options: FlowOptions,
  ): Promise<Escrow> {
    const id = escrow.id;
    let current = await this.#signPending(
      escrow,
      (body, o) => this.escrows.submitSignature(id, body, o),
      options,
    );
    const done = ESCROW_DONE[action];
    if (options.waitForSettlement && !done.has(current.status)) {
      current = await pollUntil(
        () => this.escrows.retrieve(id),
        (e) => done.has(e.status),
        options,
      );
    }
    if (current.status === "failed") throw new PaymentFailedError(current);
    return current;
  }

  async #finishStream(
    stream: Stream,
    action: NonNullable<Stream["pending_action"]>,
    options: FlowOptions,
  ): Promise<Stream> {
    const id = stream.id;
    let current = await this.#signPending(
      stream,
      (body, o) => this.streams.submitSignature(id, body, o),
      options,
    );
    const done = STREAM_DONE[action];
    if (options.waitForSettlement && !done.has(current.status)) {
      current = await pollUntil(
        () => this.streams.retrieve(id),
        (st) => done.has(st.status),
        options,
      );
    }
    if (current.status === "failed") throw new PaymentFailedError(current);
    return current;
  }
}

/** Transport options for the create/action call of a flow (the caller's idempotency key applies there). */
function createOptions(options: FlowOptions): RequestOptions {
  return {
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** Deterministic idempotency key for submitting the signature of one signing request. */
function signatureKey(resourceId: string, request: SigningRequest): string {
  return `sig_${resourceId}_${request.user_op_hash.slice(2, 18)}`;
}

function deniedError(resource: Payment): PolicyDeniedError {
  const hits = resource.decision?.rule_hits
    .filter((h) => h.effect === "deny")
    .map((h) => `${h.rule}: ${h.detail}`)
    .join("; ");
  return new PolicyDeniedError(
    "policy_denied",
    `Payment ${resource.id} was denied${hits ? ` (${hits})` : resource.failure_reason ? ` (${resource.failure_reason})` : ""}`,
    {},
    { ...(resource.decision ? { decision: resource.decision } : {}), resource },
  );
}

/** Sanity-check that the API created the payment we asked for before signing anything for it. */
function assertPaymentMatches(
  payment: Payment,
  amount: string,
  to: ReturnType<typeof toPaymentTarget>,
): void {
  const problems: string[] = [];
  if (parseAmount(payment.amount.amount, USDC_DECIMALS) !== parseAmount(amount, USDC_DECIMALS)) {
    problems.push(`amount ${payment.amount.amount} != ${amount}`);
  }
  if (to.address && payment.counterparty.address.toLowerCase() !== to.address.toLowerCase()) {
    problems.push("counterparty address differs");
  }
  if (
    to.agent_id &&
    payment.counterparty.agent_id !== null &&
    payment.counterparty.agent_id !== to.agent_id
  ) {
    problems.push("counterparty agent differs");
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      "invalid_request",
      `Refusing to sign payment ${payment.id}: it does not match the request (${problems.join(", ")})`,
    );
  }
}

/** Input of {@link createAgentBankPayer}. */
export interface AgentBankPayerOptions {
  client: AgentBankClient;
  accountId: string;
  /** The spend key that signs EIP-3009 authorizations. */
  spendSigner?: SpendSigner;
  mandateId?: string;
  /** Idempotency keys or other per-call options for `x402.pay`. */
  requestOptions?: RequestOptions;
}

/**
 * An {@link X402Payer} backed by Agent Bank: asks `POST /v1/x402/pay` for an
 * EIP-3009 authorization within policy, checks that it matches the chosen
 * requirement exactly (payee, amount, token, chain, validity), and signs it
 * with the spend key.
 */
export function createAgentBankPayer(options: AgentBankPayerOptions): X402Payer {
  return {
    async pay(context: X402PaymentContext): Promise<{ payload: ExactEvmPayload; payment: Payment }> {
      const signer = options.spendSigner;
      if (!signer) {
        throw new X402Error(
          "spend_key_missing",
          "This agent has no x402 spend key configured (spendKey option)",
        );
      }
      const { requirement } = context;
      const resource = {
        url: context.requestUrl,
        ...(typeof requirement.resource?.description === "string" && requirement.resource.description
          ? { description: requirement.resource.description }
          : {}),
        ...(typeof requirement.resource?.mimeType === "string" && requirement.resource.mimeType
          ? { mimeType: requirement.resource.mimeType }
          : {}),
      };
      const response = await options.client.x402.pay(
        {
          account_id: options.accountId,
          resource,
          requirements: {
            scheme: "exact",
            network: requirement.caip2Network,
            asset: requirement.asset,
            amount: requirement.amount.toString(),
            payTo: requirement.payTo,
            maxTimeoutSeconds: requirement.maxTimeoutSeconds,
            extra: requirement.extra,
          },
          ...(options.mandateId ? { mandate_id: options.mandateId } : {}),
        },
        options.requestOptions,
      );
      const payment = response.payment;
      if (payment.status === "denied") throw deniedError(payment);
      if (payment.status === "requires_approval") {
        throw new X402Error(
          "approval_required",
          "This x402 payment needs human approval, and x402 cannot wait for approvals; ask the owner to adjust the approval threshold",
          { payment },
        );
      }
      if (payment.status !== "requires_signature" || !response.authorization || !response.eip712_domain) {
        throw new X402Error("unexpected_status", `Unexpected x402 payment status "${payment.status}"`, {
          payment,
        });
      }
      assertAuthorizationMatches(response, requirement, signer.address);
      const signature = await signer.signTypedData(
        transferWithAuthorizationTypedData(response.eip712_domain, response.authorization),
      );
      const auth = response.authorization;
      return {
        payload: {
          signature,
          authorization: {
            from: auth.from,
            to: auth.to,
            value: auth.value,
            validAfter: auth.validAfter,
            validBefore: auth.validBefore,
            nonce: auth.nonce,
          },
        },
        payment,
      };
    },
  };
}

/**
 * Defense in depth: never sign an authorization that differs from what the
 * seller asked for, whatever the API returns.
 */
export function assertAuthorizationMatches(
  response: X402PayResponse,
  requirement: SelectedRequirement,
  spendAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): void {
  const auth = response.authorization;
  const domain = response.eip712_domain;
  if (!auth || !domain) {
    throw new X402Error("authorization_mismatch", "Agent Bank returned no authorization to sign");
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const problems: string[] = [];
  if (!same(auth.from, spendAddress)) problems.push("from is not the spend key");
  if (!same(auth.to, requirement.payTo)) problems.push("to differs from payTo");
  if (BigInt(auth.value) !== requirement.amount) problems.push("value differs from the price");
  if (domain.chainId !== requirement.chainId) problems.push("chainId differs from the network");
  if (!same(domain.verifyingContract, requirement.asset))
    problems.push("verifyingContract differs from the asset");
  const { name, version } = requirement.extra;
  if (typeof name === "string" && name !== domain.name) problems.push("EIP-712 name differs");
  if (typeof version === "string" && version !== domain.version) problems.push("EIP-712 version differs");
  const validBefore = BigInt(auth.validBefore);
  if (validBefore <= BigInt(now)) problems.push("authorization already expired");
  if (validBefore > BigInt(now + requirement.maxTimeoutSeconds + 300)) {
    problems.push("validity exceeds maxTimeoutSeconds");
  }
  if (BigInt(auth.validAfter) > BigInt(now + 60)) problems.push("authorization not valid yet");
  if (problems.length > 0) {
    throw new X402Error(
      "authorization_mismatch",
      `Refusing to sign the x402 authorization: ${problems.join("; ")}`,
      {
        payment: response.payment,
      },
    );
  }
}
