import { AgentBankError } from "@agentbank/core";
import {
  ROUTE_LIST,
  type OperationId,
  type RequestOf,
  type ResponseOf,
  type RouteDef,
  type Routes,
} from "@agentbank/core/api";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodType } from "zod";
import type { AppDeps } from "../deps";
import { authenticate, type AuthContext } from "./auth";
import {
  claimIdempotency,
  completeIdempotency,
  readIdempotencyKey,
  redactSecrets,
  releaseIdempotency,
  REPLAYED_HEADER,
  requestHash,
  type IdempotencyClaim,
} from "./idempotency";
import { PROBLEM_CONTENT_TYPE, problemFor, validationError } from "./problem";

/**
 * Registers every route of the API contract (`@agentbank/core/api` routes) on Fastify:
 * method and path (`{id}` → `:id`), authentication (the route's auth kinds), Zod validation
 * of params, query and body, the `Idempotency-Key` protocol on idempotent routes, a typed
 * handler (`RequestOf<op>` → `ResponseOf<op>`), response validation in dev/test, and RFC 9457
 * problem details for every error. Facilitator routes (`service: "facilitator"`) are served by
 * apps/facilitator and are not registered here.
 */

/** Operations this service implements (every route not owned by the facilitator). */
export type ApiOperationId = {
  [K in OperationId]: Routes[K] extends { service: "facilitator" } ? never : K;
}[OperationId];

export interface HandlerContext {
  deps: AppDeps;
  auth: AuthContext;
  request: FastifyRequest;
  /** Request time from the injected clock. */
  now: Date;
  /** The validated `Idempotency-Key` on idempotent routes, else null. */
  idempotencyKey: string | null;
  log: FastifyBaseLogger;
}

/** A JSON body with a non-default status code or extra headers. */
export class Envelope<T> {
  constructor(
    readonly body: T,
    readonly status?: number,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {}
}

/** A non-JSON response (e.g. a CSV statement). Not validated against the JSON schema. */
export class RawResponse {
  constructor(
    readonly body: string,
    readonly contentType: string,
    readonly status = 200,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {}
}

export type HandlerResult<K extends OperationId> = ResponseOf<K> | Envelope<ResponseOf<K>> | RawResponse;

export type Handler<K extends OperationId> = (
  input: RequestOf<K>,
  ctx: HandlerContext,
) => Promise<HandlerResult<K>>;

export type Handlers = { [K in ApiOperationId]: Handler<K> };

export function toFastifyPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
}

/** Routes this service registers. */
export function apiRoutes(): RouteDef[] {
  return ROUTE_LIST.filter((r) => (r.service ?? "api") === "api");
}

function parsePart(
  schema: ZodType | undefined,
  value: unknown,
  location: "params" | "query" | "body",
): unknown {
  if (!schema) return undefined;
  try {
    return schema.parse(location === "body" ? value : (value ?? {}));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, location);
    throw error;
  }
}

function idempotencyScope(auth: AuthContext, operationId: string): string {
  switch (auth.kind) {
    case "principal":
      return `org:${auth.orgId}:${operationId}`;
    case "agent":
      return `agent:${auth.agentId}:${operationId}`;
    case "staff":
      return `staff:${operationId}`;
    case "public":
      return `public:${operationId}`;
  }
}

function sendJson(reply: FastifyReply, status: number, body: unknown, contentType: string): FastifyReply {
  return reply
    .code(status)
    .header("content-type", `${contentType}; charset=utf-8`)
    .send(JSON.stringify(body ?? null));
}

async function execute(
  def: RouteDef,
  handler: Handler<OperationId>,
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const now = deps.clock.now();
  let claim: IdempotencyClaim | null = null;
  try {
    const auth = await authenticate(request, def, deps, now);
    const input = {
      params: parsePart(def.params, request.params, "params"),
      query: parsePart(def.query, request.query, "query"),
      body: parsePart(def.body, request.body, "body"),
    } as RequestOf<OperationId>;

    let idempotencyKey: string | null = null;
    if (def.idempotent) {
      idempotencyKey = readIdempotencyKey(request);
      const result = await claimIdempotency(deps.db, {
        scope: idempotencyScope(auth, def.operationId),
        key: idempotencyKey,
        requestHash: requestHash(request),
        now,
        staleSeconds: deps.config.idempotencyStaleSeconds,
      });
      if (result.kind === "replay") {
        reply.header(REPLAYED_HEADER, "true");
        return sendJson(reply, result.status, result.body, result.contentType);
      }
      claim = result.claim;
    }

    const result = await handler(input, { deps, auth, request, now, idempotencyKey, log: request.log });

    if (result instanceof RawResponse) {
      if (claim) await completeIdempotency(deps.db, claim, result.status, null, result.contentType);
      return reply
        .code(result.status)
        .headers(result.headers)
        .header("content-type", result.contentType)
        .send(result.body);
    }
    const envelope = result instanceof Envelope ? result : new Envelope(result);
    const status = envelope.status ?? def.status ?? 200;
    if (deps.config.validateResponses) validateResponse(def, envelope.body, request.log);
    if (claim)
      await completeIdempotency(deps.db, claim, status, redactSecrets(envelope.body), "application/json");
    reply.headers(envelope.headers);
    return sendJson(reply, status, envelope.body, "application/json");
  } catch (error) {
    const problem = problemFor(error, request.url.split("?")[0], request.log);
    if (claim) {
      try {
        if (problem.status >= 500 || problem.status === 429) await releaseIdempotency(deps.db, claim);
        else await completeIdempotency(deps.db, claim, problem.status, problem, PROBLEM_CONTENT_TYPE);
      } catch (storeError) {
        request.log.error({ err: storeError }, "failed to record idempotent error response");
      }
    }
    if (problem.code === "rate_limited") reply.header("retry-after", "60");
    return sendJson(reply, problem.status, problem, PROBLEM_CONTENT_TYPE);
  }
}

function validateResponse(def: RouteDef, body: unknown, log: FastifyBaseLogger): void {
  const parsed = def.response.safeParse(body);
  if (!parsed.success) {
    log.error(
      { operationId: def.operationId, issues: parsed.error.issues.slice(0, 10) },
      "response does not match the API contract",
    );
    throw new AgentBankError("internal", `Response of ${def.operationId} does not match the API contract`);
  }
}

/** Register every API route with its handler. Throws if a handler is missing. */
export function registerApiRoutes(app: FastifyInstance, deps: AppDeps, handlers: Handlers): void {
  for (const def of apiRoutes()) {
    const handler = (handlers as Record<string, Handler<OperationId> | undefined>)[def.operationId];
    if (!handler) throw new Error(`No handler registered for ${def.operationId}`);
    app.route({
      method: def.method,
      url: toFastifyPath(def.path),
      config: { operationId: def.operationId },
      handler: (request, reply) => execute(def, handler, deps, request, reply),
    });
  }
}
