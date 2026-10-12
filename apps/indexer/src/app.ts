import { AgentBankError, isAgentBankError, verifyInternalRequest } from "@agentbank/core";
import Fastify, { type FastifyInstance } from "fastify";
import type { Indexer } from "./indexer";

/**
 * The indexer's HTTP surface (port 8082, reachable only inside its own account): health for the
 * container and load balancer checks, Prometheus metrics, and an HMAC-authenticated on-demand
 * balance check (`INTERNAL_API_SHARED_SECRET`).
 */

export const BALANCE_CHECK_PATH = "/internal/balance-check";

export interface AppOptions {
  indexer: Indexer;
  secret: string;
  logLevel?: string;
  /** Unix seconds (tests). */
  now?: () => number;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logLevel && options.logLevel !== "silent" ? { level: options.logLevel } : false,
    return503OnClosing: true,
  });
  const { indexer } = options;

  // Keep the raw body: the HMAC covers the exact bytes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) =>
    done(null, body),
  );

  app.get("/healthz", async (_request, reply) => {
    const last = indexer.lastTick;
    return reply.code(200).send({
      status: indexer.lastError && (!last || last.at < indexer.lastError.at) ? "degraded" : "ok",
      chain_id: indexer.chainId,
      cursor_lag_blocks: indexer.metrics.value("indexer_block_lag"),
      last_tick_at: last?.at.toISOString() ?? null,
      last_error: indexer.lastError?.message ?? null,
    });
  });

  app.get("/metrics", async (_request, reply) =>
    reply.code(200).header("content-type", "text/plain; version=0.0.4").send(indexer.metrics.render()),
  );

  app.post(BALANCE_CHECK_PATH, async (request, reply) => {
    try {
      const header = request.headers.authorization;
      verifyInternalRequest(
        options.secret,
        Array.isArray(header) ? header[0] : header,
        request.method,
        BALANCE_CHECK_PATH,
        typeof request.body === "string" ? request.body : "",
        options.now?.(),
      );
      const result = await indexer.balanceCheck();
      if (!result)
        throw new AgentBankError("invalid_state", "Nothing indexed yet, or a reorg is being reported");
      return reply.code(200).send({
        block_number: result.blockNumber.toString(),
        checked: result.checked,
        mismatches: result.mismatches,
      });
    } catch (error) {
      const e = isAgentBankError(error) ? error : new AgentBankError("internal", "Balance check failed");
      return reply
        .code(e.status)
        .header("content-type", "application/problem+json")
        .send(JSON.stringify(e.toProblem(BALANCE_CHECK_PATH)));
    }
  });
  return app;
}
