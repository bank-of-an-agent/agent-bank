import { signRequest } from "@agentbank/core";
import {
  routes,
  type AuthKind,
  type OperationId,
  type RequestInputOf,
  type ResponseOf,
  type RouteDef,
} from "@agentbank/core/api";
import type { z } from "zod";
import type { AgentBankApiError } from "./errors";
import {
  ConnectionError,
  errorFromResponse,
  InternalServerError,
  InvalidRequestError,
  TimeoutError,
} from "./errors";
import { randomId } from "./internal/ids";
import { backoffDelay, DEFAULT_RETRY, parseRetryAfter, sleep, type RetryOptions } from "./internal/retry";
import { appendQuery, fillPath, joinUrl } from "./internal/url";
import { formatIssues, summarizeIssues } from "./internal/zod";
import {
  Accounts,
  Agents,
  ApiKeys,
  Approvals,
  Billing,
  Escrows,
  Ledger,
  Mandates,
  Members,
  Orgs,
  OwnerOperations,
  PaymentRequests,
  Payments,
  Policies,
  Sandbox,
  Sessions,
  Streams,
  Treasury,
  Vaults,
  Webhooks,
  X402,
} from "./resources";
import type { SessionSigner } from "./signers";
import type { Health, Meta } from "./types";
import { SDK_VERSION } from "./version";

export type { RetryOptions } from "./internal/retry";

/** A `fetch`-compatible function (the global `fetch`, undici, a test double, …). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The agent's session credentials: the session id (`ses_…`) and its key. */
export interface SessionCredentials {
  /** Session id returned by `createSession`; sent as the RFC 9421 `keyid`. */
  id: string;
  /** The session key. A viem `LocalAccount` works. */
  signer: SessionSigner;
}

/** Options for {@link AgentBankClient}. */
export interface ClientOptions {
  /** API base URL, e.g. `https://sandbox.agentbank.example` (default `http://localhost:8080`). */
  baseUrl?: string;
  /**
   * Base URL of the x402 facilitator service for `x402.verify/settle/supported`
   * (default: `baseUrl`; the load balancer routes `/v1/x402/*` there).
   */
  facilitatorUrl?: string;
  /**
   * Principal credentials: an org API key (`abk_test_…`), sent as
   * `Authorization: Bearer`. Never give an API key to an agent.
   */
  apiKey?: string;
  /** Agent credentials: every request is signed with the session key (RFC 9421). */
  session?: SessionCredentials;
  /** `fetch` implementation (default: the global `fetch`). */
  fetch?: FetchLike;
  /** Per-attempt timeout in milliseconds, including reading the body (default 30000). */
  timeoutMs?: number;
  /** Retries after the first attempt (default 2). Shorthand for `retry.maxRetries`. */
  maxRetries?: number;
  /** Backoff tuning. */
  retry?: RetryOptions;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * Validate params, query and body against the API contract before sending
   * (default `true`). Invalid input throws {@link InvalidRequestError} without
   * a network round trip.
   */
  validateRequests?: boolean;
  /**
   * Validate responses against the API contract (default `false`). When on,
   * a mismatch throws {@link InternalServerError}; responses are returned in
   * their parsed form (server defaults applied).
   */
  validateResponses?: boolean;
  /** Lifetime of each request signature in seconds (default 120, max 300). */
  signatureLifetimeSeconds?: number;
}

/** Per-request options accepted by every method. */
export interface RequestOptions {
  /**
   * Idempotency key for writes. Generated automatically (UUID v4) for
   * idempotent routes and reused across the automatic retries of one call.
   * Pass your own to make retries across process restarts safe.
   */
  idempotencyKey?: string;
  /** Abort the request (and any pending retry). */
  signal?: AbortSignal;
  /** Override the client timeout for this request. */
  timeoutMs?: number;
  /** Override the client retry count for this request. */
  maxRetries?: number;
  /** Extra headers for this request. */
  headers?: Record<string, string>;
}

type Slot<Name extends string, T> = [T] extends [undefined]
  ? { [P in Name]?: undefined }
  : object extends T
    ? { [P in Name]?: T }
    : { [P in Name]: T };

/** Arguments of {@link AgentBankClient.request} for an operation: `params`, `query`, `body` plus {@link RequestOptions}. */
export type RequestArgs<K extends OperationId> = Slot<"params", RequestInputOf<K>["params"]> &
  Slot<"query", RequestInputOf<K>["query"]> &
  Slot<"body", RequestInputOf<K>["body"]> &
  RequestOptions;

/** Rest-tuple form of {@link RequestArgs}: optional when nothing is required. */
export type RequestArgsTuple<K extends OperationId> =
  object extends RequestArgs<K> ? [args?: RequestArgs<K>] : [args: RequestArgs<K>];

