#!/usr/bin/env node
/**
 * `agentbank-mcp`: run the Agent Bank MCP server.
 *
 *   agentbank-mcp                            # stdio (local agents)
 *   agentbank-mcp --http [--port 8090] [--host 127.0.0.1]   # streamable HTTP
 *
 * Configuration comes from environment variables (see `loadConfig`). Logs go
 * to stderr; stdout carries the stdio protocol. Keys are never logged.
 */
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentClient } from "./agent";
import { ConfigError, loadConfig } from "./config";
import { startHttpServer } from "./http";
import { createAgentBankMcpServer } from "./server";
import { MCP_SERVER_VERSION } from "./version";

const USAGE = `agentbank-mcp ${MCP_SERVER_VERSION}: Agent Bank money tools over MCP

Usage:
  agentbank-mcp                 serve over stdio
  agentbank-mcp --http          serve streamable HTTP at http://127.0.0.1:8090/mcp
    --port <n>                  port (default 8090)
    --host <addr>               interface (default 127.0.0.1; others need AGENTBANK_MCP_HTTP_TOKEN)

Environment:
  AGENTBANK_API_URL             API base URL (default http://localhost:8080)
  AGENTBANK_ACCOUNT_ID          the agent's account (acct_…)
  AGENTBANK_SESSION_ID          the session (ses_…)
  AGENTBANK_SESSION_KEY         session private key, or
  AGENTBANK_KEYSTORE            path of a 0600 key file holding session:<ses_id> / spend
  AGENTBANK_SPEND_KEY           x402 spend key (optional; needed to pay for HTTP resources)
  AGENTBANK_MAX_X402_PER_CALL   cap per paid request in USDC (default 1.00)
  AGENTBANK_X402_NETWORK        x402 network override, CAIP-2 (default: the deployment's, GET /v1/meta)
  AGENTBANK_MCP_HTTP_TOKEN      bearer token for --http (required off loopback)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${MCP_SERVER_VERSION}\n`);
    return;
  }

  const config = await loadConfig();
  const agent = createAgentClient(config);
  const create = () => createAgentBankMcpServer(agent, { maxX402PerCall: config.maxX402PerCall });
  const describe = `account ${config.accountId}, session ${config.sessionId} (key from ${config.sessionKeySource}), x402 ${config.spendKey ? `enabled on ${config.x402Network ?? "the deployment's network"}, max ${config.maxX402PerCall} USDC/call` : "disabled (no spend key)"}`;

  if (values.http) {
    const port = values.port !== undefined ? Number(values.port) : 8090;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ConfigError("--port must be 0-65535");
    const running = await startHttpServer(create, {
      port,
      ...(values.host ? { host: values.host } : {}),
      ...(config.httpToken ? { token: config.httpToken } : {}),
    });
    console.error(
      `agentbank-mcp ${MCP_SERVER_VERSION} listening on ${running.url} → ${config.apiUrl}; ${describe}`,
    );
    const stop = () => {
      void running.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  const server = create();
  await server.connect(new StdioServerTransport());
  console.error(`agentbank-mcp ${MCP_SERVER_VERSION} ready on stdio → ${config.apiUrl}; ${describe}`);
  const stop = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError || error instanceof Error ? error.message : "unexpected startup error";
  console.error(`agentbank-mcp: ${message}`);
  process.exit(1);
});
