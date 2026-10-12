import {
  AgentBankError,
  AuthorizeX402Internal,
  CosignerRoutes,
  CosignInternal,
  EvaluateInternal,
  FreezeInternal,
  INTERNAL_AUTH_SCHEME,
  PutPolicyInternal,
  RegisterMandateInternal,
  RegisterSessionInternal,
  RegisterSpendKeyInternal,
  RotateOwnerInternal,
  SetTreasuryInternal,
  SettlementReportInternal,
  systemClock,
  UnfreezeInternal,
  verifyInternalRequest,
  type AuditRecord,
  type Clock,
  type ProblemDetails,
} from "@agentbank/core";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z, ZodError } from "zod";
import type { Metrics } from "./metrics";
import type { CosignerService } from "./service";

export interface AppOptions {
  service: CosignerService;
  sharedSecret: string;
  clock?: Clock;
  metrics?: Metrics;
  /** Fastify logger options; `false` (default) disables request logging. */
  logger?: FastifyServerOptions["logger"];
}

declare module "fastify" {
  interface FastifyRequest {
    /** The exact request body bytes (UTF-8), as authenticated by the internal HMAC. */
    rawBody?: string;
  }
}

const PROBLEM_JSON = "application/problem+json";
/** Bodies are small JSON documents; anything larger is refused before authentication. */
const BODY_LIMIT = 512 * 1024;

const AuditQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/** A request needs the internal HMAC when its matched route or its raw URL is under `/internal/`. */
function isInternal(request: FastifyRequest): boolean {
  return (
    (request.routeOptions.url ?? request.url).startsWith("/internal/") || request.url.startsWith("/internal/")
  );
}

function problem(reply: FastifyReply, error: AgentBankError, instance: string): FastifyReply {
  return reply.code(error.status).type(PROBLEM_JSON).send(error.toProblem(instance));
}

