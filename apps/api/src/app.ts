import "./http/fastify-augment";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { AgentBankError } from "@agentbank/core";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { AppDeps } from "./deps";
import { credentialFingerprint } from "./http/auth";
import { registerConsoleAuth } from "./http/console-auth";
import { registerDocs } from "./http/docs";
import { registerInternalRoutes } from "./http/internal";
import { PROBLEM_CONTENT_TYPE, problemFor } from "./http/problem";
import { registerApiRoutes, type Handlers } from "./http/registry";
import { handlers as defaultHandlers } from "./routes";

export interface BuildAppOptions {
  /** Override handlers (tests). Defaults to the full set in `src/routes`. */
  handlers?: Handlers;
}

/**
 * Build the Fastify app with every dependency injected. Nothing here reads the environment
 * or opens connections: `src/server.ts` wires production dependencies, tests wire PGlite, the
 * SimulatedChain, an in-memory or Postgres ledger and an in-process co-signer.
 */
export async function buildApp(deps: AppDeps, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    logController: new LogController({ disableRequestLogging: config.env === "test" }),
    requestIdHeader: "x-request-id",
    return503OnClosing: true,
  });

  // Keep the raw JSON body: RFC 9421 Content-Digest is computed over the exact bytes sent.
  const jsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body as string;
    jsonParser(request, body as string, done);
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.consoleOrigin ? [config.consoleOrigin] : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["content-type", "idempotency-key", "authorization"],
    exposedHeaders: [
      "idempotent-replayed",
      "agentbank-owner-operation-id",
      "agentbank-payment-id",
      "x-request-id",
    ],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: 60_000,
    keyGenerator: credentialFingerprint,
    allowList: (request) => request.url === "/healthz" || request.url.startsWith("/internal/"),
    errorResponseBuilder: () =>
      new AgentBankError("rate_limited", "Too many requests for this credential; slow down"),
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = problemFor(error, request.url.split("?")[0], request.log);
    if (problem.code === "rate_limited") reply.header("retry-after", "60");
    return reply
      .code(problem.status)
      .header("content-type", `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(JSON.stringify(problem));
  });
  app.setNotFoundHandler((request, reply) => {
    const problem = new AgentBankError("not_found", "Route not found").toProblem(request.url.split("?")[0]);
    return reply
      .code(404)
      .header("content-type", `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(JSON.stringify(problem));
  });

  registerApiRoutes(app, deps, options.handlers ?? defaultHandlers);
  registerConsoleAuth(app, deps);
  registerInternalRoutes(app, deps);
  registerDocs(app, config.publicBaseUrl);
  return app;
}
