/**
 * `@agentbank/mcp`: an MCP server exposing Agent Bank **money tools** to AI
 * agents (`get_balance`, `check_spend`, `pay`, `fetch_paid_resource`,
 * `request_payment`, `create_escrow`, `release_escrow`, `list_transactions`,
 * and the private-proof tools `prove_claims` and `reserve_funds_for_proof`)
 * over stdio or streamable HTTP. Nothing it exposes can loosen limits, widen
 * disclosure or withdraw to the owner.
 *
 * Run it with the `agentbank-mcp` binary, or embed it:
 *
 * ```ts
 * import { createAgentBankMcpServer, createAgentClient, loadConfig } from "@agentbank/mcp";
 * const config = await loadConfig();
 * const server = createAgentBankMcpServer(createAgentClient(config), { maxX402PerCall: config.maxX402PerCall });
 * ```
 *
 * @packageDocumentation
 */

export {
  createAgentBankMcpServer,
  TOOL_NAMES,
  type AgentBankBackend,
  type AgentBankMcpServerOptions,
} from "./server";
export { ConfigError, loadConfig, type McpConfig } from "./config";
export { createAgentClient } from "./agent";
export { startHttpServer, type HttpServerOptions, type RunningHttpServer } from "./http";
export { describeError, toolError, type ToolErrorBody } from "./errors";
export { MCP_SERVER_VERSION } from "./version";