/** Operations that return a cursor page (`{ data, next_cursor }`). */
export type ListOperationId = {
  [K in OperationId]: ResponseOf<K> extends { data: unknown[]; next_cursor: string | null } ? K : never;
}[OperationId];

/** Item type of a list operation. */
export type ListItem<K extends ListOperationId> = ResponseOf<K> extends { data: (infer T)[] } ? T : never;

interface LooseArgs extends RequestOptions {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** Status codes worth retrying for retry-safe requests. */
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
/** POST routes without an idempotency key that are nevertheless safe to repeat (read-only). */
const SAFE_POSTS = new Set<string>(["checkPolicy", "x402Verify"]);

const DEFAULT_BASE_URL = "http://localhost:8080";

/**
 * Typed client for the Agent Bank REST API.
 *
 * `request(operationId, { params, query, body })` is a typed transport over
 * the route registry in `@agentbank/core` (the single source of truth for
 * paths, methods, schemas and auth), and the resource namespaces
 * (`client.payments.create(...)`, …) wrap it with ergonomic signatures.
 *
 * Built in:
 * - **Auth.** Principal routes send `Authorization: Bearer <apiKey>`; agent
 *   routes are signed with the session key (RFC 9421, `eip191-secp256k1`)
 *   over the exact bytes sent, re-signed with a fresh nonce on every retry.
 * - **Idempotency.** Writes get an `Idempotency-Key` that is reused across retries.
 * - **Retries.** Exponential backoff with jitter on network errors, timeouts,
 *   429 (honoring `Retry-After`) and 5xx — only for requests that are safe to
 *   repeat (GET/PUT/DELETE, idempotent writes, read-only POSTs).
 * - **Errors.** RFC 9457 problems become {@link AgentBankApiError} subclasses.
 *
 * Works in Node ≥ 20 and modern browsers (no Node-only APIs).
 *
 * @example Principal
 * ```ts
 * const bank = new AgentBankClient({ baseUrl, apiKey: process.env.AGENTBANK_API_KEY });
 * const agent = await bank.agents.create({ name: "research-bot" });
 * ```
 */
export class AgentBankClient {
  readonly baseUrl: string;
  readonly facilitatorUrl: string;

  readonly orgs: Orgs;
  readonly apiKeys: ApiKeys;
  readonly members: Members;
  readonly agents: Agents;
  readonly accounts: Accounts;
  readonly sessions: Sessions;
  readonly ownerOperations: OwnerOperations;
  readonly mandates: Mandates;
  readonly policies: Policies;
  readonly payments: Payments;
  readonly paymentRequests: PaymentRequests;
  readonly x402: X402;
  readonly escrows: Escrows;
  readonly streams: Streams;
  readonly approvals: Approvals;
  readonly ledger: Ledger;
  readonly vaults: Vaults;
  readonly treasury: Treasury;
  readonly webhooks: Webhooks;
  readonly billing: Billing;
  readonly sandbox: Sandbox;

  /** Session credentials used to sign agent requests (if configured). */
  readonly #session: SessionCredentials | undefined;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: Required<RetryOptions>;
  readonly #headers: Record<string, string>;
  readonly #validateRequests: boolean;
  readonly #validateResponses: boolean;
  readonly #signatureLifetime: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.facilitatorUrl = (options.facilitatorUrl ?? this.baseUrl).replace(/\/+$/, "");
    for (const [name, value] of [
      ["baseUrl", this.baseUrl],
      ["facilitatorUrl", this.facilitatorUrl],
    ] as const) {
      if (!isHttpUrl(value))
        throw new InvalidRequestError("invalid_request", `${name} must be an http(s) URL`);
    }
    if (options.apiKey !== undefined && options.apiKey.trim() === "") {
      throw new InvalidRequestError("invalid_request", "apiKey must not be empty");
    }
    if (options.session) {
      if (!options.session.id) throw new InvalidRequestError("invalid_request", "session.id is required");
      if (!options.session.signer)
        throw new InvalidRequestError("invalid_request", "session.signer is required");
    }
    this.#apiKey = options.apiKey;
    this.#session = options.session;
    if (!options.fetch && typeof globalThis.fetch !== "function") {
      throw new InvalidRequestError(
        "invalid_request",
        "No fetch implementation available; pass options.fetch",
      );
    }
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retry = {
      ...DEFAULT_RETRY,
      ...options.retry,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    };
    this.#headers = lowercaseKeys(options.headers ?? {});
    this.#validateRequests = options.validateRequests ?? true;
    this.#validateResponses = options.validateResponses ?? false;
    this.#signatureLifetime = options.signatureLifetimeSeconds ?? 120;

