/** @vitest-environment node */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as apiKeySignIn } from "@/app/api/auth/api-key/route";
import { POST as loginVerify } from "@/app/api/auth/passkey/login/verify/route";
import { POST as approvalOptions } from "@/app/api/auth/approvals/[id]/options/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { POST as signUp } from "@/app/api/auth/sign-up/route";
import { GET as sessionInfo } from "@/app/api/auth/session/route";
import { POST as staffSignIn } from "@/app/api/admin/sign-in/route";
import { apiSessionToken } from "@/lib/server/auth-handlers";
import { newPrincipalSession, readPrincipalSession, readStaffSession, seal } from "@/lib/server/session";

const ORIGIN = "http://console.test";
const API = "http://api.internal:8080";
const CSRF = "csrf-token-0123456789abcdefghijklmnop";
const ORG_ID = "org_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const MEMBER_ID = "mem_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const APPROVAL_ID = "apr_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";

const org = {
  id: ORG_ID,
  object: "org",
  legal_name: "Acme Robotics",
  kind: "company",
  country: "US",
  kyc_status: "approved",
  tier: "free",
  status: "active",
  frozen_reason: null,
  pending_unfreeze_at: null,
  owner_address: "0x1111111111111111111111111111111111111111",
  treasury_account_id: null,
  created_at: "2026-10-11T12:00:00.000Z",
};

const member = {
  id: MEMBER_ID,
  object: "member",
  org_id: ORG_ID,
  email: "ada@acme.test",
  role: "admin",
  passkey_count: 1,
  created_at: "2026-10-11T12:00:00.000Z",
};

function post(path: string, body: unknown, init: { cookies?: Record<string, string>; origin?: string } = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: init.origin ?? ORIGIN,
    "x-csrf-token": CSRF,
  });
  const cookies = { ab_csrf: CSRF, ...init.cookies };
  headers.set(
    "cookie",
    Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  );
  return new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [key, ...rest] = (pair ?? "").split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
}

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AGENTBANK_API_URL", API);
  vi.stubEnv("CONSOLE_SESSION_SECRET", "s".repeat(48));
  vi.stubEnv("CONSOLE_ORIGIN", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_SANDBOX", "true");
  vi.stubEnv("STAFF_DASHBOARD_ENABLED", "true");
  upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
});

describe("sandbox API-key sign-in", () => {
  it("verifies the key with the API and keeps it only in a sealed httpOnly cookie", async () => {
    upstream.mockResolvedValueOnce(Response.json(org));
    const res = await apiKeySignIn(post("/api/auth/api-key", { api_key: "abk_test_0123456789abcdef" }));
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/v1/orgs/me`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer abk_test_0123456789abcdef");

    const body = await res.text();
    expect(body).not.toContain("abk_test_0123456789abcdef");
    const header = setCookie(res, "ab_session") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toContain("abk_test");
    const session = await readPrincipalSession(cookieValue(res, "ab_session"));
    expect(session).toMatchObject({ kind: "api_key", token: "abk_test_0123456789abcdef", orgId: ORG_ID });
    // A fresh CSRF token comes with the new session.
    expect(cookieValue(res, "ab_csrf")).toBeTruthy();
    expect(cookieValue(res, "ab_csrf")).not.toBe(CSRF);
  });

  it("is refused outside the sandbox", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX", "false");
    const res = await apiKeySignIn(post("/api/auth/api-key", { api_key: "abk_test_0123456789abcdef" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "sandbox_only" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("relays the API's problem for a bad key and sets no cookie", async () => {
    upstream.mockResolvedValueOnce(
      Response.json(
        {
          title: "Authentication required",
          status: 401,
          code: "unauthorized",
          detail: "Invalid or revoked API key",
        },
        { status: 401 },
      ),
    );
    const res = await apiKeySignIn(post("/api/auth/api-key", { api_key: "abk_test_0123456789abcdef" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized", detail: "Invalid or revoked API key" });
    expect(setCookie(res, "ab_session")).toBeUndefined();
  });

  it("rejects malformed keys without calling the API", async () => {
    const res = await apiKeySignIn(post("/api/auth/api-key", { api_key: "not a key" }));
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("checks the origin of sign-in requests too", async () => {
    const res = await apiKeySignIn(
      post("/api/auth/api-key", { api_key: "abk_test_0123456789abcdef" }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("sandbox sign-up", () => {
  it("creates the org, signs in with the new key and returns the secret once", async () => {
    upstream.mockResolvedValueOnce(
      Response.json(
        {
          org,
          api_key: {
            id: "key_01J9ZQ3W8K7X5V4T3S2R1Q0P9N",
            object: "api_key",
            name: "Default admin key",
            prefix: "abk_test_ab12",
            scopes: ["admin"],
            created_at: org.created_at,
            revoked_at: null,
            secret: "abk_test_brandnewsecret0001",
          },
        },
        { status: 201 },
      ),
    );
    const res = await signUp(
      post("/api/auth/sign-up", {
        legal_name: "Acme Robotics",
        kind: "company",
        country: "US",
        contact_email: "ada@acme.test",
        owner_address: org.owner_address,
        idempotency_key: "signup-0123456789",
      }),
    );
    expect(res.status).toBe(201);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/v1/orgs`);
    expect(new Headers(init.headers).get("idempotency-key")).toBe("signup-0123456789");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("idempotency_key");
    expect(await res.json()).toMatchObject({ api_key: { secret: "abk_test_brandnewsecret0001" } });
    const session = await readPrincipalSession(cookieValue(res, "ab_session"));
    expect(session).toMatchObject({ kind: "api_key", token: "abk_test_brandnewsecret0001" });
  });
});

