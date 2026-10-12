import {
  AgentBankError,
  BalanceReportRequest,
  ExpectedBalancesRequest,
  ExpectedBalancesResponse,
  IndexerRoutes,
  IngestEventsRequest,
  IngestEventsResponse,
  ReorgRequest,
  ReorgResponse,
  unixSeconds,
  verifyInternalRequest,
  WatchlistResponse,
} from "@agentbank/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodType } from "zod";
import type { AppDeps } from "../deps";
import { PROBLEM_CONTENT_TYPE, problemFor, validationError } from "./problem";

/**
 * Internal API for the indexer (its own AWS account; reaches the API over PrivateLink). Five
 * routes (`IndexerRoutes` in core), outside the public v1 registry and the OpenAPI document,
 * each authenticated with `verifyInternalRequest` (HMAC over time, method, path and raw body)
 * using `INTERNAL_API_SHARED_SECRET`. Without the secret configured every request is refused.
 * The public ALB also blocks `/internal/*`. The matching and posting logic is the reconciler
 * (`@agentbank/reconciliation`), injected as `deps.reconciler`.
 */

/** The part of `@agentbank/reconciliation`'s `Reconciler` the API uses. */
export interface Reconciler {
  watchlist(): Promise<unknown>;
  ingest(request: IngestEventsRequest): Promise<unknown>;
  reorg(request: ReorgRequest): Promise<unknown>;
  expectedBalances(request: ExpectedBalancesRequest): Promise<unknown>;
  report(request: BalanceReportRequest): Promise<unknown>;
  /** Retry reorg reversals blocked by held funds (worker job). */
  retryPendingReversals?(): Promise<number>;
}

const INGEST_BODY_LIMIT = 8 * 1_048_576;

async function handle<T>(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    schema?: ZodType<T>;
    response?: ZodType;
    run: (reconciler: Reconciler, body: T) => Promise<unknown>;
  },
): Promise<FastifyReply> {
  try {
    const secret = deps.config.internalApiSecret;
    if (!secret) throw new AgentBankError("unauthorized", "Internal API is not enabled");
    const header = request.headers.authorization;
    verifyInternalRequest(
      secret,
      Array.isArray(header) ? header[0] : header,
      request.method,
      request.url.split("?")[0] ?? request.url,
      request.rawBody ?? "",
      unixSeconds(deps.clock.now()),
    );
    let body = undefined as T;
    if (input.schema) {
      try {
        body = input.schema.parse(request.body);
      } catch (error) {
        if (error instanceof ZodError) throw validationError(error, "body");
        throw error;
      }
    }
    if (!deps.reconciler)
      throw new AgentBankError("internal", "The reconciler is not configured on this deployment");
    const result = await input.run(deps.reconciler, body);
    if (input.response && deps.config.validateResponses) {
      const parsed = input.response.safeParse(result);
      if (!parsed.success) {
        request.log.error(
          { issues: parsed.error.issues.slice(0, 5) },
          "reconciler response does not match the internal API",
        );
        throw new AgentBankError("internal", "Reconciler response does not match the internal API");
      }
    }
    return reply
      .code(200)
      .header("content-type", "application/json; charset=utf-8")
      .send(JSON.stringify(result ?? { ok: true }));
  } catch (error) {
    const problem = problemFor(error, request.url.split("?")[0], request.log);
    return reply
      .code(problem.status)
      .header("content-type", `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(JSON.stringify(problem));
  }
}

export function registerInternalRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get(IndexerRoutes.watchlist.path, (request, reply) =>
    handle(deps, request, reply, { response: WatchlistResponse, run: (r) => r.watchlist() }),
  );
  app.post(IndexerRoutes.ingestEvents.path, { bodyLimit: INGEST_BODY_LIMIT }, (request, reply) =>
    handle(deps, request, reply, {
      schema: IngestEventsRequest,
      response: IngestEventsResponse,
      run: (r, body) => r.ingest(body),
    }),
  );
  app.post(IndexerRoutes.reorg.path, (request, reply) =>
    handle(deps, request, reply, {
      schema: ReorgRequest,
      response: ReorgResponse,
      run: (r, body) => r.reorg(body),
    }),
  );
  app.post(IndexerRoutes.expectedBalances.path, { bodyLimit: INGEST_BODY_LIMIT }, (request, reply) =>
    handle(deps, request, reply, {
      schema: ExpectedBalancesRequest,
      response: ExpectedBalancesResponse,
      run: (r, body) => r.expectedBalances(body),
    }),
  );
  app.post(IndexerRoutes.reportBalances.path, (request, reply) =>
    handle(deps, request, reply, { schema: BalanceReportRequest, run: (r, body) => r.report(body) }),
  );
}
