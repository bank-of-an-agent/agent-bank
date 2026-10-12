/** @vitest-environment node */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialFor, matchRoute } from "@/lib/server/api-routes";
import { proxy } from "@/proxy";
import { routes } from "@agentbank/core/api";

function page(path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookie) h.set("cookie", cookie);
  return new NextRequest(`http://console.test${path}`, { headers: h });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("COOKIE_SECURE", "false");
});

describe("proxy (CSP, CSRF cookie, sign-in redirect)", () => {
  it("sends console pages without a session to sign-in, keeping where they were going", () => {
    const res = proxy(page("/payments?status=denied"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://console.test/sign-in?next=%2Fpayments%3Fstatus%3Ddenied",
    );
  });

  it("sends the staff area to the staff sign-in", () => {
    const res = proxy(page("/admin/revenue", { ab_session: "principal-only" }));
    expect(res.headers.get("location")).toBe("http://console.test/admin/sign-in?next=%2Fadmin%2Frevenue");
  });

  it("serves public pages with a strict, per-request nonce CSP and a CSRF cookie", () => {
    const a = proxy(page("/sign-in"));
    const b = proxy(page("/sign-in"));
    const csp = a.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(b.headers.get("content-security-policy")).not.toBe(csp);
    const cookie = a.headers.getSetCookie().find((c) => c.startsWith("ab_csrf="));
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).not.toMatch(/HttpOnly/i);
  });

  it("passes the nonce to the renderer and keeps an existing CSRF cookie", () => {
    const res = proxy(page("/", { ab_session: "sealed", ab_csrf: "existing" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(res.headers.getSetCookie().some((c) => c.startsWith("ab_csrf="))).toBe(false);
  });

  it("upgrades insecure requests only behind HTTPS", () => {
    const https = proxy(page("/sign-in", {}, { "x-forwarded-proto": "https" }));
    expect(https.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
    expect(proxy(page("/sign-in")).headers.get("content-security-policy")).not.toContain(
      "upgrade-insecure-requests",
    );
  });
});

describe("BFF route allowlist", () => {
  it("exposes principal and staff routes, never agent-only or facilitator routes", () => {
    expect(credentialFor(routes.listAgents)).toBe("principal");
    expect(credentialFor(routes.decideApproval)).toBe("principal");
    expect(credentialFor(routes.getRevenueReport)).toBe("staff");
    expect(credentialFor(routes.listPlans)).toBe("none");
    expect(credentialFor(routes.createPayment)).toBeNull();
    expect(credentialFor(routes.submitPaymentSignature)).toBeNull();
    expect(credentialFor(routes.x402Settle)).toBeNull();
    // Sign-up has its own handler that stores the new key in the sealed cookie.
    expect(credentialFor(routes.createOrg)).toBeNull();
  });

  it("matches paths with parameters by method", () => {
    const agent = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
    expect(matchRoute("POST", `/v1/agents/${agent}/freeze`)).toMatchObject({
      def: { operationId: "freezeAgent" },
      params: { id: agent },
    });
    expect(matchRoute("GET", `/v1/agents/${agent}/policy`)?.def.operationId).toBe("getPolicy");
    expect(matchRoute("PUT", `/v1/agents/${agent}/policy`)?.def.operationId).toBe("putPolicy");
    expect(matchRoute("DELETE", `/v1/agents/${agent}`)).toBeNull();
  });
});
