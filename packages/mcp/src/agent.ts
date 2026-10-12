import { AgentClient } from "@agentbank/sdk";
import type { McpConfig } from "./config";

/**
 * Build the SDK `AgentClient` the MCP tools run on: authenticated with the
 * session key, bound to the configured account, with the x402 cap applied as
 * the client-side `maxAmountPerRequest`. The x402 network and USDC come from
 * the deployment (`GET /v1/meta`) unless `AGENTBANK_X402_NETWORK` is set.
 */
export function createAgentClient(config: McpConfig, options: { fetch?: typeof fetch } = {}): AgentClient {
  return new AgentClient({
    baseUrl: config.apiUrl,
    accountId: config.accountId,
    session: { id: config.sessionId, signer: config.sessionKey },
    ...(config.spendKey ? { spendKey: config.spendKey } : {}),
    // Without AGENTBANK_X402_NETWORK the client pays on the deployment's network (GET /v1/meta).
    x402: {
      maxAmountPerRequest: config.maxX402PerCall,
      ...(config.x402Network ? { network: config.x402Network } : {}),
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
