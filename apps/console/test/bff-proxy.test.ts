/** @vitest-environment node */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/v1/[...path]/route";
import { newPrincipalSession, newStaffSession, seal } from "@/lib/server/session";

const ORIGIN = "http://console.test";
const API = "http://api.internal:8080";
const AGENT = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const CSRF = "csrf-token-0123456789abcdefghijklmnop";

type Init = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cookies?: Record<string, string>;
};

function request(path: string, init: Init = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.cookies) {
    headers.set(
      "cookie",
      Object.entries(init.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

let upstream: ReturnType<typeof vi.fn>;

function lastCall(): { url: string; init: RequestInit; headers: Headers } {
  const call = upstream.mock.calls.at(-1);
  if (!call) throw new Error("upstream was not called");
  const [url, init] = call as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

async function apiKeyCookie(token = "abk_test_0123456789abcdef") {
  return seal("session", newPrincipalSession("api_key", token));
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AGENTBANK_API_URL", API);
  vi.stubEnv("CONSOLE_SESSION_SECRET", "s".repeat(48));
  vi.stubEnv("CONSOLE_ORIGIN", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_SANDBOX", "true");
  vi.stubEnv("STAFF_DASHBOARD_ENABLED", "true");
  upstream = vi.fn(async () => json({ data: [], next_cursor: null }));
  vi.stubGlobal("fetch", upstream);
});

describe("BFF proxy: credentials", () => {
  it("turns the sealed API-key cookie into Authorization: Bearer and forwards no cookies", async () => {
    const res = await GET(
      request("/api/v1/agents?limit=5&debug=1", {
        cookies: { ab_session: await apiKeyCookie("abk_test_secretsecret01"), unrelated: "x" },
      }),
      ctx(["agents"]),
    );
    expect(res.status).toBe(200);
    const { url, headers } = lastCall();
    expect(url).toBe(`${API}/v1/agents?limit=5`);
    expect(headers.get("authorization")).toBe("Bearer abk_test_secretsecret01");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-request-id")).toBeTruthy();
  });

  it("sends a passkey session as the API's own session cookie, never as a bearer token", async () => {
    const cookie = await seal("session", newPrincipalSession("passkey", "console-session-token"));
    await GET(request("/api/v1/orgs/me", { cookies: { ab_session: cookie } }), ctx(["orgs", "me"]));
    const { headers } = lastCall();
    expect(headers.get("cookie")).toBe("agentbank_session=console-session-token");
    expect(headers.get("authorization")).toBeNull();
  });

  it("answers 401 without a session and never calls the API", async () => {
    const res = await GET(request("/api/v1/agents"), ctx(["agents"]));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("ignores a tampered or foreign cookie", async () => {
    const forged = (await apiKeyCookie()).slice(0, -4) + "AAAA";
    const res = await GET(request("/api/v1/agents", { cookies: { ab_session: forged } }), ctx(["agents"]));
    expect(res.status).toBe(401);
    const staffAsSession = await seal("staff", newStaffSession("t".repeat(40)));
    const res2 = await GET(
      request("/api/v1/agents", { cookies: { ab_session: staffAsSession } }),
      ctx(["agents"]),
    );
    expect(res2.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses only the staff cookie for staff routes", async () => {
    const principalOnly = await GET(
      request("/api/v1/admin/revenue?period=2026-10", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["admin", "revenue"]),
    );
    expect(principalOnly.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();

    const staff = await seal("staff", newStaffSession("o".repeat(40)));
    const res = await GET(
      request("/api/v1/admin/revenue?period=2026-10", { cookies: { ab_staff: staff } }),
      ctx(["admin", "revenue"]),
    );
    expect(res.status).toBe(200);
    expect(lastCall().headers.get("authorization")).toBe(`Bearer ${"o".repeat(40)}`);
  });

  it("clears the session cookie when the API says the credential is no longer valid", async () => {
    upstream.mockResolvedValueOnce(
      json(
        {
          type: "urn:agentbank:problem:unauthorized",
          title: "Authentication required",
          status: 401,
          code: "unauthorized",
        },
        401,
      ),
    );
    const res = await GET(
      request("/api/v1/agents", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["agents"]),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/ab_session=;.*Max-Age=0/i);
  });

  it("keeps the session on a 401 that is about a signature, not the credential", async () => {
    upstream.mockResolvedValueOnce(
      json(
        { title: "Signature invalid", status: 401, code: "signature_invalid", detail: "bad owner signature" },
        401,
      ),
    );
    const res = await GET(
      request("/api/v1/agents", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["agents"]),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("BFF proxy: CSRF", () => {
  const freezePath = ["agents", AGENT, "freeze"];
  const body = JSON.stringify({ reason: "suspicious spend" });

  it("rejects writes from another origin before reaching the API", async () => {
    const res = await POST(
      request(`/api/v1/agents/${AGENT}/freeze`, {
        method: "POST",
        body,
        headers: { origin: "https://evil.example", "content-type": "application/json", "x-csrf-token": CSRF },
        cookies: { ab_session: await apiKeyCookie(), ab_csrf: CSRF },
      }),
      ctx(freezePath),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "csrf_rejected" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects same-origin writes without the double-submit token", async () => {
    const res = await POST(
      request(`/api/v1/agents/${AGENT}/freeze`, {
        method: "POST",
        body,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        cookies: { ab_session: await apiKeyCookie(), ab_csrf: CSRF },
      }),
      ctx(freezePath),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a token that does not match the cookie", async () => {
    const res = await POST(
      request(`/api/v1/agents/${AGENT}/freeze`, {
        method: "POST",
        body,
        headers: { origin: ORIGIN, "content-type": "application/json", "x-csrf-token": `${CSRF}x` },
        cookies: { ab_session: await apiKeyCookie(), ab_csrf: CSRF },
      }),
      ctx(freezePath),
    );
    expect(res.status).toBe(403);
  });

  it("rejects writes with no Origin, Sec-Fetch-Site or Referer at all", async () => {
    const res = await POST(
      request(`/api/v1/agents/${AGENT}/freeze`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", "x-csrf-token": CSRF },
        cookies: { ab_session: await apiKeyCookie(), ab_csrf: CSRF },
      }),
      ctx(freezePath),
    );
    expect(res.status).toBe(403);
  });

  it("forwards same-origin writes with the body and an idempotency key", async () => {
    upstream.mockResolvedValueOnce(json({ id: AGENT, object: "agent" }));
    const res = await POST(
      request(`/api/v1/agents/${AGENT}/freeze`, {
        method: "POST",
        body,
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "x-csrf-token": CSRF,
          "idempotency-key": "idem-0123456789",
        },
        cookies: { ab_session: await apiKeyCookie(), ab_csrf: CSRF },
      }),
      ctx(freezePath),
    );
    expect(res.status).toBe(200);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`${API}/v1/agents/${AGENT}/freeze`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(headers.get("idempotency-key")).toBe("idem-0123456789");
    expect(headers.get("x-csrf-token")).toBeNull();
    expect(headers.get("origin")).toBeNull();
  });

  it("allows Sec-Fetch-Site: same-origin when a browser omits Origin", async () => {
    const res = await DELETE(
      request("/api/v1/api-keys/key_01J9ZQ3W8K7X5V4T3S2R1Q0P9N", {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin", "x-csrf-token": CSRF },
        cookies: { ab_session: await apiKeyCookie(), ab_csrf: CSRF },
      }),
      ctx(["api-keys", "key_01J9ZQ3W8K7X5V4T3S2R1Q0P9N"]),
    );
    expect(res.status).toBe(200);
  });

  it("does not require a CSRF token for reads", async () => {
    const res = await GET(
      request("/api/v1/agents", {
        headers: { origin: "https://evil.example" },
        cookies: { ab_session: await apiKeyCookie() },
      }),
      ctx(["agents"]),
    );
    // Reads are side-effect free; SameSite=Lax and CORS keep their responses away from other origins.
    expect(res.status).toBe(200);
  });
});

describe("BFF proxy: allowlist and responses", () => {
  it("does not expose agent-only or facilitator routes", async () => {
    const cookie = await apiKeyCookie();
    const csrf = { origin: ORIGIN, "x-csrf-token": CSRF, "content-type": "application/json" };
    const pay = await POST(
      request("/api/v1/x402/pay", {
        method: "POST",
        body: "{}",
        headers: csrf,
        cookies: { ab_session: cookie, ab_csrf: CSRF },
      }),
      ctx(["x402", "pay"]),
    );
    expect(pay.status).toBe(404);
    const createPayment = await POST(
      request("/api/v1/payments", {
        method: "POST",
        body: "{}",
        headers: csrf,
        cookies: { ab_session: cookie, ab_csrf: CSRF },
      }),
      ctx(["payments"]),
    );
    expect(createPayment.status).toBe(405);
    const unknown = await GET(
      request("/api/v1/internal/keys", { cookies: { ab_session: cookie } }),
      ctx(["internal", "keys"]),
    );
    expect(unknown.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("validates path ids against the route registry", async () => {
    const res = await GET(
      request("/api/v1/agents/not-an-agent", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["agents", "not-an-agent"]),
    );
    expect(res.status).toBe(400);
    const dots = await GET(
      request("/api/v1/agents/..", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["agents", ".."]),
    );
    expect(dots.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never forwards Set-Cookie and passes CSV statements through", async () => {
    upstream.mockResolvedValueOnce(
      new Response("date,amount\n2026-10-01,25.00\n", {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="statement.csv"',
          "set-cookie": "agentbank_session=leak; Path=/",
        },
      }),
    );
    const res = await GET(
      request(`/api/v1/statements?account_id=acct_01J9ZQ3W8K7X5V4T3S2R1Q0P9N&period=2026-10&format=csv`, {
        cookies: { ab_session: await apiKeyCookie() },
      }),
      ctx(["statements"]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("statement.csv");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("25.00");
  });

  it("turns an unreachable API into a 502 problem", async () => {
    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await GET(
      request("/api/v1/agents", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["agents"]),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "api_unreachable" });
  });

  it("relays API problem details unchanged", async () => {
    upstream.mockResolvedValueOnce(
      json(
        {
          type: "urn:agentbank:problem:owner_signature_required",
          title: "Owner signature required",
          status: 403,
          code: "owner_signature_required",
          detail: "This change loosens limits",
        },
        403,
        { "content-type": "application/problem+json" },
      ),
    );
    const res = await GET(
      request("/api/v1/agents", { cookies: { ab_session: await apiKeyCookie() } }),
      ctx(["agents"]),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "owner_signature_required",
      detail: "This change loosens limits",
    });
  });

  it("drops API-key sessions when the deployment is not a sandbox", async () => {
    const cookie = await apiKeyCookie();
    vi.stubEnv("NEXT_PUBLIC_SANDBOX", "false");
    const res = await GET(request("/api/v1/agents", { cookies: { ab_session: cookie } }), ctx(["agents"]));
    expect(res.status).toBe(401);
  });
});
