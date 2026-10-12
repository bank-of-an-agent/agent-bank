import type { OperationId, RequestInputOf, ResponseOf, RouteDef } from "@agentbank/core/api";
import { routes } from "@agentbank/core/api";
import { AgentBankClient, type FetchLike } from "@agentbank/sdk";
import { ApiProblem } from "./problem";

/**
 * Browser client: the `@agentbank/sdk` `AgentBankClient` pointed at the
 * console's own origin (`/api/v1/...`). It never holds a credential; the BFF
 * attaches the one in the httpOnly cookie. The SDK brings request
 * validation against the route registry, idempotency keys and retries; this
 * module adds the CSRF header, cookie credentials and problem mapping.
 */

type Slot<Name extends string, T> = [T] extends [undefined]
  ? { [P in Name]?: undefined }
  : object extends T
    ? { [P in Name]?: T }
    : { [P in Name]: T };

export interface RequestOptions {
  /** Reuse the same key when retrying the same user action. Generated otherwise. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export type ApiArgs<K extends OperationId> = Slot<"params", RequestInputOf<K>["params"]> &
  Slot<"query", RequestInputOf<K>["query"]> &
  Slot<"body", RequestInputOf<K>["body"]> &
  RequestOptions;

export type ApiArgsTuple<K extends OperationId> =
  object extends ApiArgs<K> ? [args?: ApiArgs<K>] : [args: ApiArgs<K>];

interface LooseArgs extends RequestOptions {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export const API_PREFIX = "/api";
export const CSRF_HEADER = "x-csrf-token";

export function routeDef(op: OperationId): RouteDef {
  return routes[op] as RouteDef;
}

export function buildPath(def: RouteDef, params: Record<string, unknown> | undefined): string {
  return def.path.replace(/\{([a-z_]+)\}/gi, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === "") {
      throw new ApiProblem({
        status: 0,
        code: "client_error",
        title: "Missing path parameter",
        detail: `${def.operationId} needs "${name}"`,
      });
    }
    return encodeURIComponent(String(value));
  });
}

export function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The console URL of an operation, e.g. for a CSV download link. */
export function apiUrl<K extends OperationId>(op: K, ...[args]: ApiArgsTuple<K>): string {
  const loose = (args ?? {}) as LooseArgs;
  const def = routeDef(op);
  return `${API_PREFIX}${buildPath(def, loose.params)}${buildQuery(loose.query)}`;
}

export function readCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === "__Host-ab_csrf" || rawName === "ab_csrf") return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

type UnauthorizedHandler = (op: OperationId) => void;

let onUnauthorized: UnauthorizedHandler = (op) => {
  if (typeof window === "undefined") return;
  const staff = routeDef(op).auth.includes("staff");
  const here = `${window.location.pathname}${window.location.search}`;
  const target = staff ? "/admin/sign-in" : "/sign-in";
  if (window.location.pathname !== target) {
    window.location.assign(`${target}?next=${encodeURIComponent(here)}`);
  }
};

/** Replace the session-expired behaviour (tests use this). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

/** Same-origin requests with cookies; writes carry the double-submit CSRF token. */
export const consoleFetch: FetchLike = (input, init = {}) => {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set(CSRF_HEADER, readCsrfToken() ?? "");
  return fetch(input, { ...init, headers, credentials: "same-origin", cache: "no-store" });
};

let client: AgentBankClient | undefined;

function sdk(): AgentBankClient {
  if (!client) {
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    client = new AgentBankClient({
      baseUrl: `${origin}${API_PREFIX}`,
      fetch: consoleFetch,
      maxRetries: 2,
      timeoutMs: 45_000,
      validateRequests: true,
      validateResponses: false,
    });
  }
  return client;
}

/** For tests: drop the cached client (e.g. after changing `window.location`). */
export function resetApiClient(): void {
  client = undefined;
}

/**
 * Call an operation through the BFF. Errors become {@link ApiProblem}s that
 * keep the API's `code` and `detail`. Responses are parsed with the route's
 * schema when they match (defaults applied) and passed through otherwise.
 */
export async function apiFetch<K extends OperationId>(
  op: K,
  ...[args]: ApiArgsTuple<K>
): Promise<ResponseOf<K>> {
  const loose = (args ?? {}) as LooseArgs;
  const def = routeDef(op);
  let data: unknown;
  try {
    data = await (sdk().request as (op: K, args: LooseArgs) => Promise<unknown>)(op, {
      ...(loose.params ? { params: loose.params } : {}),
      ...(loose.query ? { query: loose.query } : {}),
      ...(loose.body !== undefined ? { body: loose.body } : {}),
      ...(loose.idempotencyKey ? { idempotencyKey: loose.idempotencyKey } : {}),
      ...(loose.signal ? { signal: loose.signal } : {}),
    });
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "AbortError") throw error;
    const problem = ApiProblem.from(error);
    if (problem.status === 401 && problem.code === "unauthorized") onUnauthorized(op);
    throw problem;
  }
  if (data === undefined) return undefined as ResponseOf<K>;
  const parsed = def.response.safeParse(data);
  if (parsed.success) return parsed.data as ResponseOf<K>;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[api] ${op}: response does not match the API contract`, parsed.error.issues);
  }
  return data as ResponseOf<K>;
}

/** POST to one of the console's own `/api/auth/*` or `/api/admin/*` endpoints (not API routes). */
export async function consolePost<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await consoleFetch(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw ApiProblem.network(error);
  }
  if (!response.ok) throw await ApiProblem.fromResponse(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
