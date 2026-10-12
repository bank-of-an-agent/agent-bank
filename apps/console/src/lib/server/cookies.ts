/**
 * Cookie names and attributes shared by `src/proxy.ts` and the route
 * handlers. Kept free of `server-only` and of secrets so the proxy bundle
 * stays small; sealing lives in `session.ts`.
 */

export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const STAFF_MAX_AGE_SECONDS = 8 * 60 * 60;
export const CSRF_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Header the browser echoes the CSRF cookie in (double-submit). */
export const CSRF_HEADER = "x-csrf-token";

function envFlag(name: string): boolean | undefined {
  const env = process.env;
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value);
}

/** `Secure` cookies by default in production; `COOKIE_SECURE` overrides (e.g. http://localhost). */
export function secureCookies(): boolean {
  const env = process.env;
  return envFlag("COOKIE_SECURE") ?? env.NODE_ENV === "production";
}

export interface CookieNames {
  session: string;
  staff: string;
  csrf: string;
}

/** `__Host-` cookies require `Secure`, so plain names are used for http://localhost development. */
export function cookieNames(secure: boolean = secureCookies()): CookieNames {
  const prefix = secure ? "__Host-" : "";
  return { session: `${prefix}ab_session`, staff: `${prefix}ab_staff`, csrf: `${prefix}ab_csrf` };
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict";
  path: "/";
  maxAge: number;
}

export function credentialCookieOptions(maxAge: number, secure: boolean = secureCookies()): CookieOptions {
  return { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge };
}

/** The CSRF token must be readable by same-origin script to be echoed in a header. */
export function csrfCookieOptions(secure: boolean = secureCookies()): CookieOptions {
  return { httpOnly: false, secure, sameSite: "strict", path: "/", maxAge: CSRF_MAX_AGE_SECONDS };
}

export function newCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
