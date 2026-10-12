import { ERROR_CATALOG, problemType, type ErrorCode, type ProblemDetails } from "@agentbank/core";
import { routes } from "@agentbank/core/api";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import { safeErrorMessage, type Facilitator, type FacilitatorReply } from "./facilitator";
import type { Logger } from "./logger";
import type { Metrics } from "./metrics";
import { REASONS, type ReasonCode } from "./reasons";

/** Requests per client IP and minute. */
export interface RateLimits {
  verifyPerMinute: number;
  settlePerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { verifyPerMinute: 300, settlePerMinute: 60 };

export interface AppOptions {
  facilitator: Facilitator;
  metrics?: Metrics | undefined;
  /** pino logger; omitted: no logging. */
  logger?: Logger | undefined;
  /** Largest request body (bytes). Default 64 KiB: x402 bodies are small JSON documents. */
  bodyLimitBytes?: number;
  /**
   * Fastify `trustProxy`, which decides the client IP the rate limits key on: false, true, a hop
   * count (1 behind the ALB) or a list of proxy addresses.
   */
  trustProxy?: boolean | number | string;
  /** Per-client budgets for verify and settle (default 300 and 60 per minute); `false` disables them. */
  rateLimits?: RateLimits | false;
  /** Suppress per-request log lines (tests). `/healthz` and `/metrics` are never logged. */
  disableRequestLogging?: boolean;
}

const PROBLEM_JSON = "application/problem+json; charset=utf-8";
const QUIET_PATHS = new Set([routes.health.path, "/metrics"]);
const MINUTE_MS = 60_000;

function pathOf(url: string): string {
  return url.split("?")[0] ?? url;
}

function problem(code: ErrorCode, status: number, detail: string, instance: string): ProblemDetails {
  return { type: problemType(code), title: ERROR_CATALOG[code].title, status, detail, code, instance };
}

/** A hop count becomes the equivalent trust function: trust the `n` proxies nearest to us. */
function toFastifyTrustProxy(
  value: boolean | number | string | undefined,
): boolean | string | ((address: string, hop: number) => boolean) {
  if (typeof value === "number") return (_address, hop) => hop < value;
  return value ?? false;
}

function send<T>(reply: FastifyReply, out: FacilitatorReply<T>) {
  if (out.headers) reply.headers(out.headers);
  return reply.code(out.status).send(out.body);
}

/**
 * The facilitator's HTTP surface (port 8083). Sellers configure the base URL
 * `https://<facilitator>/v1/x402`, which is what x402's `HTTPFacilitatorClient` and the Agent
 * Bank SDK paywall call:
 *
 * - `POST /v1/x402/verify`, `POST /v1/x402/settle`: x402 v2 bodies validated with the core
 *   contract; answers are always in the x402 shape (`isValid`/`invalidReason`,
 *   `success`/`errorReason`/`transaction`/`network`/`payer`). Malformed bodies get HTTP 400,
 *   rate-limited clients 429 (`Retry-After`), fail-closed and load-shedding answers 5xx, every
 *   other answer 200. Each route has its own per-client-IP budget; settle's is stricter.
 * - `GET /v1/x402/supported`, `GET /healthz`, `GET /metrics` (Prometheus text).
 *
 * Both x402 routes are public (`auth: ["seller", "public"]` in the route registry).
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { facilitator, metrics } = options;
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger as FastifyBaseLogger } : { logger: false }),
    logController: new LogController({
      disableRequestLogging: (req: { url?: string }) =>
        options.disableRequestLogging === true || QUIET_PATHS.has(pathOf(req.url ?? "")),
    }),
    bodyLimit: options.bodyLimitBytes ?? 64 * 1024,
    trustProxy: toFastifyTrustProxy(options.trustProxy),
    return503OnClosing: true,
    requestIdHeader: "x-request-id",
  });

  // Rate limits apply per client IP (`request.ip`, which honours `trustProxy`; IPv6 grouped by
  // /64) before the body is parsed. Only the routes that carry `config.rateLimit` are limited,
  // each with its own counter.
  const limits = options.rateLimits === undefined ? DEFAULT_RATE_LIMITS : options.rateLimits;
  if (limits) await app.register(rateLimit, { global: false });
  const limitFor = (max: number) => (limits ? { config: { rateLimit: { max, timeWindow: MINUTE_MS } } } : {});

  // JSON only: other media types are refused (415) instead of reaching the handlers as text.
  app.removeContentTypeParser("text/plain");

  app.post(routes.x402Verify.path, limitFor(limits ? limits.verifyPerMinute : 0), async (request, reply) =>
    send(reply, await facilitator.verify(request.body)),
  );

  app.post(routes.x402Settle.path, limitFor(limits ? limits.settlePerMinute : 0), async (request, reply) =>
    send(reply, await facilitator.settle(request.body)),
  );

  app.get(routes.x402Supported.path, async () => facilitator.supported());

  app.get(routes.health.path, async (_request, reply) => {
    const health = await facilitator.health();
    return reply.code(health.httpStatus).send({ status: health.status, checks: health.checks });
  });

  app.get("/metrics", async (_request, reply) =>
    reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics ? metrics.render() : "\n"),
  );

  // Errors raised before a handler runs (rate limit, invalid JSON, wrong media type, body too
  // large) are answered in the x402 shape on the x402 routes, and as RFC 9457 problems elsewhere.
  // Headers set before the error (Retry-After, X-RateLimit-*) are kept.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    const path = pathOf(request.url);
    const clientError = status < 500;
    const limited = status === 429;
    if (limited)
      metrics?.inc("facilitator_rate_limited_total", { route: path }, "Requests refused by rate limits");
    if (!clientError) request.log.error({ err: safeErrorMessage(error) }, "request failed");
    const detail = limited ? REASONS.rate_limited : clientError ? safeErrorMessage(error) : "Internal error";
    if (path === routes.x402Verify.path) {
      const reason: ReasonCode = limited
        ? "rate_limited"
        : clientError
          ? "invalid_payload"
          : "unexpected_verify_error";
      return reply.code(status).send({
        isValid: false,
        invalidReason: reason,
        invalidMessage: clientError ? detail : REASONS[reason],
      });
    }
    if (path === routes.x402Settle.path) {
      const reason: ReasonCode = limited
        ? "rate_limited"
        : clientError
          ? "invalid_payload"
          : "unexpected_settle_error";
      return reply.code(status).send({
        success: false,
        errorReason: reason,
        errorMessage: clientError ? detail : REASONS[reason],
        transaction: "",
        network: facilitator.chain.caip2,
      });
    }
    const code: ErrorCode = limited ? "rate_limited" : clientError ? "invalid_request" : "internal";
    return reply
      .code(status)
      .header("content-type", PROBLEM_JSON)
      .send(JSON.stringify(problem(code, status, detail, path)));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .header("content-type", PROBLEM_JSON)
      .send(JSON.stringify(problem("not_found", 404, "Route not found", pathOf(request.url)))),
  );

  return app;
}