/**
 * The co-signer's internal HTTP API (`CosignerRoutes` in core/cosigner-api.ts).
 *
 * Every `/internal/` request must carry `Authorization: AgentBank-Internal
 * t=<unix>,v1=<hmac>` binding time (±60 s), method, path (with query) and the
 * raw body; the body is only parsed after it authenticates. `/healthz` and
 * `/metrics` are unauthenticated and reveal nothing secret.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { service, sharedSecret, metrics } = options;
  const clock = options.clock ?? systemClock;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT,
    return503OnClosing: true,
    trustProxy: false,
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!isInternal(request)) return;
    metrics?.observeRequest(request.routeOptions.url ?? "unmatched", reply.statusCode);
  });

  // Keep the body as the exact string that was signed; JSON is parsed after authentication.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.addHook("onRequest", async (request, reply) => {
    if (!isInternal(request)) return;
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith(`${INTERNAL_AUTH_SCHEME} `)) {
      metrics?.inc("cosigner_auth_failures_total", { reason: "missing" }, "Rejected internal requests");
      return problem(
        reply,
        new AgentBankError("unauthorized", "Missing internal authorization"),
        request.url,
      );
    }
  });

  app.addHook("preValidation", async (request, reply) => {
    if (!isInternal(request)) return;
    const raw = typeof request.body === "string" ? request.body : "";
    try {
      verifyInternalRequest(
        sharedSecret,
        request.headers.authorization,
        request.method,
        request.url,
        raw,
        Math.floor(clock.now().getTime() / 1000),
      );
    } catch (error) {
      metrics?.inc("cosigner_auth_failures_total", { reason: "invalid" }, "Rejected internal requests");
      const err = error instanceof AgentBankError ? error : new AgentBankError("unauthorized");
      return problem(reply, err, request.url);
    }
    request.rawBody = raw;
    if (raw.length > 0) {
      try {
        request.body = JSON.parse(raw) as unknown;
      } catch {
        return problem(reply, new AgentBankError("invalid_request", "Body is not valid JSON"), request.url);
      }
    } else {
      request.body = undefined;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AgentBankError) return problem(reply, error, request.url);
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
      const detail = issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
      return problem(reply, new AgentBankError("invalid_request", detail, { issues }), request.url);
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code = status === 401 ? "unauthorized" : status === 404 ? "not_found" : "invalid_request";
      const err = new AgentBankError(code, (error as Error).message);
      const body: ProblemDetails = { ...err.toProblem(request.url), status };
      return reply.code(status).type(PROBLEM_JSON).send(body);
    }
    // Anything unexpected (database down, KMS unreachable, bugs): refuse, and say so.
    request.log.error({ err: error }, "internal error; failing closed");
    return problem(
      reply,
      new AgentBankError(
        "cosigner_unavailable",
        "The co-signer could not complete the request; failing closed",
      ),
      request.url,
    );
  });

  app.setNotFoundHandler((request, reply) =>
    problem(
      reply,
      new AgentBankError("not_found", `No route ${request.method} ${request.url.split("?")[0]}`),
      request.url,
    ),
  );

  const r = CosignerRoutes;
  const path = (p: string): string => p; // Fastify uses the same `:param` syntax as the contract.
  const params = (request: FastifyRequest): Record<string, string> =>
    request.params as Record<string, string>;

  app.post(path(r.registerSession.path), async (request) => {
    await service.registerSession(RegisterSessionInternal.parse(request.body));
    return { ok: true };
  });

  app.delete(path(r.revokeSession.path), async (request) => {
    await service.revokeSession(z.string().parse(params(request).id));
    return { ok: true };
  });

  app.post(path(r.putPolicy.path), async (request) =>
    service.putPolicy(PutPolicyInternal.parse(request.body)),
  );

  app.get(path(r.getPolicy.path), async (request) =>
    service.getPolicy(z.string().parse(params(request).agentId)),
  );

  app.post(path(r.registerMandate.path), async (request) => {
    await service.registerMandate(RegisterMandateInternal.parse(request.body));
    return { ok: true };
  });

  app.post(path(r.registerSpendKey.path), async (request) => {
    await service.registerSpendKey(RegisterSpendKeyInternal.parse(request.body));
    return { ok: true };
  });

  app.post(path(r.setTreasury.path), async (request) => {
    await service.setTreasury(SetTreasuryInternal.parse(request.body));
    return { ok: true };
  });

  app.post(path(r.rotateOwner.path), async (request) => {
    await service.rotateOwner(RotateOwnerInternal.parse(request.body));
    return { ok: true };
  });

  app.delete(path(r.revokeMandate.path), async (request) => {
    await service.revokeMandate(z.string().parse(params(request).id));
    return { ok: true };
  });

  app.post(path(r.freeze.path), async (request) => {
    await service.freeze(FreezeInternal.parse(request.body));
    return { ok: true };
  });

  app.post(path(r.unfreeze.path), async (request) => service.unfreeze(UnfreezeInternal.parse(request.body)));

  app.post(path(r.evaluate.path), async (request) => service.evaluate(EvaluateInternal.parse(request.body)));

  app.post(path(r.cosign.path), async (request) => service.cosign(CosignInternal.parse(request.body)));

  app.post(path(r.authorizeX402.path), async (request) =>
    service.authorizeX402(AuthorizeX402Internal.parse(request.body)),
  );

  app.post(path(r.reportSettlement.path), async (request) => {
    await service.reportSettlement(SettlementReportInternal.parse(request.body));
    return { ok: true };
  });

  app.get(path(r.audit.path), async (request): Promise<{ records: AuditRecord[] }> => {
    const query = AuditQuery.parse(request.query);
    return { records: await service.audit(query.after, query.limit) };
  });

  app.get(path(r.health.path), async () => service.health());

  app.get("/metrics", async (_request, reply) =>
    reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics?.render() ?? ""),
  );

  return app;
}