    this.orgs = new Orgs(this);
    this.apiKeys = new ApiKeys(this);
    this.members = new Members(this);
    this.agents = new Agents(this);
    this.accounts = new Accounts(this);
    this.sessions = new Sessions(this);
    this.ownerOperations = new OwnerOperations(this);
    this.mandates = new Mandates(this);
    this.policies = new Policies(this);
    this.payments = new Payments(this);
    this.paymentRequests = new PaymentRequests(this);
    this.x402 = new X402(this);
    this.escrows = new Escrows(this);
    this.streams = new Streams(this);
    this.approvals = new Approvals(this);
    this.ledger = new Ledger(this);
    this.vaults = new Vaults(this);
    this.treasury = new Treasury(this);
    this.webhooks = new Webhooks(this);
    this.billing = new Billing(this);
    this.sandbox = new Sandbox(this);
  }

  /**
   * Call any operation of the route registry by its `operationId`.
   *
   * @example
   * ```ts
   * const payment = await client.request("getPayment", { params: { id: "pay_…" } });
   * const page = await client.request("listPayments", { query: { limit: 20 } });
   * ```
   */
  async request<K extends OperationId>(operationId: K, ...args: RequestArgsTuple<K>): Promise<ResponseOf<K>> {
    const route = (routes as Record<string, RouteDef>)[operationId];
    if (!route)
      throw new InvalidRequestError("invalid_request", `Unknown operation "${String(operationId)}"`);
    return (await this.#execute(route, (args[0] ?? {}) as LooseArgs)) as ResponseOf<K>;
  }

  /**
   * Iterate over every item of a list operation, following `next_cursor`.
   *
   * @example
   * ```ts
   * for await (const payment of client.paginate("listPayments", { query: { account_id } })) { … }
   * ```
   */
  async *paginate<K extends ListOperationId>(
    operationId: K,
    ...args: RequestArgsTuple<K>
  ): AsyncGenerator<ListItem<K>, void, undefined> {
    const route = (routes as Record<string, RouteDef>)[operationId];
    if (!route)
      throw new InvalidRequestError("invalid_request", `Unknown operation "${String(operationId)}"`);
    const base = (args[0] ?? {}) as LooseArgs;
    let cursor = base.query?.cursor as string | undefined;
    do {
      const page = (await this.#execute(route, {
        ...base,
        query: { ...base.query, ...(cursor ? { cursor } : {}) },
      })) as { data: ListItem<K>[]; next_cursor: string | null };
      for (const item of page.data) yield item;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  /** Liveness and dependency checks (`GET /healthz`). */
  health(options?: RequestOptions): Promise<Health> {
    return this.request("health", { ...options });
  }

  /**
   * Deployment facts (`GET /v1/meta`, public): chain and CAIP-2 id, USDC
   * address and EIP-712 domain, contract addresses, feature flags, the
   * facilitator URL, and `owner_authorization_chain_id`, the chain id to use
   * in the EIP-712 domain of owner authorizations.
   */
  meta(options?: RequestOptions): Promise<Meta> {
    return this.request("getMeta", { ...options });
  }

  async #execute(route: RouteDef, args: LooseArgs): Promise<unknown> {
    if (this.#validateRequests) this.#validate(route, args);
    else if (args.body !== undefined && !route.body) {
      throw new InvalidRequestError("invalid_request", `${route.operationId} takes no request body`);
    }
    const base = route.service === "facilitator" ? this.facilitatorUrl : this.baseUrl;
    const path = fillPath(route.path, args.params, (name) => {
      throw new InvalidRequestError(
        "invalid_request",
        `Missing path parameter "${name}"`,
        {},
        {
          operationId: route.operationId,
        },
      );
    });
    const url = appendQuery(new URL(joinUrl(base, path)), args.query).toString();
    const body = route.body ? JSON.stringify(args.body ?? {}) : undefined;

    let idempotencyKey = args.idempotencyKey;
    if (idempotencyKey !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 255)) {
      throw new InvalidRequestError("invalid_request", "idempotencyKey must be 8 to 255 characters");
    }
    if (idempotencyKey === undefined && route.idempotent) idempotencyKey = randomId();

    const maxRetries = args.maxRetries ?? this.#retry.maxRetries;
    const retrySafe =
      route.method !== "POST" || idempotencyKey !== undefined || SAFE_POSTS.has(route.operationId);

    for (let attempt = 0; ; attempt++) {
      let raw: RawResponse;
      try {
        raw = await this.#send(route, url, body, idempotencyKey, args);
      } catch (error) {
        if (error instanceof ConnectionError && retrySafe && attempt < maxRetries) {
          await sleep(backoffDelay(attempt, this.#retry), args.signal);
          continue;
        }
        throw error;
      }
      if (raw.status >= 200 && raw.status < 300) return this.#parse(route, raw);

      const error = this.#toError(route, raw);
      const retryable = raw.status === 429 || (retrySafe && RETRYABLE_STATUS.has(raw.status));
      if (retryable && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(raw.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > this.#retry.maxRetryAfterMs) throw error;
        await sleep(Math.max(retryAfter ?? 0, backoffDelay(attempt, this.#retry)), args.signal);
        continue;
      }
      throw error;
    }
  }

  #validate(route: RouteDef, args: LooseArgs): void {
    const parts: [string, z.ZodType | undefined, unknown][] = [
      ["params", route.params, args.params ?? {}],
      ["query", route.query, args.query ?? {}],
      ["body", route.body, args.body ?? {}],
    ];
    for (const [name, schema, value] of parts) {
      if (!schema) {
        if (name === "body" && args.body !== undefined) {
          throw new InvalidRequestError("invalid_request", `${route.operationId} takes no request body`);
        }
        continue;
      }
      const result = schema.safeParse(value);
      if (!result.success) {
        const issues = summarizeIssues(result.error).map((i) => ({ ...i, path: `${name}.${i.path}` }));
        throw new InvalidRequestError(
          "invalid_request",
          `Invalid ${route.operationId} request: ${formatIssues(issues)}`,
          { issues },
          { operationId: route.operationId },
        );
      }
    }
  }

  #authFor(route: RouteDef): "agent" | "principal" | "none" {
    const allows = (kind: AuthKind) => route.auth.includes(kind);
    if (this.#session && allows("agent")) return "agent";
    if (this.#apiKey && (allows("principal") || allows("approver") || allows("seller") || allows("staff"))) {
      return "principal";
    }
    if (allows("public")) return "none";
    // The route does not accept our credential type; send what we have and let the API explain.
    if (this.#session) return "agent";
    if (this.#apiKey) return "principal";
    return "none";
  }

  async #send(
    route: RouteDef,
    url: string,
    body: string | undefined,
    idempotencyKey: string | undefined,
    args: LooseArgs,
  ): Promise<RawResponse> {
    if (args.signal?.aborted) throw args.signal.reason;
    const headers: Record<string, string> = {
      accept: "application/json, application/problem+json",
      ...this.#headers,
      ...lowercaseKeys(args.headers ?? {}),
    };
    if (isNode()) headers["user-agent"] ??= `agentbank-sdk-ts/${SDK_VERSION}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;

    const auth = this.#authFor(route);
    if (auth === "principal") headers.authorization = `Bearer ${this.#apiKey}`;
    if (auth === "agent" && this.#session) {
      delete headers.authorization;
      const signed = await signRequest(
        { method: route.method, url, headers, body: body ?? null },
        { keyId: this.#session.id, signer: this.#session.signer, lifetimeSeconds: this.#signatureLifetime },
      );
      for (const [name, value] of Object.entries(signed)) if (value !== undefined) headers[name] = value;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = args.timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    const onAbort = () => controller.abort(args.signal?.reason);
    args.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(url, {
        method: route.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (args.signal?.aborted) throw args.signal.reason ?? error;
      const meta = { operationId: route.operationId, cause: error };
      if (timedOut) {
        throw new TimeoutError("internal", `${route.operationId} timed out after ${timeoutMs} ms`, {}, meta);
      }
      throw new ConnectionError(
        "internal",
        `Could not reach Agent Bank at ${new URL(url).origin}${describeCause(error)}`,
        {},
        meta,
      );
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
    }
  }

  #parse(route: RouteDef, raw: RawResponse): unknown {
    if (raw.text === "") return undefined;
    const contentType = raw.headers.get("content-type") ?? "";
    const looksJson = /json/i.test(contentType) || (!contentType && /^\s*[[{]/.test(raw.text));
    if (!looksJson) return raw.text;
    let data: unknown;
    try {
      data = JSON.parse(raw.text);
    } catch {
      throw new InternalServerError(
        "internal",
        `${route.operationId}: response body is not valid JSON`,
        {},
        {
          operationId: route.operationId,
          httpStatus: raw.status,
        },
      );
    }
    if (!this.#validateResponses) return data;
    const result = route.response.safeParse(data);
    if (!result.success) {
      throw new InternalServerError(
        "internal",
        `${route.operationId}: response does not match the API contract: ${formatIssues(summarizeIssues(result.error))}`,
        {},
        { operationId: route.operationId, httpStatus: raw.status },
      );
    }
    return result.data;
  }

  #toError(route: RouteDef, raw: RawResponse): AgentBankApiError {
    let problem: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(raw.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        problem = parsed as Record<string, unknown>;
      }
    } catch {
      problem = undefined;
    }
    const requestId = raw.headers.get("x-request-id") ?? raw.headers.get("request-id") ?? undefined;
    const retryAfterMs = parseRetryAfter(raw.headers.get("retry-after"));
    return errorFromResponse(raw.status, problem, {
      operationId: route.operationId,
      ...(requestId ? { requestId } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === "string";
}

function describeCause(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  if (cause && typeof cause.code === "string") return ` (${cause.code})`;
  return "";
}
