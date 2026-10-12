import type { NextRequest } from "next/server";
import { CSRF_HEADER, cookieNames } from "./cookies";

/**
 * CSRF protection for mutating BFF routes, in two independent layers on top
 * of SameSite=Lax credential cookies:
 *
 * 1. **Origin check.** The `Origin` header (or, when a browser omits it,
 *    `Sec-Fetch-Site` / `Referer`) must be the console's own origin:
 *    `CONSOLE_ORIGIN` when configured, otherwise the request's own host.
 * 2. **Double-submit token.** The `x-csrf-token` header must equal the
 *    `ab_csrf` cookie, which only same-origin script can read.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfOptions {
  /** Exact origins allowed to mutate; empty means "same host as the request". */
  allowedOrigins: readonly string[];
  secure: boolean;
}

function requestHosts(request: NextRequest): string[] {
  const hosts: string[] = [];
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded) hosts.push(forwarded.toLowerCase());
  const host = request.headers.get("host")?.trim();
  if (host) hosts.push(host.toLowerCase());
  return hosts;
}

function originAllowed(origin: string, request: NextRequest, allowed: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.length > 0) return allowed.includes(parsed.origin);
  return requestHosts(request).includes(parsed.host.toLowerCase());
}

function originFailure(request: NextRequest, allowed: readonly string[]): string | null {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin === "null") return "Requests from an opaque origin are not accepted.";
    return originAllowed(origin, request, allowed) ? null : `Cross-origin request from ${origin} rejected.`;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    return site === "same-origin" ? null : `Cross-site request (${site}) rejected.`;
  }
  const referer = request.headers.get("referer");
  if (referer) {
    return originAllowed(referer, request, allowed) ? null : "Cross-origin Referer rejected.";
  }
  return "Missing Origin header.";
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns why the request fails CSRF checks, or `null` when it passes (or is a safe method). */
export function csrfFailure(request: NextRequest, options: CsrfOptions): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const origin = originFailure(request, options.allowedOrigins);
  if (origin) return origin;
  const header = request.headers.get(CSRF_HEADER);
  const cookie = request.cookies.get(cookieNames(options.secure).csrf)?.value;
  if (!header || !cookie) return "Missing CSRF token. Reload the page and try again.";
  if (!constantTimeEqual(header, cookie)) return "CSRF token mismatch. Reload the page and try again.";
  return null;
}
