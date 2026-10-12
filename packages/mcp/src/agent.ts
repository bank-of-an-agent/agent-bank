import { AgentClient } from "@agentbank/sdk";
import type { McpConfig } from "./config";

/**
 * Build the SDK `AgentClient` the MCP tools run on: authenticated with the
 * session key, bound to the configured account, with the x402 cap applied as
 * the client-side `maxAmountPerRequest`.
 */
export function createAgentClient(config: McpConfig, options: { fetch?: typeof fetch } = {}): AgentClient {
  return new AgentClient({
    baseUrl: config.apiUrl,
    accountId: config.accountId,
    session: { id: config.sessionId, signer: config.sessionKey },
    ...(config.spendKey ? { spendKey: config.spendKey } : {}),
    x402: { maxAmountPerRequest: config.maxX402PerCall },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
