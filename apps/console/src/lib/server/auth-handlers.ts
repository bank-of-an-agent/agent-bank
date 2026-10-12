import "server-only";
import { AddressSchema } from "@agentbank/core";
import { CreateOrgRequest, Member, Org } from "@agentbank/core/api";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  cookieNames,
  credentialCookieOptions,
  csrfCookieOptions,
  newCsrfToken,
  SESSION_MAX_AGE_SECONDS,
  STAFF_MAX_AGE_SECONDS,
} from "./cookies";
import { csrfFailure } from "./csrf";
import { ConfigError, serverConfig, type ServerConfig } from "./env";
import { problem, problems } from "./problem";
import {
  API_SESSION_COOKIE,
  newPrincipalSession,
  newStaffSession,
  readPrincipalSession,
  seal,
  upstreamCredential,
  type PrincipalSession,
} from "./session";
import { UpstreamError, upstreamFetch, upstreamJson, type UpstreamJson } from "./upstream";

/**
 * BFF endpoints for signing in and out. They call the API's console auth
 * routes (`/auth/*`, WebAuthn) and v1 routes server-side, and turn whatever
 * credential comes back into the console's sealed httpOnly cookie. No
 * credential is ever returned to the browser, except the one-time API key
 * shown once after sandbox sign-up.
 */

type Handler = (request: NextRequest, cfg: ServerConfig) => Promise<NextResponse>;

/** Common wrapper: configuration, CSRF and upstream failures. */
export function authRoute(handler: Handler) {
  return async (request: NextRequest): Promise<NextResponse> => {
    let cfg: ServerConfig;
    try {
      cfg = serverConfig();
    } catch (error) {
      if (error instanceof ConfigError) return problems.misconfigured(error.message);
      throw error;
    }
    const csrf = csrfFailure(request, { allowedOrigins: cfg.allowedOrigins, secure: cfg.secureCookies });
    if (csrf) return problems.csrf(csrf);
    try {
      return await handler(request, cfg);
    } catch (error) {
      if (error instanceof UpstreamError) {
        return error.kind === "timeout" ? problems.timeout() : problems.unreachable();
      }
      if (error instanceof ConfigError) return problems.misconfigured(error.message);
      throw error;
    }
  };
}

async function readJson<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
): Promise<z.output<T> | NextResponse> {
  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > 65_536) return problems.tooLarge();
    raw = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return problems.invalid("The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    }));
    return problems.invalid(
      errors[0] ? `${errors[0].path || "body"}: ${errors[0].message}` : "Invalid body",
      {
        errors,
      },
    );
  }
  return parsed.data;
}

