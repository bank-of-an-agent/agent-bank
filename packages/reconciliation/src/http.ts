import {
  AgentBankError,
  BalanceReportRequest,
  ExpectedBalancesRequest,
  IndexerRoutes,
  IngestEventsRequest,
  isAgentBankError,
  ReorgRequest,
  systemClock,
  unixSeconds,
  verifyInternalRequest,
  type Clock,
} from "@agentbank/core";
import { ZodError, type ZodType } from "zod";
import type { Reconciler } from "./types";

/**
 * The reconciler's five internal routes as one framework-agnostic handler: verify the
 * `AgentBank-Internal` HMAC (time, method, path and the raw body), validate the body with the
 * core schemas, call the reconciler, and answer JSON or an RFC 9457 problem. Mount it in any HTTP
 * server that keeps the raw request body (the indexer's HTTP tests use it with Fastify).
 */

export interface InternalRequest {
  method: string;
  /** Path without the query string, e.g. `/internal/v1/chain-events`. */
  path: string;
  authorization: string | undefined;
  /** The raw body exactly as received (`""` for GET). */
  body: string;
}

export interface InternalResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface InternalHandlerOptions {
  /** `INTERNAL_API_SHARED_SECRET`. */
  secret: string;
  clock?: Clock;
}

type Route = {
  method: string;
  path: string;
  schema?: ZodType;
  run: (r: Reconciler, body: never) => Promise<unknown>;
};

const ROUTES: Route[] = [
  { ...IndexerRoutes.watchlist, run: (r) => r.watchlist() },
  { ...IndexerRoutes.ingestEvents, schema: IngestEventsRequest, run: (r, body) => r.ingest(body) },
  { ...IndexerRoutes.reorg, schema: ReorgRequest, run: (r, body) => r.reorg(body) },
  {
    ...IndexerRoutes.expectedBalances,
    schema: ExpectedBalancesRequest,
    run: (r, body) => r.expectedBalances(body),
  },
  { ...IndexerRoutes.reportBalances, schema: BalanceReportRequest, run: (r, body) => r.report(body) },
];

function problem(error: unknown, path: string): InternalResponse {
  const e = isAgentBankError(error)
    ? error
    : error instanceof ZodError
      ? new AgentBankError(
          "invalid_request",
          error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
            .slice(0, 500),
        )
      : new AgentBankError("internal", "Internal error");
  return {
    status: e.status,
    contentType: "application/problem+json; charset=utf-8",
    body: JSON.stringify(e.toProblem(path)),
  };
}

/** Build the handler. Unknown routes are 404 problems. */
export function createInternalHandler(
  reconciler: Reconciler,
  options: InternalHandlerOptions,
): (request: InternalRequest) => Promise<InternalResponse> {
  const clock = options.clock ?? systemClock;
  return async (request) => {
    const route = ROUTES.find((r) => r.path === request.path && r.method === request.method.toUpperCase());
    try {
      if (!route) throw new AgentBankError("not_found", "Route not found");
      verifyInternalRequest(
        options.secret,
        request.authorization,
        request.method,
        request.path,
        request.body,
        unixSeconds(clock.now()),
      );
      let body: unknown = undefined;
      if (route.schema) {
        let json: unknown;
        try {
          json = JSON.parse(request.body);
        } catch {
          throw new AgentBankError("invalid_request", "Body is not JSON");
        }
        body = route.schema.parse(json);
      }
      const result = await route.run(reconciler, body as never);
      return { status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(result) };
    } catch (error) {
      return problem(error, request.path);
    }
  };
}
