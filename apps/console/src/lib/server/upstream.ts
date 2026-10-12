import "server-only";

/** Calls from the console server to `AGENTBANK_API_URL`. The browser never talks to the API directly. */

export const CONSOLE_USER_AGENT = "agentbank-console/0.1.0";
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export class UpstreamError extends Error {
  constructor(readonly kind: "unreachable" | "timeout") {
    super(kind === "timeout" ? "The Agent Bank API timed out" : "The Agent Bank API is unreachable");
    this.name = "UpstreamError";
  }
}

export interface UpstreamInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** `apiUrl` has no trailing slash; `pathAndQuery` starts with `/`. */
export async function upstreamFetch(
  apiUrl: string,
  pathAndQuery: string,
  init: UpstreamInit,
): Promise<Response> {
  try {
    return await fetch(`${apiUrl}${pathAndQuery}`, {
      method: init.method,
      headers: { "user-agent": CONSOLE_USER_AGENT, ...init.headers },
      body: init.body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    throw new UpstreamError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
  }
}

export interface UpstreamJson {
  status: number;
  ok: boolean;
  body: unknown;
  headers: Headers;
}

/** Fetch and parse a JSON (or problem+json) response; non-JSON bodies become `null`. */
export async function upstreamJson(apiUrl: string, path: string, init: UpstreamInit): Promise<UpstreamJson> {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await upstreamFetch(apiUrl, path, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  return { status: response.status, ok: response.ok, body, headers: response.headers };
}

/** The `code` of a problem document, if the body is one. */
export function problemCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = (body as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