describe("passkey sign-in", () => {
  it("moves the API's session cookie into the sealed console cookie and never returns it", async () => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ member, org, expires_at: "2026-10-12T00:00:00.000Z" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "agentbank_session=api-session-token-123; Path=/; HttpOnly; SameSite=Strict",
        },
      }),
    );
    const res = await loginVerify(
      post("/api/auth/passkey/login/verify", { challenge_id: "wch_1", response: { id: "cred" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((h) => h.startsWith("agentbank_session="))).toBe(false);
    const text = await res.text();
    expect(text).not.toContain("api-session-token-123");
    expect(JSON.parse(text)).toMatchObject({ member: { email: "ada@acme.test" }, org: { id: ORG_ID } });
    const session = await readPrincipalSession(cookieValue(res, "ab_session"));
    expect(session).toMatchObject({
      kind: "passkey",
      token: "api-session-token-123",
      email: "ada@acme.test",
      role: "admin",
    });
  });

  it("asks the API for an approval challenge with the member's session", async () => {
    upstream.mockResolvedValueOnce(Response.json({ challenge_id: "wch_2", options: { challenge: "abc" } }));
    const cookie = await seal("session", newPrincipalSession("passkey", "api-session-token-123"));
    const res = await approvalOptions(
      post(
        `/api/auth/approvals/${APPROVAL_ID}/options`,
        { decision: "approve" },
        { cookies: { ab_session: cookie } },
      ),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/auth/approvals/${APPROVAL_ID}/options`);
    expect(new Headers(init.headers).get("cookie")).toBe("agentbank_session=api-session-token-123");
    expect(JSON.parse(String(init.body))).toEqual({ decision: "approve" });
  });

  it("parses the API session cookie from Set-Cookie headers", () => {
    const headers = new Headers();
    headers.append("set-cookie", "other=1; Path=/");
    headers.append("set-cookie", "agentbank_session=tok123; Path=/; HttpOnly");
    expect(apiSessionToken(headers)).toBe("tok123");
    expect(apiSessionToken(new Headers())).toBeNull();
  });
});

describe("session and sign-out", () => {
  it("reports the session kind without the credential", async () => {
    const cookie = await seal(
      "session",
      newPrincipalSession("api_key", "abk_test_0123456789abcdef", { orgId: ORG_ID }),
    );
    const req = new NextRequest(`${ORIGIN}/api/auth/session`, {
      headers: { cookie: `ab_session=${cookie}` },
    });
    const res = await sessionInfo(req);
    const body = await res.json();
    expect(body).toMatchObject({ authenticated: true, kind: "api_key", org_id: ORG_ID });
    expect(JSON.stringify(body)).not.toContain("abk_test");
  });

  it("revokes a passkey session upstream and clears the cookie", async () => {
    upstream.mockResolvedValueOnce(Response.json({ ok: true }));
    const cookie = await seal("session", newPrincipalSession("passkey", "api-session-token-123"));
    const res = await signOut(post("/api/auth/sign-out", {}, { cookies: { ab_session: cookie } }));
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/auth/logout`);
    expect(new Headers(init.headers).get("cookie")).toBe("agentbank_session=api-session-token-123");
    expect(setCookie(res, "ab_session")).toMatch(/Max-Age=0/i);
  });
});

describe("staff sign-in", () => {
  it("checks the operator token against the API and seals it in its own cookie", async () => {
    upstream.mockResolvedValueOnce(Response.json({ object: "revenue_report" }));
    const token = "operator-token-0123456789abcdefghij";
    const res = await staffSignIn(post("/api/admin/sign-in", { token }));
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`^${API}/v1/admin/revenue\\?period=\\d{4}-\\d{2}$`));
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(await readStaffSession(cookieValue(res, "ab_staff"))).toMatchObject({ kind: "staff", token });
    // A staff cookie is not a principal session.
    expect(await readPrincipalSession(cookieValue(res, "ab_staff"))).toBeNull();
  });

  it("is unavailable when the staff dashboard is disabled", async () => {
    vi.stubEnv("STAFF_DASHBOARD_ENABLED", "false");
    const res = await staffSignIn(
      post("/api/admin/sign-in", { token: "operator-token-0123456789abcdefghij" }),
    );
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
