import { ConfigError, serverConfig, sessionSecret } from "@/lib/server/env";

/**
 * Liveness for the container health check (`HEALTHCHECK_PATH=/healthz`).
 * Reports 503 when the environment is invalid; the reason goes to the log,
 * not to the caller.
 */
export function GET(): Response {
  try {
    serverConfig();
    sessionSecret();
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("console health check failed:", error instanceof ConfigError ? error.message : error);
    return Response.json({ status: "degraded" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export const dynamic = "force-dynamic";
