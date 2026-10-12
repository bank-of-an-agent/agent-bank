import {
  AgentBankError,
  errorFromProblem,
  ExpectedBalancesResponse,
  IndexerRoutes,
  IngestEventsResponse,
  ReorgResponse,
  signInternalRequest,
  WatchlistResponse,
  type BalanceReportRequest,
  type ExpectedBalancesRequest,
  type IngestEventsRequest,
  type ReorgRequest,
} from "@agentbank/core";
import type { ZodType } from "zod";

/**
 * How the indexer reaches the reconciler. In production this is HTTP to the API's
 * `/internal/v1/*` routes (PrivateLink), authenticated with `signInternalRequest` and
 * `INTERNAL_API_SHARED_SECRET`; tests call a reconciler in-process through the same interface
 * (`createReconciler(...)` satisfies it).
 */
export interface ReconcilerTransport {
  watchlist(): Promise<WatchlistResponse>;
  ingest(request: IngestEventsRequest): Promise<IngestEventsResponse>;
  reorg(request: ReorgRequest): Promise<ReorgResponse>;
  expectedBalances(request: ExpectedBalancesRequest): Promise<ExpectedBalancesResponse>;
  report(request: BalanceReportRequest): Promise<unknown>;
}

export interface HttpTransportOptions {
  /** `API_INTERNAL_URL`, e.g. `http://vpce-…:8080` (no trailing path). */
  baseUrl: string;
  /** `INTERNAL_API_SHARED_SECRET`. */
  secret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Unix seconds for the HMAC timestamp (tests). */
  now?: () => number;
}

type Route = { method: string; path: string };

export class HttpReconcilerTransport implements ReconcilerTransport {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.base = new URL(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async call<T>(route: Route, body: unknown, schema: ZodType<T> | null): Promise<T> {
    const url = new URL(route.path, this.base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const t = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    const authorization = signInternalRequest(this.options.secret, route.method, url.pathname, raw, t);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: route.method,
        headers: {
          authorization,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: raw }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new AgentBankError(
        "internal",
        `${route.method} ${route.path} failed: ${(error as Error).message}`,
      );
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw new AgentBankError(
        "internal",
        `${route.method} ${route.path}: HTTP ${response.status}, body is not JSON`,
      );
    }
    if (!response.ok) {
      throw errorFromProblem((json ?? {}) as Record<string, unknown>);
    }
    return schema ? schema.parse(json) : (json as T);
  }

  watchlist(): Promise<WatchlistResponse> {
    return this.call(IndexerRoutes.watchlist, undefined, WatchlistResponse);
  }

  ingest(request: IngestEventsRequest): Promise<IngestEventsResponse> {
    return this.call(IndexerRoutes.ingestEvents, request, IngestEventsResponse);
  }

  reorg(request: ReorgRequest): Promise<ReorgResponse> {
    return this.call(IndexerRoutes.reorg, request, ReorgResponse);
  }

  expectedBalances(request: ExpectedBalancesRequest): Promise<ExpectedBalancesResponse> {
    return this.call(IndexerRoutes.expectedBalances, request, ExpectedBalancesResponse);
  }

  report(request: BalanceReportRequest): Promise<unknown> {
    return this.call(IndexerRoutes.reportBalances, request, null);
  }
}
