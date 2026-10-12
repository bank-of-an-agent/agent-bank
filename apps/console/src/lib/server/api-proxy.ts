import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { allowedQueryKeys, matchRoute, pathKnown } from "./api-routes";
import { cookieNames, credentialCookieOptions } from "./cookies";
import { csrfFailure } from "./csrf";
import { ConfigError, serverConfig, type ServerConfig } from "./env";
import { problem, problems } from "./problem";
import { readPrincipalSession, readStaffSession, upstreamCredential } from "./session";
import { problemCode, UpstreamError, upstreamFetch } from "./upstream";

/**
 * The BFF proxy: `/api/v1/*` → `${AGENTBANK_API_URL}/v1/*`.
 *
 * - Only allowlisted routes from the core route registry are forwarded.
 * - Mutating requests must pass the CSRF checks (Origin + double-submit token).
 * - The credential comes from the sealed httpOnly cookie: an org API key goes
 *   upstream as `Authorization: Bearer …`, a passkey session as the API's own
 *   `agentbank_session` cookie, a staff token as `Authorization: Bearer …` on
 *   staff routes only. The console's own cookies are never forwarded.
 * - Only a small set of response headers comes back; `Set-Cookie` never does.
 */

export const MAX_BODY_BYTES = 1_048_576;

const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "retry-after",
  "x-request-id",
  "idempotent-replayed",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
/** Routes a production console never forwards, whatever the API's own checks. */
const SANDBOX_ONLY = new Set<string>(["sandboxFaucet"]);
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function configOrProblem(): ServerConfig | NextResponse {
  try {
    return serverConfig();
  } catch (error) {
    if (error instanceof ConfigError) return problems.misconfigured(error.message);
    throw error;
  }
}

export async function handleApiProxy(request: NextRequest, segments: readonly string[]): Promise<Response> {
  try {
    return await proxy(request, segments);
  } catch (error) {
    if (error instanceof ConfigError) return problems.misconfigured(error.message);
    throw error;
  }
}

async function proxy(request: NextRequest, segments: readonly string[]): Promise<Response> {
  const cfg = configOrProblem();
  if (cfg instanceof NextResponse) return cfg;

  const csrf = csrfFailure(request, { allowedOrigins: cfg.allowedOrigins, secure: cfg.secureCookies });
  if (csrf) return problems.csrf(csrf);

  if (segments.length === 0 || segments.some((s) => !SAFE_SEGMENT.test(s) || s === "." || s === "..")) {
    return problems.notAvailable();
  }
  const path = `/${segments.join("/")}`;
  const matched = matchRoute(request.method, path);
  if (!matched) {
    return pathKnown(path)
      ? problem(405, "method_not_allowed", "Method not allowed", `${request.method} is not supported here.`)
      : problems.notAvailable();
  }
  if (matched.def.params && !matched.def.params.safeParse(matched.params).success) {
    return problems.invalid("The identifier in the path is not valid.");
  }
  if (SANDBOX_ONLY.has(matched.def.operationId) && !cfg.sandbox) {
    return problems.sandboxOnly("Test USDC is only available from a sandbox console.");
  }

  const names = cookieNames(cfg.secureCookies);
  let credential: Record<string, string> | null = null;
  if (matched.credential === "staff") {
    if (!cfg.staffDashboard) return problems.notAvailable();
    const staff = await readStaffSession(request.cookies.get(names.staff)?.value);
    if (!staff) return problems.staffUnauthorized();
    credential = { authorization: `Bearer ${staff.token}` };
  } else {
    const session = await readPrincipalSession(request.cookies.get(names.session)?.value);
    if (matched.credential === "principal" && !session) return problems.unauthorized();
    if (session) credential = upstreamCredential(session);
  }

  const allowed = allowedQueryKeys(matched.def);
  const query = new URLSearchParams();
  for (const [key, value] of request.nextUrl.searchParams) {
    if (allowed.has(key)) query.append(key, value);
  }
  const search = query.toString();

  const headers: Record<string, string> = {
    accept: request.headers.get("accept") ?? "application/json",
    "x-request-id": crypto.randomUUID(),
  };
  if (credential) Object.assign(headers, credential);
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  if (matched.def.idempotent) {
    const key = request.headers.get("idempotency-key");
    if (key !== null && !IDEMPOTENCY_KEY.test(key))
      return problems.invalid("Invalid Idempotency-Key header.");
    headers["idempotency-key"] = key ?? crypto.randomUUID();
  }

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return problems.tooLarge();
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return problems.tooLarge();
    if (text.length > 0) {
      if (!/^application\/(problem\+)?json\b/i.test(request.headers.get("content-type") ?? "")) {
        return problems.unsupportedMedia();
      }
      try {
        JSON.parse(text);
      } catch {
        return problems.invalid("The request body is not valid JSON.");
      }
      headers["content-type"] = "application/json";
      body = text;
    }
  }

  let upstream: Response;
  try {
    upstream = await upstreamFetch(cfg.apiUrl, `${encodePath(segments)}${search ? `?${search}` : ""}`, {
      method: request.method,
      headers,
      body,
      timeoutMs: matched.def.operationId === "getStatement" ? 60_000 : 30_000,
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      return error.kind === "timeout" ? problems.timeout() : problems.unreachable();
    }
    throw error;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return problem(
      502,
      "api_unexpected_redirect",
      "Unexpected redirect",
      "The API answered with a redirect.",
    );
  }

  const responseHeaders = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  if (upstream.status === 401 && credential) {
    // An expired or revoked credential: drop the cookie so the next navigation signs in again.
    const text = await upstream.text();
    const response = new NextResponse(text, { status: 401, headers: responseHeaders });
    if (problemCode(parseJson(text)) === "unauthorized") {
      const name = matched.credential === "staff" ? names.staff : names.session;
      response.cookies.set(name, "", credentialCookieOptions(0, cfg.secureCookies));
    }
    return response;
  }

  const nullBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new NextResponse(nullBody ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function encodePath(segments: readonly string[]): string {
  return `/${segments.map((s) => encodeURIComponent(s)).join("/")}`;
}
