import "server-only";
import { SESSION_MAX_AGE_SECONDS, STAFF_MAX_AGE_SECONDS } from "./cookies";
import { serverConfig, sessionSecret } from "./env";

/**
 * Console sessions live only in httpOnly, SameSite=Lax cookies, sealed with
 * AES-256-GCM under a key derived (HKDF-SHA-256) from
 * `CONSOLE_SESSION_SECRET`. The browser never sees the credential: not the
 * API key pasted in sandbox mode, not the API session issued after a passkey
 * sign-in, not the staff operator token. The BFF unseals the cookie and sends
 * the credential upstream (see `upstreamCredential`).
 */

export type CredentialKind = "api_key" | "passkey";

export interface PrincipalSession {
  v: 1;
  kind: CredentialKind;
  /** The org API key (`abk_test_…`) or the API's console session token. */
  token: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
  orgId?: string;
  email?: string;
  role?: string;
}

export interface StaffSession {
  v: 1;
  kind: "staff";
  token: string;
  iat: number;
  exp: number;
}

type Purpose = "session" | "staff";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function deriveKey(purpose: Purpose): Promise<CryptoKey> {
  const secret = sessionSecret();
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]).then((base) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode("agentbank-console/v1"),
          info: encoder.encode(purpose),
        },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
    keyCache.set(cacheKey, key);
  }
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function seal(purpose: Purpose, payload: object): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    await deriveKey(purpose),
    encoder.encode(JSON.stringify(payload)),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Open a sealed value; `null` for anything forged, truncated or sealed for another purpose. */
export async function unseal(purpose: Purpose, value: string | undefined | null): Promise<unknown> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  // A missing or weak secret is a configuration error, not a bad cookie: let it surface.
  const key = await deriveKey(purpose);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(parts[1] ?? ""), additionalData: encoder.encode(purpose) },
      key,
      fromBase64Url(parts[2] ?? ""),
    );
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function readPrincipalSession(
  value: string | undefined | null,
): Promise<PrincipalSession | null> {
  const data = await unseal("session", value);
  if (!isRecord(data) || data.v !== 1) return null;
  if (data.kind !== "api_key" && data.kind !== "passkey") return null;
  if (typeof data.token !== "string" || typeof data.exp !== "number" || data.exp <= nowSeconds()) return null;
  // API-key sign-in exists only in sandbox; a deployment that turns sandbox off drops those sessions.
  if (data.kind === "api_key" && !serverConfig().sandbox) return null;
  return data as unknown as PrincipalSession;
}

export async function readStaffSession(value: string | undefined | null): Promise<StaffSession | null> {
  const data = await unseal("staff", value);
  if (!isRecord(data) || data.v !== 1 || data.kind !== "staff") return null;
  if (typeof data.token !== "string" || typeof data.exp !== "number" || data.exp <= nowSeconds()) return null;
  return data as unknown as StaffSession;
}

export function newPrincipalSession(
  kind: CredentialKind,
  token: string,
  extra: Partial<Pick<PrincipalSession, "orgId" | "email" | "role">> & { expiresAt?: number } = {},
): PrincipalSession {
  const iat = nowSeconds();
  const cap = iat + SESSION_MAX_AGE_SECONDS;
  const exp = extra.expiresAt && extra.expiresAt > iat ? Math.min(extra.expiresAt, cap) : cap;
  const session: PrincipalSession = { v: 1, kind, token, iat, exp };
  if (extra.orgId) session.orgId = extra.orgId;
  if (extra.email) session.email = extra.email;
  if (extra.role) session.role = extra.role;
  return session;
}

export function newStaffSession(token: string): StaffSession {
  const iat = nowSeconds();
  return { v: 1, kind: "staff", token, iat, exp: iat + STAFF_MAX_AGE_SECONDS };
}

/** Name of the API's console session cookie (apps/api `SESSION_COOKIE`). */
export const API_SESSION_COOKIE = "agentbank_session";

/**
 * How a principal credential travels to the API: org API keys as
 * `Authorization: Bearer`, passkey console sessions as the API's own session
 * cookie (the API treats every bearer token as an API key).
 */
export function upstreamCredential(session: PrincipalSession): Record<string, string> {
  return session.kind === "api_key"
    ? { authorization: `Bearer ${session.token}` }
    : { cookie: `${API_SESSION_COOKIE}=${session.token}` };
}
