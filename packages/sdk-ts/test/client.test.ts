import { describe, expect, it } from "vitest";
import {
  AgentBankClient,
  AgentBankError,
  AuthenticationError,
  ChainError,
  ConnectionError,
  InternalServerError,
  InvalidRequestError,
  NotFoundError,
  PolicyDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  type FetchLike,
} from "../src";
import { backoffDelay, parseRetryAfter } from "../src/internal/retry";

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const PAY = "pay_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = "2026-10-11T12:00:00.000Z";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers },
  });
}

function problem(code: string, status: number, detail = "nope", extra: Record<string, unknown> = {}) {
  return { type: `urn:agentbank:problem:${code}`, title: code, status, detail, code, ...extra };
}

/** A fetch mock answering from a queue of responders and recording calls. */
function mockFetch(...responders: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const call: Call = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (!responder) throw new Error("no responder");
    return responder(call);
  };
  return { fetch, calls };
}

const fastRetry = { baseDelayMs: 1, maxDelayMs: 2 };

const payment = {
  id: PAY,
  object: "payment",
  account_id: ACCT,
  kind: "transfer",
  status: "submitted",
  amount: { amount: "1.00", asset: "USDC" },
  fee: { amount: "0.00", asset: "USDC" },
  counterparty: {
    type: "address",
    address: "0x2222222222222222222222222222222222222222",
    agent_id: null,
    x402_domain: null,
  },
  memo: null,
  mandate_id: null,
  payment_request_id: null,
  decision: null,
  approval_id: null,
  signing_request: null,
  owner_operation_id: null,
  user_op_hash: null,
  tx_hash: null,
  failure_reason: null,
  metadata: {},
  created_at: NOW,
  updated_at: NOW,
  settled_at: null,
};

