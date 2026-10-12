/**
 * RFC 9457 problem details as the console sees them: from the Agent Bank API
 * (passed through the BFF untouched) or from the BFF itself. The UI always
 * shows `code` and `detail`.
 */

export interface FieldError {
  path: string;
  message: string;
}

export interface ProblemInit {
  status: number;
  code: string;
  title: string;
  detail?: string;
  type?: string;
  instance?: string;
  errors?: FieldError[];
  requestId?: string;
  extensions?: Record<string, unknown>;
}

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly type: string | undefined;
  readonly instance: string | undefined;
  readonly errors: FieldError[];
  readonly requestId: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(init: ProblemInit) {
    super(init.detail ?? init.title);
    this.name = "ApiProblem";
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type;
    this.instance = init.instance;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId;
    this.extensions = init.extensions ?? {};
  }

  /** Build from a parsed problem document (or anything else a server sent). */
  static fromBody(status: number, body: unknown, requestId?: string): ApiProblem {
    if (typeof body === "object" && body !== null) {
      const {
        code,
        title,
        detail,
        type,
        instance,
        errors,
        status: _status,
        ...extensions
      } = body as Record<string, unknown>;
      return new ApiProblem({
        status,
        code: typeof code === "string" ? code : fallbackCode(status),
        title: typeof title === "string" ? title : fallbackTitle(status),
        detail: typeof detail === "string" ? detail : undefined,
        type: typeof type === "string" ? type : undefined,
        instance: typeof instance === "string" ? instance : undefined,
        errors: parseFieldErrors(errors),
        requestId,
        extensions,
      });
    }
    return new ApiProblem({
      status,
      code: fallbackCode(status),
      title: fallbackTitle(status),
      detail: typeof body === "string" && body.length > 0 && body.length < 500 ? body : undefined,
      requestId,
    });
  }

  static async fromResponse(response: Response): Promise<ApiProblem> {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text().catch(() => "");
    return ApiProblem.fromBody(response.status, parseJsonOr(text), requestId);
  }

  static network(error: unknown): ApiProblem {
    return new ApiProblem({
      status: 0,
      code: "network_error",
      title: "Network error",
      detail:
        error instanceof Error && error.message
          ? `The console server could not be reached (${error.message}).`
          : "The console server could not be reached.",
    });
  }

  /** Normalize anything thrown (an SDK error, a wallet error, …) into a problem for display. */
  static from(error: unknown): ApiProblem {
    if (error instanceof ApiProblem) return error;
    const sdk = sdkError(error);
    if (sdk) {
      // The raw problem keeps codes the SDK's catalog does not know (e.g. the BFF's `csrf_rejected`).
      if (sdk.problem && sdk.httpStatus)
        return ApiProblem.fromBody(sdk.httpStatus, sdk.problem, sdk.requestId);
      if (sdk.name === "ConnectionError") return ApiProblem.network(new Error(sdk.message));
      if (sdk.name === "TimeoutError") {
        return new ApiProblem({
          status: 0,
          code: "timeout",
          title: "Request timed out",
          detail: sdk.message,
        });
      }
      return new ApiProblem({
        status: sdk.httpStatus ?? 0,
        code: sdk.code,
        title: sdk.title,
        detail: sdk.message,
        errors: parseFieldErrors(sdk.extensions.issues),
        requestId: sdk.requestId,
      });
    }
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return new ApiProblem({
        status: 0,
        code: typeof code === "string" ? code : "client_error",
        title: error.name && error.name !== "Error" ? error.name : "Something went wrong",
        detail: error.message,
      });
    }
    return new ApiProblem({ status: 0, code: "client_error", title: "Something went wrong" });
  }
}

interface SdkErrorLike {
  name: string;
  message: string;
  code: string;
  title: string;
  extensions: Record<string, unknown>;
  httpStatus?: number;
  problem?: Readonly<Record<string, unknown>>;
  requestId?: string;
}

/** Errors from `@agentbank/sdk` (AgentBankApiError and core AgentBankError), recognized by shape. */
function sdkError(error: unknown): SdkErrorLike | null {
  if (!(error instanceof Error)) return null;
  const e = error as Error & Partial<SdkErrorLike>;
  if (
    typeof e.code !== "string" ||
    typeof e.title !== "string" ||
    typeof e.extensions !== "object" ||
    !e.extensions
  ) {
    return null;
  }
  return e as SdkErrorLike;
}

export function isApiProblem(value: unknown): value is ApiProblem {
  return value instanceof ApiProblem;
}

/** Parsed JSON, or the raw text when it is not JSON (`null` for an empty body). */
function parseJsonOr(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseFieldErrors(value: unknown): FieldError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return [];
    return [{ path: typeof path === "string" ? path : Array.isArray(path) ? path.join(".") : "", message }];
  });
}

function fallbackCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal";
  return "http_error";
}

function fallbackTitle(status: number): string {
  if (status === 401) return "Authentication required";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not found";
  if (status === 429) return "Too many requests";
  if (status >= 500) return "Server error";
  return `Request failed (${status})`;
}
