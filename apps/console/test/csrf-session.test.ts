/** @vitest-environment node */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieNames } from "@/lib/server/cookies";
import { csrfFailure } from "@/lib/server/csrf";
import {
  newPrincipalSession,
  readPrincipalSession,
  readStaffSession,
  seal,
  unseal,
} from "@/lib/server/session";

const TOKEN = "csrf-token-0123456789abcdefghijklmnop";

function write(url: string, headers: Record<string, string>, csrfCookie: string | null = TOKEN) {
  const h = new Headers(headers);
  if (csrfCookie) h.set("cookie", `ab_csrf=${csrfCookie}`);
  return new NextRequest(url, { method: "POST", headers: h, body: "{}" });
}

describe("csrfFailure", () => {
  const options = { allowedOrigins: [] as string[], secure: false };

  it("lets safe methods through", () => {
    expect(csrfFailure(new NextRequest("http://console.test/api/v1/agents"), options)).toBeNull();
  });

  it("accepts the request's own host when no CONSOLE_ORIGIN is configured", () => {
    const req = write("http://console.test/api/x", {
      origin: "http://console.test",
      host: "console.test",
      "x-csrf-token": TOKEN,
    });
    expect(csrfFailure(req, options)).toBeNull();
  });

  it("accepts the forwarded host behind a proxy", () => {
    const req = write("http://10.0.0.5:3000/api/x", {
      origin: "https://console.example.com",
      host: "10.0.0.5:3000",
      "x-forwarded-host": "console.example.com",
      "x-csrf-token": TOKEN,
    });
    expect(csrfFailure(req, options)).toBeNull();
  });

  it("enforces CONSOLE_ORIGIN exactly when configured", () => {
    const strict = { allowedOrigins: ["https://console.example.com"], secure: false };
    const ok = write("https://console.example.com/api/x", {
      origin: "https://console.example.com",
      "x-csrf-token": TOKEN,
    });
    expect(csrfFailure(ok, strict)).toBeNull();
    const http = write("https://console.example.com/api/x", {
      origin: "http://console.example.com",
      "x-csrf-token": TOKEN,
    });
    expect(csrfFailure(http, strict)).toMatch(/Cross-origin/);
  });

  it("rejects opaque and foreign origins", () => {
    expect(
      csrfFailure(write("http://console.test/api/x", { origin: "null", "x-csrf-token": TOKEN }), options),
    ).toMatch(/opaque/);
    expect(
      csrfFailure(
        write("http://console.test/api/x", {
          origin: "http://console.test.evil.example",
          host: "console.test",
          "x-csrf-token": TOKEN,
        }),
        options,
      ),
    ).toMatch(/Cross-origin/);
  });

  it("falls back to Sec-Fetch-Site, then Referer, when Origin is missing", () => {
    expect(
      csrfFailure(
        write("http://console.test/api/x", { "sec-fetch-site": "cross-site", "x-csrf-token": TOKEN }),
        options,
      ),
    ).toMatch(/cross-site/);
    expect(
      csrfFailure(
        write("http://console.test/api/x", {
          referer: "http://console.test/agents",
          host: "console.test",
          "x-csrf-token": TOKEN,
        }),
        options,
      ),
    ).toBeNull();
    expect(csrfFailure(write("http://console.test/api/x", { "x-csrf-token": TOKEN }), options)).toMatch(
      /Missing Origin/,
    );
  });

  it("requires the double-submit token to match the cookie", () => {
    const base = { origin: "http://console.test", host: "console.test" };
    expect(csrfFailure(write("http://console.test/api/x", base), options)).toMatch(/Missing CSRF/);
    expect(
      csrfFailure(write("http://console.test/api/x", { ...base, "x-csrf-token": TOKEN }, null), options),
    ).toMatch(/Missing CSRF/);
    expect(
      csrfFailure(write("http://console.test/api/x", { ...base, "x-csrf-token": `${TOKEN}0` }), options),
    ).toMatch(/mismatch/);
  });
});

describe("sealed sessions", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CONSOLE_SESSION_SECRET", "k".repeat(48));
    vi.stubEnv("NEXT_PUBLIC_SANDBOX", "true");
  });

  it("round-trips and hides the credential", async () => {
    const sealed = await seal("session", newPrincipalSession("api_key", "abk_test_0123456789abcdef"));
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("abk_test");
    expect(await readPrincipalSession(sealed)).toMatchObject({
      kind: "api_key",
      token: "abk_test_0123456789abcdef",
    });
  });

  it("fails closed on tampering, another purpose or another secret", async () => {
    const sealed = await seal("session", newPrincipalSession("passkey", "tok"));
    const parts = sealed.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${(parts[2] ?? "").slice(0, -2)}AA`;
    expect(await unseal("session", flipped)).toBeNull();
    expect(await readStaffSession(sealed)).toBeNull();
    vi.stubEnv("CONSOLE_SESSION_SECRET", "z".repeat(48));
    expect(await readPrincipalSession(sealed)).toBeNull();
  });

  it("expires sessions and caps them at 12 hours", async () => {
    const now = Math.floor(Date.now() / 1000);
    const long = newPrincipalSession("passkey", "tok", { expiresAt: now + 7 * 86_400 });
    expect(long.exp - long.iat).toBe(12 * 3600);
    const expired = { ...newPrincipalSession("passkey", "tok"), exp: now - 1 };
    expect(await readPrincipalSession(await seal("session", expired))).toBeNull();
  });

  it("requires a strong secret in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONSOLE_SESSION_SECRET", "");
    await expect(seal("session", { v: 1 })).rejects.toThrow(/CONSOLE_SESSION_SECRET/);
    vi.stubEnv("CONSOLE_SESSION_SECRET", "short");
    await expect(seal("session", { v: 1 })).rejects.toThrow(/at least 32/);
  });

  it("uses __Host- cookie names when cookies are Secure", () => {
    expect(cookieNames(true)).toEqual({
      session: "__Host-ab_session",
      staff: "__Host-ab_staff",
      csrf: "__Host-ab_csrf",
    });
    expect(cookieNames(false).session).toBe("ab_session");
  });
});
