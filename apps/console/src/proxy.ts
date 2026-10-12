import { NextResponse, type NextRequest } from "next/server";
import { cookieNames, csrfCookieOptions, newCsrfToken, secureCookies } from "./lib/server/cookies";

/**
 * Runs before every page render:
 * - a per-request CSP nonce (strict CSP: no inline script without the nonce),
 * - the double-submit CSRF cookie the BFF checks on every write,
 * - an optimistic redirect to sign-in when the session cookie is missing
 *   (layouts and route handlers still verify the sealed cookie themselves).
 */

const PUBLIC_PAGES = new Set(["/sign-in", "/sign-up", "/invite", "/admin/sign-in"]);

function contentSecurityPolicy(nonce: string, dev: boolean, https: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function safeNext(pathname: string, search: string): string {
  const target = `${pathname}${search}`;
  return target.startsWith("/") && !target.startsWith("//") ? target : "/";
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const names = cookieNames(secureCookies());

  if (!PUBLIC_PAGES.has(pathname)) {
    const staffArea = pathname === "/admin" || pathname.startsWith("/admin/");
    const cookie = staffArea ? names.staff : names.session;
    if (!request.cookies.has(cookie)) {
      const url = request.nextUrl.clone();
      url.pathname = staffArea ? "/admin/sign-in" : "/sign-in";
      url.search = `?next=${encodeURIComponent(safeNext(pathname, search))}`;
      return NextResponse.redirect(url);
    }
  }

  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === "development";
  const https =
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto")?.split(",")[0] === "https";
  const csp = contentSecurityPolicy(nonce, dev, https);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  if (!request.cookies.has(names.csrf)) {
    response.cookies.set(names.csrf, newCsrfToken(), csrfCookieOptions());
  }
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|healthz|mark\\.svg|favicon\\.ico|icon\\.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
