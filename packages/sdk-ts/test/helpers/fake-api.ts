import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AgentBankError } from "@agentbank/core";
import {
  applyBps,
  DomainSchema,
  ERROR_CATALOG,
  formatAmount,
  getAsset,
  isErrorCode,
  minBig,
  newId,
  ownerPayloads,
  parseAmount,
  verifyOwnerAuthorization,
  verifyRequest,
  type ErrorCode,
} from "@agentbank/core";
import * as R from "@agentbank/core/api";
import { keccak256, recoverMessageAddress, stringToBytes, toHex, type Address, type Hex } from "viem";
import type { z } from "zod";

/**
 * A small in-process fake of the Agent Bank API (Fastify on an ephemeral
 * port). Agent requests are authenticated exactly like the real API: RFC 9421
 * signatures verified with core's `verifyRequest` over the raw body bytes,
 * with single-use nonces. Owner authorizations are verified with core's
 * `verifyOwnerAuthorization`; operation signatures by recovering the EIP-191
 * signer of the raw `user_op_hash`. Responses conform to the route registry
 * schemas (the tests run the SDK with `validateResponses: true`).
 */

type Payment = z.output<typeof R.Payment>;
type Escrow = z.output<typeof R.Escrow>;
type Stream = z.output<typeof R.Stream>;
type Session = z.output<typeof R.Session>;
type OwnerOperation = z.output<typeof R.OwnerOperation>;
type Account = z.output<typeof R.Account>;
type Decision = NonNullable<Payment["decision"]>;

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  auth: "agent" | "principal" | "none";
}

export interface FakeApiConfig {
  apiKey?: string;
  ownerAddress?: Address;
  /** Agent sessions accepted for request signatures. */
  sessions?: { id: string; address: Address; accountId: string }[];
  /** Accounts known to the API. */
  accounts?: Partial<Account>[];
  /** Payments above this (decimal) are denied by policy. */
  denyAbove?: string;
  /** Payments above this (decimal) require approval. */
  approvalAbove?: string;
  /** GETs of a submitted payment before it settles (default 1). */
  settleAfterPolls?: number;
  /** Make submitted payments fail instead of settling. */
  failOnChain?: boolean;
  /** Spend key address reported for x402 authorizations. */
  spendAddress?: Address;
  /** `owner_authorization_chain_id` served by `GET /v1/meta` (default 84532). */
  ownerAuthorizationChainId?: number;
}

interface Injected {
  status: number;
  problem?: Record<string, unknown>;
  headers?: Record<string, string>;
  match?: (request: RecordedRequest) => boolean;
  /** Drop the connection instead of answering. */
  destroy?: boolean;
}

export interface FakeApi {
  url: string;
  requests: RecordedRequest[];
  payments: Map<string, Payment>;
  escrows: Map<string, Escrow>;
  streams: Map<string, Stream>;
  sessions: Map<string, Session>;
  ownerOperations: Map<string, OwnerOperation>;
  accounts: Map<string, Account>;
  /** Fail the next matching requests with an injected response. */
  inject(failure: Injected, times?: number): void;
  close(): Promise<void>;
}

const NOW = () => new Date().toISOString();
const randomHash = (): Hex => keccak256(stringToBytes(`${Math.random()}-${Date.now()}-${newId("event")}`));

function problem(code: ErrorCode, detail: string, extra: Record<string, unknown> = {}) {
  return {
    type: `urn:agentbank:problem:${code}`,
    title: ERROR_CATALOG[code].title,
    status: ERROR_CATALOG[code].status,
    detail,
    code,
    ...extra,
  };
}

function sendProblem(
  reply: FastifyReply,
  code: ErrorCode,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  return reply
    .code(ERROR_CATALOG[code].status)
    .header("content-type", "application/problem+json")
    .header("x-request-id", `req_${Math.floor(Math.random() * 1e9)}`)
    .send(JSON.stringify(problem(code, detail, extra)));
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: newId("account"),
    object: "account",
    agent_id: newId("agent"),
    org_id: newId("org"),
    role: "agent",
    chain: "base-sepolia",
    chain_id: 84532,
    address: "0x1111111111111111111111111111111111111111",
    deployed: false,
    owner_address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    spend_key_address: null,
    module_versions: {},
    created_at: NOW(),
    ...overrides,
  };
}