/** Relay an upstream problem (or any non-2xx) to the browser unchanged. */
function relay(result: UpstreamJson): NextResponse {
  const body = result.body ?? {
    type: "urn:agentbank:problem:internal",
    title: "Unexpected response",
    status: result.status,
    code: "internal",
  };
  return new NextResponse(JSON.stringify(body), {
    status: result.status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
  });
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function setPrincipalCookie(response: NextResponse, cfg: ServerConfig, session: PrincipalSession) {
  const names = cookieNames(cfg.secureCookies);
  const maxAge = Math.max(60, Math.min(SESSION_MAX_AGE_SECONDS, session.exp - Math.floor(Date.now() / 1000)));
  response.cookies.set(
    names.session,
    await seal("session", session),
    credentialCookieOptions(maxAge, cfg.secureCookies),
  );
  // A new session gets a new CSRF token.
  response.cookies.set(names.csrf, newCsrfToken(), csrfCookieOptions(cfg.secureCookies));
}

async function currentSession(request: NextRequest, cfg: ServerConfig): Promise<PrincipalSession | null> {
  return readPrincipalSession(request.cookies.get(cookieNames(cfg.secureCookies).session)?.value);
}

/** The value of the API's `agentbank_session` cookie in a Set-Cookie response. */
export function apiSessionToken(headers: Headers): string | null {
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const all =
    cookies.length > 0 ? cookies : (headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  for (const cookie of all) {
    const [pair] = cookie.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (!pair || index < 0) continue;
    if (pair.slice(0, index).trim() === API_SESSION_COOKIE) {
      const value = pair.slice(index + 1).trim();
      return value || null;
    }
  }
  return null;
}

const SessionView = z.object({ member: Member, org: Org, expires_at: z.string() });

/** Finish a passkey sign-in or registration: keep the API session in our sealed cookie. */
async function completePasskeySession(result: UpstreamJson, cfg: ServerConfig): Promise<NextResponse> {
  if (!result.ok) return relay(result);
  const token = apiSessionToken(result.headers);
  const view = SessionView.safeParse(result.body);
  if (!token || !view.success) {
    return problem(
      502,
      "api_unexpected_response",
      "Unexpected sign-in response",
      "The API did not return a session.",
    );
  }
  const expiresAt = Math.floor(new Date(view.data.expires_at).getTime() / 1000);
  const session = newPrincipalSession("passkey", token, {
    orgId: view.data.org.id,
    email: view.data.member.email,
    role: view.data.member.role,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
  });
  const response = json(
    { member: view.data.member, org: view.data.org, expires_at: view.data.expires_at },
    result.status,
  );
  await setPrincipalCookie(response, cfg, session);
  return response;
}

// ---------------------------------------------------------------- passkeys

const LoginOptionsBody = z.object({ email: z.email().optional() }).strict();
const VerifyBody = z
  .object({ challenge_id: z.string().min(1).max(100), response: z.record(z.string(), z.unknown()) })
  .strict();
const RegisterOptionsBody = z.object({ invite_token: z.string().min(16).max(200).optional() }).strict();
const ApprovalOptionsBody = z.object({ decision: z.enum(["approve", "deny"]) }).strict();

export const passkeyLoginOptions = authRoute(async (request, cfg) => {
  const body = await readJson(request, LoginOptionsBody);
  if (body instanceof NextResponse) return body;
  const result = await upstreamJson(cfg.apiUrl, "/auth/passkeys/login/options", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result.ok ? json(result.body) : relay(result);
});

export const passkeyLoginVerify = authRoute(async (request, cfg) => {
  const body = await readJson(request, VerifyBody);
  if (body instanceof NextResponse) return body;
  const result = await upstreamJson(cfg.apiUrl, "/auth/passkeys/login/verify", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return completePasskeySession(result, cfg);
});

export const passkeyRegisterOptions = authRoute(async (request, cfg) => {
  const body = await readJson(request, RegisterOptionsBody);
  if (body instanceof NextResponse) return body;
  const session = await currentSession(request, cfg);
  if (!body.invite_token && !session) return problems.unauthorized();
  const result = await upstreamJson(cfg.apiUrl, "/auth/passkeys/register/options", {
    method: "POST",
    body: JSON.stringify(body),
    headers: body.invite_token || !session ? {} : upstreamCredential(session),
  });
  return result.ok ? json(result.body) : relay(result);
});

export const passkeyRegisterVerify = authRoute(async (request, cfg) => {
  const body = await readJson(request, VerifyBody);
  if (body instanceof NextResponse) return body;
  const result = await upstreamJson(cfg.apiUrl, "/auth/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return completePasskeySession(result, cfg);
});

/** A passkey challenge bound to one approval and one decision. */
export function approvalOptions(approvalId: string) {
  return authRoute(async (request, cfg) => {
    if (!/^apr_[0-9A-HJKMNP-TV-Z]{26}$/.test(approvalId)) return problems.invalid("Invalid approval id.");
    const body = await readJson(request, ApprovalOptionsBody);
    if (body instanceof NextResponse) return body;
    const session = await currentSession(request, cfg);
    if (!session) return problems.unauthorized();
    const result = await upstreamJson(
      cfg.apiUrl,
      `/auth/approvals/${encodeURIComponent(approvalId)}/options`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: upstreamCredential(session),
      },
    );
    return result.ok ? json(result.body) : relay(result);
  });
}

/** One-time invite token that lets a member register their first passkey. */
export function memberInvite(memberId: string) {
  return authRoute(async (request, cfg) => {
    if (!/^mem_[0-9A-HJKMNP-TV-Z]{26}$/.test(memberId)) return problems.invalid("Invalid member id.");
    const session = await currentSession(request, cfg);
    if (!session) return problems.unauthorized();
    const result = await upstreamJson(cfg.apiUrl, `/auth/members/${encodeURIComponent(memberId)}/invite`, {
      method: "POST",
      body: "{}",
      headers: upstreamCredential(session),
    });
    return result.ok ? json(result.body, result.status) : relay(result);
  });
}

// ---------------------------------------------------------------- sandbox: API key and sign-up

const ApiKeyBody = z
  .object({
    api_key: z
      .string()
      .trim()
      .min(16, "That does not look like an Agent Bank API key")
      .max(200)
      .regex(/^abk_[A-Za-z0-9_-]+$/, "Agent Bank API keys start with abk_"),
  })
  .strict();

export const signInWithApiKey = authRoute(async (request, cfg) => {
  if (!cfg.sandbox) return problems.sandboxOnly();
  const body = await readJson(request, ApiKeyBody);
  if (body instanceof NextResponse) return body;
  const result = await upstreamJson(cfg.apiUrl, "/v1/orgs/me", {
    method: "GET",
    headers: { authorization: `Bearer ${body.api_key}` },
  });
  if (!result.ok) return relay(result);
  const org = Org.safeParse(result.body);
  if (!org.success)
    return problem(502, "api_unexpected_response", "Unexpected response", "The API did not return an org.");
  const response = json({ org: org.data });
  await setPrincipalCookie(
    response,
    cfg,
    newPrincipalSession("api_key", body.api_key, { orgId: org.data.id }),
  );
  return response;
});

const SignUpBody = CreateOrgRequest.extend({
  owner_address: AddressSchema,
  idempotency_key: z.string().min(8).max(100).optional(),
}).strict();

export const signUp = authRoute(async (request, cfg) => {
  if (!cfg.sandbox) return problems.sandboxOnly();
  const body = await readJson(request, SignUpBody);
  if (body instanceof NextResponse) return body;
  const { idempotency_key, ...org } = body;
  const result = await upstreamJson(cfg.apiUrl, "/v1/orgs", {
    method: "POST",
    body: JSON.stringify(org),
    headers: { "idempotency-key": idempotency_key ?? crypto.randomUUID() },
  });
  if (!result.ok) return relay(result);
  const created = z
    .object({ org: Org, api_key: z.object({ secret: z.string() }).loose() })
    .safeParse(result.body);
  if (!created.success) {
    return problem(
      502,
      "api_unexpected_response",
      "Unexpected response",
      "The API did not return the new org.",
    );
  }
  // The secret goes back once so the user can store it; the console keeps it only in the sealed cookie.
  const response = json(result.body, 201);
  await setPrincipalCookie(
    response,
    cfg,
    newPrincipalSession("api_key", created.data.api_key.secret, { orgId: created.data.org.id }),
  );
  return response;
});

// ---------------------------------------------------------------- session and sign-out

export async function sessionInfo(request: NextRequest): Promise<NextResponse> {
  let cfg: ServerConfig;
  try {
    cfg = serverConfig();
  } catch (error) {
    if (error instanceof ConfigError) return problems.misconfigured(error.message);
    throw error;
  }
  let session: PrincipalSession | null;
  try {
    session = await currentSession(request, cfg);
  } catch (error) {
    if (error instanceof ConfigError) return problems.misconfigured(error.message);
    throw error;
  }
  if (!session) return json({ authenticated: false });
  return json({
    authenticated: true,
    kind: session.kind,
    email: session.email ?? null,
    role: session.role ?? null,
    org_id: session.orgId ?? null,
    expires_at: new Date(session.exp * 1000).toISOString(),
  });
}

export const signOut = authRoute(async (request, cfg) => {
  const names = cookieNames(cfg.secureCookies);
  const session = await currentSession(request, cfg);
  if (session?.kind === "passkey") {
    try {
      await upstreamFetch(cfg.apiUrl, "/auth/logout", {
        method: "POST",
        headers: { ...upstreamCredential(session), "content-type": "application/json" },
        body: "{}",
        timeoutMs: 5_000,
      });
    } catch {
      // Revocation failed upstream; the session still expires on its own. Clear ours regardless.
    }
  }
  const response = json({ ok: true });
  response.cookies.set(names.session, "", credentialCookieOptions(0, cfg.secureCookies));
  response.cookies.set(names.csrf, newCsrfToken(), csrfCookieOptions(cfg.secureCookies));
  return response;
});

// ---------------------------------------------------------------- staff

const StaffBody = z
  .object({ token: z.string().trim().min(32, "Operator tokens are at least 32 characters").max(512) })
  .strict();

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const staffSignIn = authRoute(async (request, cfg) => {
  if (!cfg.staffDashboard)
    return problems.notAvailable("The staff dashboard is disabled on this deployment.");
  const body = await readJson(request, StaffBody);
  if (body instanceof NextResponse) return body;
  const result = await upstreamJson(cfg.apiUrl, `/v1/admin/revenue?period=${currentPeriod()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${body.token}` },
  });
  if (!result.ok) return relay(result);
  const response = json({ ok: true });
  const names = cookieNames(cfg.secureCookies);
  response.cookies.set(
    names.staff,
    await seal("staff", newStaffSession(body.token)),
    credentialCookieOptions(STAFF_MAX_AGE_SECONDS, cfg.secureCookies),
  );
  return response;
});

export const staffSignOut = authRoute(async (_request, cfg) => {
  const response = json({ ok: true });
  response.cookies.set(
    cookieNames(cfg.secureCookies).staff,
    "",
    credentialCookieOptions(0, cfg.secureCookies),
  );
  return response;
});