describe("AgentBankClient transport", () => {
  it("fills path params, serializes queries and sends the API key on principal routes", async () => {
    const { fetch, calls } = mockFetch(() => json(200, { data: [], next_cursor: null }));
    const client = new AgentBankClient({
      baseUrl: "https://api.example.test/prefix/",
      apiKey: "abk_test_1",
      fetch,
    });
    await client.request("listPayments", { query: { account_id: ACCT, limit: 5, cursor: undefined } });
    await client.payments.retrieve(PAY).catch(() => undefined);
    expect(calls[0]?.url).toBe(`https://api.example.test/prefix/v1/payments?account_id=${ACCT}&limit=5`);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.authorization).toBe("Bearer abk_test_1");
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(calls[0]?.headers["user-agent"]).toMatch(/^agentbank-sdk-ts\//);
    expect(calls[1]?.url).toBe(`https://api.example.test/prefix/v1/payments/${PAY}`);
  });

  it("sends no credentials on public routes and routes facilitator operations to facilitatorUrl", async () => {
    const { fetch, calls } = mockFetch(
      () => json(200, { data: [] }),
      () => json(200, { kinds: [], extensions: [], signers: {} }),
    );
    const client = new AgentBankClient({
      baseUrl: "http://api.test",
      facilitatorUrl: "http://fac.test",
      fetch,
    });
    await client.billing.listPlans();
    await client.x402.supported();
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.url).toBe("http://fac.test/v1/x402/supported");
  });

  it("adds an Idempotency-Key to writes and reuses it across retries", async () => {
    const { fetch, calls } = mockFetch(
      () => json(503, problem("cosigner_unavailable", 503)),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json(201, payment),
    );
    const client = new AgentBankClient({
      baseUrl: "http://api.test",
      apiKey: "abk_test_1",
      fetch,
      retry: fastRetry,
    });
    const result = await client.payments.create({
      account_id: ACCT,
      amount: { amount: "1.00", asset: "USDC" },
      to: { address: "0x2222222222222222222222222222222222222222" },
    });
    expect(result.id).toBe(PAY);
    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}").amount).toEqual({ amount: "1.00", asset: "USDC" });
  });

  it("uses a caller-provided idempotency key and validates its length", async () => {
    const { fetch, calls } = mockFetch(() => json(201, payment));
    const client = new AgentBankClient({ baseUrl: "http://api.test", apiKey: "k", fetch });
    const body = {
      account_id: ACCT,
      amount: { amount: "1.00", asset: "USDC" as const },
      to: { account_id: ACCT },
    };
    await client.payments.create(body, { idempotencyKey: "order-1234" });
    expect(calls[0]?.headers["idempotency-key"]).toBe("order-1234");
    await expect(client.payments.create(body, { idempotencyKey: "short" })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it("honors Retry-After on 429 and fails fast when it is too long", async () => {
    const { fetch, calls } = mockFetch(
      () => json(429, problem("rate_limited", 429), { "retry-after": "0" }),
      () => json(200, payment),
    );
    const client = new AgentBankClient({ baseUrl: "http://api.test", apiKey: "k", fetch, retry: fastRetry });
    await expect(client.payments.retrieve(PAY)).resolves.toMatchObject({ id: PAY });
    expect(calls).toHaveLength(2);

    const slow = mockFetch(() => json(429, problem("rate_limited", 429), { "retry-after": "120" }));
    const client2 = new AgentBankClient({
      baseUrl: "http://api.test",
      apiKey: "k",
      fetch: slow.fetch,
      retry: fastRetry,
    });
    const error = await client2.payments.retrieve(PAY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(120_000);
    expect(slow.calls).toHaveLength(1);
  });

  it("does not retry 5xx for unsafe POSTs but does for read-only ones", async () => {
    const settle = mockFetch(() => json(503, problem("cosigner_unavailable", 503)));
    const client = new AgentBankClient({ baseUrl: "http://api.test", fetch: settle.fetch, retry: fastRetry });
    const requirements = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: "0x2222222222222222222222222222222222222222",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const verifyBody = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: {} },
      paymentRequirements: requirements,
    };
    await expect(client.x402.settle(verifyBody)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(settle.calls).toHaveLength(1);

    const verify = mockFetch(
      () => json(503, problem("cosigner_unavailable", 503)),
      () => json(200, { isValid: true }),
    );
    const client2 = new AgentBankClient({
      baseUrl: "http://api.test",
      fetch: verify.fetch,
      retry: fastRetry,
    });
    await expect(client2.x402.verify(verifyBody)).resolves.toEqual({ isValid: true });
    expect(verify.calls).toHaveLength(2);
  });

  it("maps RFC 9457 problems to error subclasses", async () => {
    const decision = {
      outcome: "deny",
      rule_hits: [{ rule: "limits.per_day", effect: "deny", detail: "daily limit" }],
      approvers_required: 0,
      policy_version: 3,
      evaluated_at: NOW,
    };
    const { fetch } = mockFetch(
      () =>
        json(422, problem("policy_denied", 422, "denied by policy", { decision }), {
          "x-request-id": "req_1",
        }),
      () => json(404, problem("not_found", 404)),
      () => json(401, problem("signature_invalid", 401, "bad signature")),
      () => json(418, problem("teapot_overflow", 418, "short and stout")),
      () =>
        new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );
    const client = new AgentBankClient({ baseUrl: "http://api.test", apiKey: "k", fetch, maxRetries: 0 });
    const denied = await client.payments.retrieve(PAY).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(PolicyDeniedError);
    expect(denied).toBeInstanceOf(AgentBankError);
    expect(denied).toMatchObject({
      code: "policy_denied",
      httpStatus: 422,
      requestId: "req_1",
      operationId: "getPayment",
    });
    expect((denied as PolicyDeniedError).decision?.rule_hits[0]?.rule).toBe("limits.per_day");
    expect((denied as Error).message).toBe("denied by policy");

    await expect(client.payments.retrieve(PAY)).rejects.toBeInstanceOf(NotFoundError);
    const auth = await client.payments.retrieve(PAY).catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(AuthenticationError);
    expect((auth as AuthenticationError).code).toBe("signature_invalid");
    const unknown = await client.payments.retrieve(PAY).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(InvalidRequestError);
    expect((unknown as AgentBankError).extensions.unknown_code).toBe("teapot_overflow");
    const gateway = await client.payments.retrieve(PAY).catch((e: unknown) => e);
    expect(gateway).toBeInstanceOf(ChainError);
    expect((gateway as ChainError).httpStatus).toBe(502);
  });

  it("validates requests client-side without a round trip", async () => {
    const { fetch, calls } = mockFetch(() => json(200, {}));
    const client = new AgentBankClient({ baseUrl: "http://api.test", apiKey: "k", fetch });
    const error = await client.payments
      .create({
        account_id: ACCT,
        amount: { amount: 12.5 as unknown as string, asset: "USDC" },
        to: { address: "0x2222222222222222222222222222222222222222" },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as Error).message).toContain("body.amount.amount");
    await expect(client.payments.retrieve("esc_01JABCDEFGHJKMNPQRSTVWXYZ0")).rejects.toThrow(/params.id/);
    await expect(client.request("getPayment", { params: { id: "" } } as never)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(calls).toHaveLength(0);
  });

  it("retries network errors on GET and maps exhaustion to ConnectionError", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const client = new AgentBankClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      fetch,
      retry: fastRetry,
      maxRetries: 2,
    });
    const error = await client.payments.retrieve(PAY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain("ECONNREFUSED");
    expect(calls).toHaveLength(3);
  });

  it("times out slow requests and lets callers abort", async () => {
    const hang: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const client = new AgentBankClient({
      baseUrl: "http://api.test",
      apiKey: "k",
      fetch: hang,
      timeoutMs: 20,
      maxRetries: 0,
    });
    await expect(client.payments.retrieve(PAY)).rejects.toBeInstanceOf(TimeoutError);

    const controller = new AbortController();
    const pending = client.payments.retrieve(PAY, { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("validates responses when asked", async () => {
    const { fetch } = mockFetch(
      () => json(200, { ...payment, amount: { amount: 1, asset: "USDC" } }),
      () => json(200, payment),
    );
    const client = new AgentBankClient({
      baseUrl: "http://api.test",
      apiKey: "k",
      fetch,
      validateResponses: true,
    });
    await expect(client.payments.retrieve(PAY)).rejects.toBeInstanceOf(InternalServerError);
    await expect(client.payments.retrieve(PAY)).resolves.toMatchObject({ id: PAY });
  });

  it("paginates with next_cursor", async () => {
    const pages = [
      { data: [payment, { ...payment, id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ1" }], next_cursor: "c2" },
      { data: [{ ...payment, id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ2" }], next_cursor: null },
    ];
    let page = 0;
    const { fetch, calls } = mockFetch(() => json(200, pages[page++]));
    const client = new AgentBankClient({ baseUrl: "http://api.test", apiKey: "k", fetch });
    const ids: string[] = [];
    for await (const p of client.paginate("listPayments", { query: { account_id: ACCT } })) ids.push(p.id);
    expect(ids).toHaveLength(3);
    expect(calls[1]?.url).toContain("cursor=c2");
  });

  it("returns CSV statements as text", async () => {
    const { fetch, calls } = mockFetch(
      () =>
        new Response("date,amount\n2026-10-01,1.00\n", {
          status: 200,
          headers: { "content-type": "text/csv" },
        }),
    );
    const client = new AgentBankClient({ baseUrl: "http://api.test", apiKey: "k", fetch });
    const csv = await client.ledger.statementCsv({ account_id: ACCT, period: "2026-10" });
    expect(csv).toContain("date,amount");
    expect(calls[0]?.url).toContain("format=csv");
    expect(calls[0]?.headers.accept).toBe("text/csv");
  });

  it("rejects bad configuration", () => {
    expect(() => new AgentBankClient({ baseUrl: "ftp://x" })).toThrow(InvalidRequestError);
    expect(() => new AgentBankClient({ apiKey: " " })).toThrow(InvalidRequestError);
  });
});

describe("retry helpers", () => {
  it("computes jittered exponential backoff within bounds", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(0, opts, () => 0)).toBe(50);
    expect(backoffDelay(0, opts, () => 1)).toBe(100);
    expect(backoffDelay(3, opts, () => 0.5)).toBe(600);
    expect(backoffDelay(10, opts, () => 1)).toBe(1000);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(parseRetryAfter("Sun, 11 Oct 2026 12:00:05 GMT", now)).toBe(5000);
  });
});
