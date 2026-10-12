import { createAgentBankMcpServer, type AgentBankBackend } from "@agentbank/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentClient } from "@agentbank/sdk";

/**
 * The Agent Bank MCP server over its in-memory transport, backed by a real-HTTP `AgentClient`.
 * `callTool` runs a tool the way a hosted agent's MCP client would; errors come back as
 * `isError` results, not thrown, so a scripted adversary can see refusals.
 */
export interface McpHarness {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Parse a tool result's JSON (structured content, or the text block). */
  parse(result: CallToolResult): Record<string, unknown>;
  /** The error body of a failed tool call (`{ code, detail, … }`). */
  errorOf(result: CallToolResult): { code: string; detail: string } & Record<string, unknown>;
  close(): Promise<void>;
}

export async function connectMcp(
  backend: AgentBankBackend | AgentClient,
  options: { maxX402PerCall?: string } = {},
): Promise<McpHarness> {
  const server = createAgentBankMcpServer(backend as AgentBankBackend, {
    ...(options.maxX402PerCall ? { maxX402PerCall: options.maxX402PerCall } : {}),
    settlementTimeoutMs: 30_000,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  await client.connect(clientTransport);

  const call = (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const parse = (result: CallToolResult): Record<string, unknown> => {
    if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
    return JSON.parse(text) as Record<string, unknown>;
  };
  const errorOf = (result: CallToolResult): { code: string; detail: string } & Record<string, unknown> => {
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
    const body = JSON.parse(text) as { error?: { code: string; detail: string } };
    return (body.error ?? { code: "unknown", detail: text }) as {
      code: string;
      detail: string;
    } & Record<string, unknown>;
  };
  return { client, call, parse, errorOf, close: () => client.close() };
}