function decision(outcome: Decision["outcome"], ruleHits: Decision["rule_hits"] = []): Decision {
  return {
    id: newId("decision"),
    outcome,
    rule_hits: ruleHits,
    approvers_required: outcome === "require_approval" ? 1 : 0,
    policy_version: 1,
    evaluated_at: NOW(),
  };
}

function signingRequest(sessionId: string | null) {
  return {
    session_id: sessionId,
    user_op_hash: randomHash(),
    chain_id: 84532,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function counterparty(to: { address?: string; agent_id?: string; account_id?: string }) {
  return {
    type: to.agent_id ? ("agent" as const) : ("address" as const),
    address: to.address ?? "0x2222222222222222222222222222222222222222",
    agent_id: to.agent_id ?? null,
    x402_domain: null,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    authKind?: "agent" | "principal" | "none";
    sessionId?: string;
  }
}

export async function startFakeApi(config: FakeApiConfig = {}): Promise<FakeApi> {
  const apiKey = config.apiKey ?? "abk_test_fake";
  const ownerAddress = config.ownerAddress ?? "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const settleAfterPolls = config.settleAfterPolls ?? 1;
  const agentSessions = new Map((config.sessions ?? []).map((s) => [s.id, s]));
  const nonces = new Set<string>();
  const idempotency = new Map<string, { body: string; status: number; response: unknown }>();
  const pollCounts = new Map<string, number>();
  const injected: { failure: Injected; remaining: number }[] = [];

  const state: Omit<FakeApi, "url" | "inject" | "close"> = {
    requests: [],
    payments: new Map(),
    escrows: new Map(),
    streams: new Map(),
    sessions: new Map(),
    ownerOperations: new Map(),
    accounts: new Map((config.accounts ?? []).map((a) => [a.id as string, makeAccount(a)])),
  };

  const app = Fastify({ logger: false });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) if (typeof v === "string") headers[k] = v;
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      headers,
      body: "",
      auth: "none",
    };
    state.requests.push(recorded);
    const slot = injected.find((i) => i.remaining > 0 && (!i.failure.match || i.failure.match(recorded)));
    if (slot) {
      slot.remaining -= 1;
      if (slot.failure.destroy) {
        request.raw.socket.destroy();
        return reply;
      }
      reply.code(slot.failure.status);
      for (const [k, v] of Object.entries(slot.failure.headers ?? {})) reply.header(k, v);
      if (slot.failure.problem) {
        reply.header("content-type", "application/problem+json");
        return reply.send(JSON.stringify(slot.failure.problem));
      }
      return reply.send("upstream error");
    }
    return undefined;
  });

  app.addHook("preHandler", async (request, reply) => {
    const recorded = state.requests[state.requests.length - 1];
    if (recorded) recorded.body = request.rawBody ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) if (typeof v === "string") headers[k] = v;
    if (headers["signature-input"]) {
      try {
        const verified = await verifyRequest(
          {
            method: request.method,
            url: `http://${headers.host}${request.url}`,
            headers,
            body: request.rawBody ?? null,
          },
          {
            resolveKey: async (id) => agentSessions.get(id)?.address,
            checkAndStoreNonce: async (keyId, nonce) => {
              const key = `${keyId}:${nonce}`;
              const seen = nonces.has(key);
              nonces.add(key);
              return seen;
            },
          },
        );
        request.authKind = "agent";
        request.sessionId = verified.keyId;
      } catch (error) {
        const e = error as AgentBankError;
        return sendProblem(reply, isErrorCode(e.code) ? e.code : "unauthorized", e.message);
      }
    } else if (headers.authorization === `Bearer ${apiKey}`) {
      request.authKind = "principal";
    } else {
      request.authKind = "none";
    }
    if (recorded) recorded.auth = request.authKind;
    return undefined;
  });

  /** Register a route from the registry with auth, validation and idempotency. */
  function on(
    operationId: keyof typeof R.routes,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
  ) {
    const route = R.routes[operationId] as R.RouteDef;
    const url = route.path.replace(/\{([^}]+)\}/g, ":$1");
    app.route({
      method: route.method,
      url,
      handler: async (request, reply) => {
        const kind = request.authKind ?? "none";
        const allowed =
          route.auth.includes("public") ||
          (kind === "agent" && route.auth.includes("agent")) ||
          (kind === "principal" &&
            (route.auth.includes("principal") ||
              route.auth.includes("approver") ||
              route.auth.includes("seller")));
        if (!allowed)
          return sendProblem(reply, "unauthorized", `${operationId} needs ${route.auth.join(" or ")}`);
        if (route.body) {
          const parsed = route.body.safeParse(request.body ?? {});
          if (!parsed.success)
            return sendProblem(reply, "invalid_request", parsed.error.issues[0]?.message ?? "invalid");
          request.body = parsed.data;
        }
        let idemKey: string | undefined;
        if (route.idempotent) {
          idemKey = request.headers["idempotency-key"] as string | undefined;
          if (!idemKey) return sendProblem(reply, "invalid_request", "Idempotency-Key header is required");
          const previous = idempotency.get(`${operationId}:${idemKey}`);
          if (previous) {
            if (previous.body !== (request.rawBody ?? "")) {
              return sendProblem(
                reply,
                "idempotency_conflict",
                "Idempotency key reused with a different request",
              );
            }
            return reply.code(previous.status).send(previous.response);
          }
        }
        const result = await handler(request, reply);
        if (reply.sent) return reply;
        const status = route.status ?? 200;
        if (idemKey)
          idempotency.set(`${operationId}:${idemKey}`, {
            body: request.rawBody ?? "",
            status,
            response: result,
          });
        return reply.code(status).send(result);
      },
    });
  }

  const params = (request: FastifyRequest) => request.params as { id: string };
  const body = <T>(request: FastifyRequest) => request.body as T;

  const getAccount = (id: string): Account => {
    let account = state.accounts.get(id);
    if (!account) {
      account = makeAccount({ id });
      state.accounts.set(id, account);
    }
    return account;
  };

  on("getAccount", (request, reply) => {
    const account = state.accounts.get(params(request).id);
    if (!account) return sendProblem(reply, "not_found", "No such account");
    return account;
  });

  on("getBalances", (request) => ({
    object: "balances",
    account_id: params(request).id,
    asset: "USDC",
    available: "120.50",
    reserved: "2.00",
    escrow: "10.00",
    fees: "0.10",
    savings: "0.00",
    spend_float: "5.00",
    vaults: [],
    total: "137.60",
    as_of: NOW(),
  }));

  on("checkPolicy", (request) => {
    const input = body<{ intent: { amount: { amount: string } } }>(request);
    const amount = parseAmount(input.intent.amount.amount, 6);
    if (config.denyAbove && amount > parseAmount(config.denyAbove, 6)) {
      return decision("deny", [
        { rule: "limits.per_tx", effect: "deny", detail: `above ${config.denyAbove}` },
      ]);
    }
    return decision("allow", [{ rule: "limits.per_tx", effect: "info", detail: "within limit" }]);
  });

  on("createPayment", (request) => {
    const input = body<z.output<typeof R.CreatePaymentRequest>>(request);
    const minor = parseAmount(input.amount.amount, 6);
    const fee = minBig(applyBps(minor, 20), 5_000_000n);
    let status: Payment["status"] = "requires_signature";
    let dec = decision("allow");
    if (config.denyAbove && minor > parseAmount(config.denyAbove, 6)) {
      status = "denied";
      dec = decision("deny", [
        { rule: "limits.per_tx", effect: "deny", detail: `over ${config.denyAbove} USDC` },
      ]);
    } else if (config.approvalAbove && minor > parseAmount(config.approvalAbove, 6)) {
      status = "requires_approval";
      dec = decision("require_approval", [
        { rule: "approvals", effect: "require_approval", detail: "needs 1 approver" },
      ]);
    }
    const payment: Payment = {
      id: newId("payment"),
      object: "payment",
      account_id: input.account_id,
      kind: "transfer",
      status,
      amount: { amount: formatAmount(minor, 6), asset: "USDC" },
      fee: { amount: formatAmount(fee, 6), asset: "USDC" },
      counterparty: counterparty(input.to),
      memo: input.memo ?? null,
      mandate_id: input.mandate_id ?? null,
      payment_request_id: input.payment_request_id ?? null,
      decision: dec,
      approval_id: status === "requires_approval" ? newId("approval") : null,
      signing_request: status === "requires_signature" ? signingRequest(request.sessionId ?? null) : null,
      owner_operation_id: null,
      user_op_hash: null,
      tx_hash: null,
      failure_reason: null,
      metadata: input.metadata ?? {},
      created_at: NOW(),
      updated_at: NOW(),
      settled_at: null,
    };
    state.payments.set(payment.id, payment);
    return payment;
  });

  on("getPayment", (request, reply) => {
    const payment = state.payments.get(params(request).id);
    if (!payment) return sendProblem(reply, "not_found", "No such payment");
    if (payment.status === "submitted") {
      const polls = (pollCounts.get(payment.id) ?? 0) + 1;
      pollCounts.set(payment.id, polls);
      if (polls >= settleAfterPolls) {
        if (config.failOnChain) {
          payment.status = "failed";
          payment.failure_reason = "user operation reverted";
        } else {
          payment.status = "settled";
          payment.settled_at = NOW();
          payment.tx_hash = randomHash();
        }
        payment.updated_at = NOW();
      }
    }
    return payment;
  });

  on("listPayments", (request) => {
    const query = request.query as { account_id?: string; limit?: string; cursor?: string };
    const all = [...state.payments.values()].filter(
      (p) => !query.account_id || p.account_id === query.account_id,
    );
    const limit = Number(query.limit ?? 50);
    const start = query.cursor ? Number(query.cursor) : 0;
    const data = all.slice(start, start + limit);
    return { data, next_cursor: start + limit < all.length ? String(start + limit) : null };
  });

  async function checkOperationSignature(
    hash: string,
    signature: string,
    expected: Address,
  ): Promise<boolean> {
    try {
      const recovered = await recoverMessageAddress({
        message: { raw: hash as Hex },
        signature: signature as Hex,
      });
      return recovered.toLowerCase() === expected.toLowerCase();
    } catch {
      return false;
    }
  }

  on("submitPaymentSignature", async (request, reply) => {
    const payment = state.payments.get(params(request).id);
    if (!payment) return sendProblem(reply, "not_found", "No such payment");
    if (payment.status !== "requires_signature" || !payment.signing_request) {
      return sendProblem(reply, "invalid_state", `Payment is ${payment.status}`);
    }
    const input = body<{ session_id: string; signature: string }>(request);
    const session = agentSessions.get(input.session_id);
    if (
      !session ||
      !(await checkOperationSignature(payment.signing_request.user_op_hash, input.signature, session.address))
    ) {
      return sendProblem(reply, "signature_invalid", "Session signature does not match user_op_hash");
    }
    payment.user_op_hash = payment.signing_request.user_op_hash;
    payment.signing_request = null;
    payment.status = "submitted";
    payment.updated_at = NOW();
    return payment;
  });

  on("cancelPayment", (request, reply) => {
    const payment = state.payments.get(params(request).id);
    if (!payment) return sendProblem(reply, "not_found", "No such payment");
    payment.status = "canceled";
    return payment;
  });

  on("createPaymentRequest", (request) => {
    const input = body<z.output<typeof R.CreatePaymentRequestRequest>>(request);
    const id = newId("paymentRequest");
    return {
      id,
      object: "payment_request",
      account_id: input.account_id,
      pay_to: getAccount(input.account_id).address,
      amount: input.amount,
      memo: input.memo ?? null,
      reference: input.reference ?? null,
      status: "open",
      pay_link: `http://localhost:8080/pay/${id}`,
      paid_by_payment_id: null,
      expires_at: new Date(Date.now() + (input.expires_in_seconds ?? 604800) * 1000).toISOString(),
      created_at: NOW(),
    };
  });

  on("x402Pay", (request) => {
    const input = body<z.output<typeof R.X402PayRequest>>(request);
    const minor = BigInt(input.requirements.amount);
    const status: Payment["status"] =
      config.denyAbove && minor > parseAmount(config.denyAbove, 6) ? "denied" : "requires_signature";
    const payment: Payment = {
      id: newId("payment"),
      object: "payment",
      account_id: input.account_id,
      kind: "x402",
      status,
      amount: { amount: formatAmount(minor, 6), asset: "USDC" },
      fee: { amount: "0.00", asset: "USDC" },
      counterparty: {
        type: "x402",
        address: input.requirements.payTo,
        agent_id: null,
        // IP-literal hosts have no domain for policy matching.
        x402_domain: DomainSchema.safeParse(new URL(input.resource.url).hostname).success
          ? new URL(input.resource.url).hostname
          : null,
      },
      memo: null,
      mandate_id: input.mandate_id ?? null,
      payment_request_id: null,
      decision:
        status === "denied"
          ? decision("deny", [{ rule: "limits.per_tx", effect: "deny", detail: "too much" }])
          : decision("allow"),
      approval_id: null,
      signing_request: null,
      owner_operation_id: null,
      user_op_hash: null,
      tx_hash: null,
      failure_reason: null,
      metadata: {},
      created_at: NOW(),
      updated_at: NOW(),
      settled_at: null,
    };
    state.payments.set(payment.id, payment);
    const chainId = Number(input.requirements.network.split(":")[1]);
    const asset = getAsset(chainId, "USDC");
    const spend = config.spendAddress ?? getAccount(input.account_id).spend_key_address;
    const ok = status === "requires_signature" && spend;
    return {
      object: "x402_authorization",
      payment,
      authorization: ok
        ? {
            from: spend,
            to: input.requirements.payTo,
            value: input.requirements.amount,
            validAfter: "0",
            validBefore: String(Math.floor(Date.now() / 1000) + input.requirements.maxTimeoutSeconds),
            nonce: keccak256(toHex(payment.id)),
          }
        : null,
      eip712_domain: ok
        ? {
            name: asset.eip712.name,
            version: asset.eip712.version,
            chainId,
            verifyingContract: asset.address,
          }
        : null,
    };
  });

  const ownerChainId = config.ownerAuthorizationChainId ?? 84532;

  on("getMeta", () => ({
    object: "meta",
    api_version: "0.1.0",
    chain: ownerChainId === 1337 ? "simulated" : ownerChainId === 31337 ? "anvil" : "base-sepolia",
    chain_id: ownerChainId,
    caip2: `eip155:${ownerChainId}`,
    owner_authorization_chain_id: ownerChainId,
    usdc: {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      eip712_name: "USDC",
      eip712_version: "2",
    },
    contracts: {},
    cosigner_address: null,
    revenue_address: null,
    facilitator_url: null,
    features: {},
  }));

  /**
   * Verify an owner authorization over core's canonical payload (the parsed
   * body without `owner_authorization`), with the meta chain id, as the API does.
   */
  async function checkOwner(
    reply: FastifyReply,
    oa: { signer: string; signature: string; issued_at: number; expires_at: number },
    expected: {
      action: Parameters<typeof verifyOwnerAuthorization>[0]["action"];
      subject: string;
      payload: unknown;
    },
  ): Promise<FastifyReply | undefined> {
    try {
      await verifyOwnerAuthorization({
        chainId: ownerChainId,
        ...expected,
        issuedAt: oa.issued_at,
        expiresAt: oa.expires_at,
        owner: ownerAddress,
        signer: oa.signer as Address,
        signature: oa.signature as Hex,
      });
      return undefined;
    } catch (error) {
      const e = error as AgentBankError;
      return sendProblem(reply, e.code, e.message);
    }
  }

  on("createSession", async (request, reply) => {
    const input = body<z.output<typeof R.CreateSessionRequest>>(request);
    const { owner_authorization: oa, ...rest } = input;
    const denied = await checkOwner(reply, oa, ownerPayloads.sessionGrant(rest));
    if (denied) return denied;
    const session: Session = {
      id: newId("session"),
      object: "session",
      account_id: input.account_id,
      public_key: input.public_key,
      scope: input.scope,
      status: "pending_install",
      expires_at: input.scope.expires_at,
      revoked_at: null,
      onchain_tx: null,
      install_operation_id: null,
      created_at: NOW(),
    };
    state.sessions.set(session.id, session);
    return session;
  });

  on("installSession", (request, reply) => {
    const session = state.sessions.get(params(request).id);
    if (!session) return sendProblem(reply, "not_found", "No such session");
    const op: OwnerOperation = {
      id: newId("ownerOperation"),
      object: "owner_operation",
      account_id: session.account_id,
      purpose: "session.install",
      subject_id: session.id,
      status: "requires_signature",
      user_op_hash: randomHash(),
      chain_id: 84532,
      tx_hash: null,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      created_at: NOW(),
    };
    state.ownerOperations.set(op.id, op);
    session.install_operation_id = op.id;
    return session;
  });

  on("getSession", (request, reply) => {
    const session = state.sessions.get(params(request).id);
    if (!session) return sendProblem(reply, "not_found", "No such session");
    return session;
  });

  on("getOwnerOperation", (request, reply) => {
    const op = state.ownerOperations.get(params(request).id);
    if (!op) return sendProblem(reply, "not_found", "No such owner operation");
    if (op.status === "submitted") {
      op.status = "succeeded";
      op.tx_hash = randomHash();
      const session = [...state.sessions.values()].find((s) => s.install_operation_id === op.id);
      if (session) {
        session.status = "active";
        session.onchain_tx = op.tx_hash;
      }
    }
    return op;
  });

  on("submitOwnerSignature", async (request, reply) => {
    const op = state.ownerOperations.get(params(request).id);
    if (!op) return sendProblem(reply, "not_found", "No such owner operation");
    if (op.status !== "requires_signature")
      return sendProblem(reply, "invalid_state", `Operation is ${op.status}`);
    const { signature } = body<{ signature: string }>(request);
    if (!(await checkOperationSignature(op.user_op_hash, signature, ownerAddress))) {
      return sendProblem(reply, "owner_signature_required", "Not signed by the owner key");
    }
    op.status = "submitted";
    return op;
  });

  on("putPolicy", async (request, reply) => {
    const { id } = params(request);
    const input = body<z.output<typeof R.PutPolicyRequest>>(request);
    const oa = input.owner_authorization;
    if (oa) {
      const denied = await checkOwner(reply, oa, ownerPayloads.policyLoosen(id, input.policy));
      if (denied) return denied;
    }
    const version = {
      id: newId("policy"),
      object: "policy",
      agent_id: id,
      version: 2,
      rules: input.policy,
      change_kind: oa ? "loosen" : "tighten",
      effective_at: NOW(),
      signed_by: oa ? oa.signer : null,
      created_at: NOW(),
    };
    return { object: "agent_policy", agent_id: id, current: version, pending: null };
  });

  on("unfreezeAgent", async (request, reply) => {
    const { id } = params(request);
    const input = body<z.output<typeof R.UnfreezeRequest>>(request);
    const denied = await checkOwner(
      reply,
      input.owner_authorization,
      ownerPayloads.agentUnfreeze(id, input.reason),
    );
    if (denied) return denied;
    return {
      id,
      object: "agent",
      org_id: newId("org"),
      name: "research-bot",
      description: null,
      did: null,
      erc8004_id: null,
      agent_card_url: null,
      status: "frozen",
      frozen_reason: "investigating",
      pending_unfreeze_at: new Date(Date.now() + 3600_000).toISOString(),
      metadata: {},
      created_at: NOW(),
    };
  });

  on("putAutoTopUp", async (request, reply) => {
    const { id } = params(request);
    const input = body<z.output<typeof R.PutAutoTopUpRequest>>(request);
    const { owner_authorization: oa, ...rule } = input;
    const denied = await checkOwner(reply, oa, ownerPayloads.topUpSet(id, rule));
    if (denied) return denied;
    return {
      id: newId("topUpRule"),
      object: "auto_topup_rule",
      agent_id: id,
      treasury_account_id: newId("account"),
      ...rule,
      status: "active",
      created_at: NOW(),
    };
  });

  const makeEscrow = (input: z.output<typeof R.CreateEscrowRequest>): Escrow => {
    const minor = parseAmount(input.amount.amount, 6);
    const fee = applyBps(minor, 100) < 1_000_000n ? 1_000_000n : applyBps(minor, 100);
    return {
      id: newId("escrow"),
      object: "escrow",
      payer_account_id: input.account_id,
      payee: counterparty(input.payee),
      amount: input.amount,
      fee: { amount: formatAmount(fee, 6), asset: "USDC" },
      status: "requires_signature",
      release: input.release,
      arbiter: input.arbiter ?? null,
      validator: input.validator ?? null,
      terms_hash: input.terms ? keccak256(toHex(input.terms)) : null,
      contract_address: "0x5555555555555555555555555555555555555555",
      onchain_id: null,
      expires_at: input.expires_at,
      pending_action: "lock",
      signing_request: signingRequest(null),
      memo: input.memo ?? null,
      created_at: NOW(),
      updated_at: NOW(),
    };
  };

  on("createEscrow", (request) => {
    const escrow = makeEscrow(body(request));
    state.escrows.set(escrow.id, escrow);
    return escrow;
  });

  on("getEscrow", (request, reply) => {
    const escrow = state.escrows.get(params(request).id);
    if (!escrow) return sendProblem(reply, "not_found", "No such escrow");
    if (escrow.status === "locking") {
      escrow.status = "locked";
      escrow.onchain_id = "1";
    }
    return escrow;
  });

  async function submitResourceSignature<
    T extends { signing_request: Escrow["signing_request"]; pending_action: string | null },
  >(request: FastifyRequest, reply: FastifyReply, resource: T | undefined): Promise<T | FastifyReply> {
    if (!resource) return sendProblem(reply, "not_found", "Not found");
    if (!resource.signing_request || resource.pending_action === null) {
      return sendProblem(reply, "invalid_state", "Nothing to sign");
    }
    const input = body<{ session_id: string; signature: string }>(request);
    const session = agentSessions.get(input.session_id);
    if (
      !session ||
      !(await checkOperationSignature(
        resource.signing_request.user_op_hash,
        input.signature,
        session.address,
      ))
    ) {
      return sendProblem(reply, "signature_invalid", "Session signature does not match user_op_hash");
    }
    resource.signing_request = null;
    return resource;
  }

  on("submitEscrowSignature", async (request, reply) => {
    const escrow = state.escrows.get(params(request).id);
    const action = escrow?.pending_action;
    const result = await submitResourceSignature(request, reply, escrow);
    if (escrow && result === escrow) {
      if (action === "lock") escrow.status = "locking";
      if (action === "release") escrow.status = "released";
      escrow.pending_action = null;
    }
    return result;
  });

  on("releaseEscrow", (request, reply) => {
    const escrow = state.escrows.get(params(request).id);
    if (!escrow) return sendProblem(reply, "not_found", "No such escrow");
    if (escrow.status !== "locked") return sendProblem(reply, "invalid_state", `Escrow is ${escrow.status}`);
    escrow.pending_action = "release";
    escrow.signing_request = signingRequest(null);
    return escrow;
  });

  on("createStream", (request) => {
    const input = body<z.output<typeof R.CreateStreamRequest>>(request);
    const stream: Stream = {
      id: newId("stream"),
      object: "stream",
      payer_account_id: input.account_id,
      payee: counterparty(input.payee),
      kind: input.kind,
      amount_per_interval: input.amount_per_interval,
      interval_seconds: input.interval_seconds,
      deposit: input.deposit,
      settled: { amount: "0.00", asset: "USDC" },
      settle_every_seconds: input.settle_every_seconds,
      start_at: input.start_at ?? NOW(),
      stop_at: input.stop_at ?? null,
      status: "requires_signature",
      contract_address: "0x6666666666666666666666666666666666666666",
      onchain_id: null,
      pending_action: "create",
      signing_request: signingRequest(null),
      created_at: NOW(),
    };
    state.streams.set(stream.id, stream);
    return stream;
  });

  on("submitStreamSignature", async (request, reply) => {
    const stream = state.streams.get(params(request).id);
    const result = await submitResourceSignature(request, reply, stream);
    if (stream && result === stream) {
      stream.status = "active";
      stream.pending_action = null;
    }
    return result;
  });

  on("getStream", (request, reply) => {
    const stream = state.streams.get(params(request).id);
    if (!stream) return sendProblem(reply, "not_found", "No such stream");
    return stream;
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    ...state,
    url: `http://127.0.0.1:${port}`,
    inject(failure, times = 1) {
      injected.push({ failure, remaining: times });
    },
    async close() {
      await app.close();
    },
  };
}

export { problem };
