import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AgentBankError } from "@agentbank/core";
import {
  applyBps,
  CHAINS,
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
import { loadManifest } from "@agentbank/proofs/artifacts";
import { fromBytes32, isFieldElement, scopeTagOf } from "@agentbank/proofs/field";
import {
  ATTRIBUTES,
  CLAIMS_SCHEMA,
  CLASS_ATTRIBUTES,
  DISCLOSURE_CLASSES,
  disclosureMask,
  FULL_DISCLOSURE_MASK,
  type Attribute,
  type DisclosureClass,
} from "@agentbank/proofs/schema";
import { buildWitness, ClaimsTree, leafHash } from "@agentbank/proofs/tree";
import { rootInfoFromApi, VERIFICATION_KEY, verifyPresentation } from "@agentbank/proofs/verifier";
import {
  getAddress,
  keccak256,
  recoverMessageAddress,
  recoverTypedDataAddress,
  stringToBytes,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
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
type Vault = z.output<typeof R.Vault>;
type ProofSettings = z.output<typeof R.ProofSettings>;
type ProofIdentity = z.output<typeof R.ProofIdentity>;
type ProofReservation = z.output<typeof R.ProofReservation>;
type ProofRoot = z.output<typeof R.ProofRoot>;

/** Attested values of every account's base leaf unless overridden (a verified company, $1,250). */
export const FAKE_PROOF_ATTRIBUTES: Readonly<Record<Attribute, bigint>> = {
  principal_verification: 2n,
  per_tx_limit: 25_000_000n,
  per_day_limit: 200_000_000n,
  balance: 1_250_000_000n,
  reserved_amount: 0n,
  reserved_until: 0n,
  reserved_for: 0n,
  account_created_on: 1_749_945_600n,
  payments_settled: 42n,
  volume_settled: 1_337_000_000n,
  escrows_completed: 3n,
  disputes_lost: 0n,
  counterparties: 7n,
};

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
  /** Vaults known to the API. */
  vaults?: Partial<Vault>[];
  /** Make the early-withdrawal challenge lie about one field (to test the SDK refuses to sign). */
  tamperEarlyWithdrawal?: "contract" | "amount" | "chain" | "deadline" | "domain" | "vault";
  /** Private proofs. */
  proofs?: {
    /** Attested values of the base leaf (default {@link FAKE_PROOF_ATTRIBUTES}). */
    attributes?: Partial<Record<Attribute, bigint>>;
    /** Settings of agents never configured (default: disabled, nothing disclosed). */
    defaultSettings?: { enabled: boolean; disclose: DisclosureClass[] };
    /** Other agents' leaves in every tree (default 20, so the anonymity set is at least 16). */
    otherLeaves?: number;
    /** Status of new reservations (default `active`: in a root at once). */
    reservationStatus?: "pending" | "active";
  };
}

/** Address of the fake deployment's TimeLockVaults contract (`meta.contracts.vaults`). */
export const FAKE_VAULTS_CONTRACT = "0x4444444444444444444444444444444444444444";

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
  proofSettings: Map<string, ProofSettings>;
  proofIdentities: Map<string, ProofIdentity>;
  proofReservations: Map<string, ProofReservation>;
  /** Published roots by lowercase hex (every witness served registers its root). */
  proofRoots: Map<string, ProofRoot>;
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
    spend_key_permit: "none",
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
    proofSettings: new Map(),
    proofIdentities: new Map(),
    proofReservations: new Map(),
    proofRoots: new Map(),
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
      escrow_id: null,
      stream_id: null,
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
      escrow_id: null,
      stream_id: null,
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
  let usdcAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  try {
    usdcAddress = getAsset(ownerChainId, "USDC").address;
  } catch {
    // unknown or locked chain: keep the Base Sepolia address
  }

  on("getMeta", () => ({
    object: "meta",
    api_version: "0.1.0",
    chain: ownerChainId === 1337 ? "simulated" : ownerChainId === 31337 ? "anvil" : "base-sepolia",
    chain_id: ownerChainId,
    caip2: `eip155:${ownerChainId}`,
    owner_authorization_chain_id: ownerChainId,
    usdc: {
      address: usdcAddress,
      decimals: 6,
      eip712_name: "USDC",
      eip712_version: "2",
    },
    contracts: { vaults: FAKE_VAULTS_CONTRACT },
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

  on("createAccount", (request) => {
    const input = body<z.output<typeof R.CreateAccountRequest>>(request);
    const account = makeAccount({
      agent_id: params(request).id,
      chain: input.chain,
      chain_id: CHAINS[input.chain].id,
      address: getAddress(keccak256(toHex(`account:${params(request).id}`)).slice(0, 42)),
      owner_address: ownerAddress,
      spend_key_address: input.spend_key_address ?? null,
    });
    state.accounts.set(account.id, account);
    return account;
  });

  on("attachSpendKey", async (request, reply) => {
    const account = state.accounts.get(params(request).id);
    if (!account) return sendProblem(reply, "not_found", "No such account");
    const input = body<z.output<typeof R.AttachSpendKeyRequest>>(request);
    // Independent EIP-2612 check, as USDC's permit() would do it.
    const valid = await verifyTypedData({
      address: input.spend_key_address as Address,
      domain: {
        name: "USDC",
        version: "2",
        chainId: account.chain_id,
        verifyingContract: usdcAddress as Address,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: input.spend_key_address as Address,
        spender: account.address as Address,
        value: BigInt(input.permit.value),
        nonce: BigInt(input.permit.nonce),
        deadline: BigInt(input.permit.deadline),
      },
      signature: input.permit.signature as Hex,
    }).catch(() => false);
    if (!valid) return sendProblem(reply, "signature_invalid", "Spend key permit does not verify");
    const denied = await checkOwner(
      reply,
      input.owner_authorization,
      ownerPayloads.spendKeySet(account.id, input.spend_key_address),
    );
    if (denied) return denied;
    account.spend_key_address = input.spend_key_address;
    account.spend_key_permit = "pending";
    return account;
  });

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
      revoke_operation_id: null,
      created_at: NOW(),
    };
    state.sessions.set(session.id, session);
    return session;
  });

  const ORG_ID = newId("org");
  const topUpRules = new Map<string, z.output<typeof R.AutoTopUpRule>>();

  function ownerOperation(
    accountId: string,
    purpose: OwnerOperation["purpose"],
    subjectId: string,
  ): OwnerOperation {
    const op: OwnerOperation = {
      id: newId("ownerOperation"),
      object: "owner_operation",
      account_id: accountId,
      purpose,
      subject_id: subjectId,
      status: "requires_signature",
      user_op_hash: randomHash(),
      chain_id: ownerChainId,
      tx_hash: null,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      created_at: NOW(),
    };
    state.ownerOperations.set(op.id, op);
    return op;
  }

  const org = () => ({
    id: ORG_ID,
    object: "org",
    legal_name: "Example Research Ltd",
    kind: "company",
    country: "GB",
    kyc_status: "approved",
    tier: "pro",
    status: "active",
    frozen_reason: null,
    pending_unfreeze_at: null,
    owner_address: ownerAddress,
    treasury_account_id: null,
    created_at: NOW(),
  });

  on("getCurrentOrg", () => org());

  on("rotateOwner", async (request, reply) => {
    const input = body<z.output<typeof R.RotateOwnerRequest>>(request);
    const denied = await checkOwner(
      reply,
      input.owner_authorization,
      ownerPayloads.ownerRotate(ORG_ID, input.new_owner_address),
    );
    if (denied) return denied;
    return { ...org(), owner_address: input.new_owner_address };
  });

  on("prepareOwnerSwap", (request) => {
    const { id } = params(request);
    return ownerOperation(id, "owner.swap", id);
  });

  on("revokeSession", (request, reply) => {
    const session = state.sessions.get(params(request).id);
    if (!session) return sendProblem(reply, "not_found", "No such session");
    session.status = "revoked";
    session.revoked_at = NOW();
    session.revoke_operation_id = ownerOperation(session.account_id, "session.revoke", session.id).id;
    return session;
  });

  on("getAutoTopUp", (request) => topUpRules.get(params(request).id) ?? null);

  const vaults = new Map<string, Vault>(
    (config.vaults ?? []).map((v) => {
      const vault: Vault = {
        id: newId("vault"),
        object: "vault",
        account_id: newId("account"),
        kind: "locked",
        name: "Rainy day",
        target: null,
        unlock_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        balance: { amount: "100.00", asset: "USDC" },
        contract_address: FAKE_VAULTS_CONTRACT,
        onchain_id: "7",
        pending_operation_id: null,
        created_at: NOW(),
        ...v,
      };
      return [vault.id, vault];
    }),
  );
  const EARLY_WITHDRAWAL_TYPES = {
    EarlyWithdrawal: [
      { name: "vaultId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  } as const;

  on("getVault", (request, reply) => {
    const vault = vaults.get(params(request).id);
    if (!vault) return sendProblem(reply, "not_found", "No such vault");
    return vault;
  });

  // Mirrors apps/api withdrawVault: goal and unlocked vaults need nothing; an early withdrawal
  // is a challenge–response over TimeLockVaults' EIP-712 EarlyWithdrawal, then an owner operation.
  on("withdrawVault", async (request, reply) => {
    const vault = vaults.get(params(request).id);
    if (!vault) return sendProblem(reply, "not_found", "No such vault");
    const input = body<z.output<typeof R.VaultTransferRequest>>(request);
    const amount = parseAmount(input.amount.amount, 6);
    if (vault.kind === "goal") return vault;
    if (vault.unlock_at && Date.now() >= Date.parse(vault.unlock_at)) return vault;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(input.owner_authorization?.expires_at ?? now + 900);
    const typedData = {
      domain: {
        name: "AgentBank TimeLockVaults",
        version: "1",
        chainId: ownerChainId,
        verifyingContract: getAddress(vault.contract_address as string),
      },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal" as const,
      message: { vaultId: BigInt(vault.onchain_id as string), amount, nonce: 0n, deadline },
    };
    const tamper = config.tamperEarlyWithdrawal;
    const describe = {
      domain: {
        ...typedData.domain,
        ...(tamper === "contract" ? { verifyingContract: "0x9999999999999999999999999999999999999999" } : {}),
        ...(tamper === "chain" ? { chainId: 11155111 } : {}),
        ...(tamper === "domain" ? { name: "Totally Legit Vaults" } : {}),
      },
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        vaultId: tamper === "vault" ? "8" : typedData.message.vaultId.toString(),
        amount: tamper === "amount" ? (amount * 10n).toString() : amount.toString(),
        nonce: "0",
        deadline: tamper === "deadline" ? String(now + 30 * 86_400) : deadline.toString(),
      },
    };
    const oa = input.owner_authorization;
    if (!oa) {
      return sendProblem(reply, "owner_signature_required", "Sign the EarlyWithdrawal typed_data", {
        typed_data: describe,
      });
    }
    let signer: string;
    try {
      signer = await recoverTypedDataAddress({ ...typedData, signature: oa.signature as Hex });
    } catch {
      return sendProblem(reply, "signature_invalid", "Unrecoverable early-withdrawal signature");
    }
    if (signer.toLowerCase() !== ownerAddress.toLowerCase()) {
      return sendProblem(reply, "owner_signature_required", "Not the owner key", { typed_data: describe });
    }
    if (deadline <= BigInt(now)) return sendProblem(reply, "signature_invalid", "Deadline passed");
    vault.pending_operation_id = ownerOperation(vault.account_id, "vault.withdraw", vault.id).id;
    return vault;
  });

  on("installSession", (request, reply) => {
    const session = state.sessions.get(params(request).id);
    if (!session) return sendProblem(reply, "not_found", "No such session");
    session.install_operation_id = ownerOperation(session.account_id, "session.install", session.id).id;
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
      const account = state.accounts.get(op.account_id);
      if (account?.spend_key_permit === "pending") account.spend_key_permit = "executed";
      for (const rule of topUpRules.values()) {
        if (rule.install_operation_id === op.id) rule.status = "active";
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
    const treasury = newId("account");
    const created: z.output<typeof R.AutoTopUpRule> = {
      id: newId("topUpRule"),
      object: "auto_topup_rule",
      agent_id: id,
      treasury_account_id: treasury,
      ...rule,
      status: "pending_install",
      install_operation_id: ownerOperation(treasury, "topup.configure", id).id,
      created_at: NOW(),
    };
    topUpRules.set(id, created);
    return created;
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

  // ------------------------------------------------------------ private proofs
  // Every witness is served from a real depth-20 Poseidon tree (the account's base leaf, its
  // active reservations' leaves, then other agents), and its root is registered as published,
  // so proofs made from it verify against GET /v1/proofs/roots/{root}.

  const proofDefaults = config.proofs?.defaultSettings ?? { enabled: false, disclose: [] };
  const settingsOf = (agentId: string): ProofSettings =>
    state.proofSettings.get(agentId) ?? {
      object: "proof_settings",
      agent_id: agentId,
      enabled: proofDefaults.enabled,
      disclose: DISCLOSURE_CLASSES.filter((c) => proofDefaults.disclose.includes(c)),
      disclosure_mask: disclosureMask(proofDefaults.disclose),
      updated_at: null,
    };
  let epoch = 0n;
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

  on("getProofCircuit", () => {
    const manifest = loadManifest();
    return {
      object: "proof_circuit",
      schema: CLAIMS_SCHEMA,
      protocol: "groth16",
      curve: "bn128",
      tree_depth: 20,
      attributes: [...ATTRIBUTES],
      disclosure_classes: CLASS_ATTRIBUTES,
      public_signals: manifest.public_signals,
      constraints: manifest.constraints,
      verification_key: VERIFICATION_KEY,
      sha256: manifest.sha256,
      chain_id: 84532,
      registry: null,
      verifier: null,
    };
  });

  on("listProofRoots", (request) => {
    const query = request.query as { status?: string };
    const data = [...state.proofRoots.values()]
      .filter((r) => !query.status || r.status === query.status)
      .reverse();
    return { data, next_cursor: null };
  });

  on("getProofRoot", (request, reply) => {
    const root = state.proofRoots.get((request.params as { root: string }).root.toLowerCase());
    if (!root) return sendProblem(reply, "not_found", "No such root");
    return root;
  });

  on("verifyProof", async (request) => {
    const input = body<z.output<typeof R.VerifyProofRequest>>(request);
    const result = await verifyPresentation({
      request: input.request,
      presentation: input.presentation,
      rootResolver: async ({ root }) => {
        const record = state.proofRoots.get(root.toLowerCase());
        return record ? rootInfoFromApi(record) : null;
      },
    });
    return {
      object: "proof_verification",
      valid: result.valid,
      reason: result.reason,
      nullifier: result.nullifier,
      root: result.root,
      root_status: result.root ? (state.proofRoots.get(result.root)?.status ?? null) : null,
    };
  });

  on("getProofSettings", (request) => settingsOf(params(request).id));

  on("updateProofSettings", async (request, reply) => {
    const { id } = params(request);
    const input = body<z.output<typeof R.UpdateProofSettingsRequest>>(request);
    const current = settingsOf(id);
    const disclose = DISCLOSURE_CLASSES.filter((c) => input.disclose.includes(c));
    const widens = (input.enabled && !current.enabled) || disclose.some((c) => !current.disclose.includes(c));
    if (input.owner_authorization) {
      const denied = await checkOwner(
        reply,
        input.owner_authorization,
        ownerPayloads.proofsDisclose(id, { enabled: input.enabled, disclose }),
      );
      if (denied) return denied;
    } else if (widens) {
      return sendProblem(reply, "owner_signature_required", "Widening disclosure needs proofs.disclose");
    }
    const next: ProofSettings = {
      object: "proof_settings",
      agent_id: id,
      enabled: input.enabled,
      disclose,
      disclosure_mask: disclosureMask(disclose),
      updated_at: NOW(),
    };
    state.proofSettings.set(id, next);
    return next;
  });

  on("enrollProofIdentity", (request, reply) => {
    const { id } = params(request);
    const input = body<z.output<typeof R.EnrollProofIdentityRequest>>(request);
    const commitment = fromBytes32(input.identity_commitment);
    if (commitment === 0n || !isFieldElement(commitment)) {
      return sendProblem(reply, "invalid_request", "identity_commitment must be a non-zero field element");
    }
    const previous = state.proofIdentities.get(id);
    const identity: ProofIdentity = {
      object: "proof_identity",
      account_id: id,
      identity_commitment: input.identity_commitment.toLowerCase(),
      created_at: previous?.created_at ?? NOW(),
      updated_at: NOW(),
    };
    state.proofIdentities.set(id, identity);
    return identity;
  });

  on("getProofIdentity", (request, reply) => {
    const identity = state.proofIdentities.get(params(request).id);
    if (!identity) return sendProblem(reply, "not_found", "No identity enrolled");
    return identity;
  });

  on("getProofWitness", (request, reply) => {
    const { id } = params(request);
    const query = request.query as { reservation_id?: string };
    const identity = state.proofIdentities.get(id);
    if (!identity) {
      return sendProblem(reply, "not_found", "Enroll an identity commitment first", {
        reason: "not_enrolled",
      });
    }
    const settings = settingsOf(getAccount(id).agent_id ?? "");
    if (!settings.enabled)
      return sendProblem(reply, "invalid_state", "Proofs are not enabled for this agent");
    const base = { ...FAKE_PROOF_ATTRIBUTES, ...config.proofs?.attributes };
    const reservations = [...state.proofReservations.values()]
      .filter((r) => r.account_id === id && r.status === "active")
      .sort((a, b) => a.id.localeCompare(b.id));
    const entries = [
      { attributes: base, reservationId: null as string | null },
      ...reservations.map((r) => ({
        attributes: {
          ...base,
          reserved_amount: parseAmount(r.amount.amount, 6),
          reserved_until: BigInt(Math.floor(Date.parse(r.expires_at) / 1000)),
          reserved_for: BigInt(r.scope_tag),
        },
        reservationId: r.id as string | null,
      })),
    ];
    const index = query.reservation_id
      ? entries.findIndex((e) => e.reservationId === query.reservation_id)
      : 0;
    const entry = entries[index];
    if (!entry) return sendProblem(reply, "not_found", "No active reservation with that id");
    const commitment = fromBytes32(identity.identity_commitment);
    const leaves = entries.map((e) => leafHash(commitment, e.attributes, settings.disclosure_mask));
    for (let i = 0; i < (config.proofs?.otherLeaves ?? 20); i++) {
      leaves.push(
        leafHash(BigInt(1_000 + i), { ...base, payments_settled: BigInt(i) }, FULL_DISCLOSURE_MASK),
      );
    }
    const tree = new ClaimsTree(leaves);
    const rootHex = `0x${tree.root.toString(16).padStart(64, "0")}`;
    let record = state.proofRoots.get(rootHex);
    if (!record) {
      epoch += 1n;
      const snapshotAt = Math.floor(Date.now() / 1000) - 30;
      record = {
        object: "proof_root",
        root: rootHex,
        epoch: epoch.toString(),
        snapshot_at: iso(snapshotAt),
        published_at: iso(snapshotAt + 12),
        valid_until: iso(snapshotAt + 7_200),
        leaf_count: tree.size,
        status: "published",
        tx_hash: randomHash(),
        chain_id: 84532,
        registry: null,
      };
      state.proofRoots.set(rootHex, record);
    }
    return buildWitness({
      tree,
      index,
      attributes: entry.attributes,
      disclosureMask: settings.disclosure_mask,
      accountId: id,
      chainId: 84532,
      registry: null,
      epoch: BigInt(record.epoch),
      snapshotAt: Math.floor(Date.parse(record.snapshot_at) / 1000),
      validUntil: Math.floor(Date.parse(record.valid_until) / 1000),
      reservationId: entry.reservationId,
    });
  });

  on("createProofReservation", (request, reply) => {
    const { id } = params(request);
    const input = body<z.output<typeof R.CreateProofReservationRequest>>(request);
    const expires = Date.parse(input.expires_at);
    if (expires <= Date.now() || expires > Date.now() + 7 * 86_400_000 + 60_000) {
      return sendProblem(
        reply,
        "invalid_request",
        "expires_at must be in the future and at most 7 days ahead",
      );
    }
    const status = config.proofs?.reservationStatus ?? "active";
    const reservation: ProofReservation = {
      id: newId("proofReservation"),
      object: "proof_reservation",
      account_id: id,
      agent_id: getAccount(id).agent_id ?? newId("agent"),
      amount: input.amount,
      scope_tag: input.scope !== undefined ? scopeTagOf(input.scope).toString() : (input.scope_tag as string),
      expires_at: new Date(expires).toISOString(),
      status,
      hold_id: newId("hold"),
      created_at: NOW(),
      released_at: null,
      included_in_epoch: status === "active" ? (epoch + 1n).toString() : null,
    };
    state.proofReservations.set(reservation.id, reservation);
    return reservation;
  });

  on("listProofReservations", (request) => {
    const { id } = params(request);
    const query = request.query as { status?: string; limit?: string; cursor?: string };
    const all = [...state.proofReservations.values()]
      .filter((r) => r.account_id === id && (!query.status || r.status === query.status))
      .reverse();
    const limit = Number(query.limit ?? 50);
    const start = query.cursor ? Number(query.cursor) : 0;
    const data = all.slice(start, start + limit);
    return { data, next_cursor: start + limit < all.length ? String(start + limit) : null };
  });

  on("getProofReservation", (request, reply) => {
    const reservation = state.proofReservations.get(params(request).id);
    if (!reservation) return sendProblem(reply, "not_found", "No such reservation");
    return reservation;
  });

  on("releaseProofReservation", async (request, reply) => {
    const { id } = params(request);
    const reservation = state.proofReservations.get(id);
    if (!reservation) return sendProblem(reply, "not_found", "No such reservation");
    const input = body<z.output<typeof R.ReleaseProofReservationRequest>>(request);
    const denied = await checkOwner(
      reply,
      input.owner_authorization,
      ownerPayloads.proofReservationRelease(id),
    );
    if (denied) return denied;
    reservation.status = "released";
    reservation.released_at = NOW();
    return reservation;
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
