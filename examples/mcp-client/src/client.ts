/**
 * A minimal MCP client for the Agent Bank MCP server (`agentbank-mcp`), over
 * stdio (the server runs as a child process) or streamable HTTP. Any MCP
 * host works the same way: list the tools, call them, and ask a human before
 * running a tool the server marks as destructive.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

type Env = Record<string, string | undefined>;

/** The only variables handed to the server process: never the whole environment. */
export const SERVER_ENV = [
  "AGENTBANK_API_URL",
  "AGENTBANK_ACCOUNT_ID",
  "AGENTBANK_SESSION_ID",
  "AGENTBANK_SESSION_KEY",
  "AGENTBANK_KEYSTORE",
  "AGENTBANK_SPEND_KEY",
  "AGENTBANK_MAX_X402_PER_CALL",
] as const;

/**
 * Streamable HTTP when `AGENTBANK_MCP_URL` is set (bearer token from
 * `AGENTBANK_MCP_HTTP_TOKEN`), otherwise stdio running
 * `AGENTBANK_MCP_COMMAND` (default `npx -y @agentbank/mcp`).
 */
export function transportFromEnv(env: Env = process.env): Transport {
  if (env.AGENTBANK_MCP_URL) {
    const token = env.AGENTBANK_MCP_HTTP_TOKEN;
    return new StreamableHTTPClientTransport(
      new URL(env.AGENTBANK_MCP_URL),
      token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined,
    );
  }
  const [command = "npx", ...args] = (env.AGENTBANK_MCP_COMMAND ?? "npx -y @agentbank/mcp")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const serverEnv: Record<string, string> = { ...getDefaultEnvironment() };
  for (const name of SERVER_ENV) {
    const value = env[name];
    if (value) serverEnv[name] = value;
  }
  return new StdioClientTransport({ command, args, env: serverEnv, stderr: "inherit" });
}

/** Connect an MCP client over the given transport. */
export async function connect(transport: Transport): Promise<Client> {
  const client = new Client({ name: "agentbank-quickstart", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/**
 * Whether a tool can move money. MCP defaults `destructiveHint` to true for
 * tools that are not read-only, so unannotated tools count as destructive.
 */
export function movesMoney(tool: Tool): boolean {
  return tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint !== false;
}

/** Decides whether a money-moving call may run (a human prompt, a policy, a test stub). */
export type Confirm = (tool: Tool, args: Record<string, unknown>) => Promise<boolean>;

export interface ToolOutcome {
  ok: boolean;
  data: Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "{}";
}

/**
 * Call one Agent Bank tool. Money-moving tools run only if `confirm` says
 * yes. Errors come back as data (`{ error: { code, detail } }`) with `ok: false`.
 */
export async function callTool(
  client: Client,
  tools: Tool[],
  name: string,
  args: Record<string, unknown>,
  confirm: Confirm,
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`The server has no tool named ${name}`);
  if (movesMoney(tool) && !(await confirm(tool, args))) {
    return { ok: false, data: { error: { code: "declined", detail: `${name} was not confirmed` } } };
  }
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const data =
    (result.structuredContent as Record<string, unknown> | undefined) ?? JSON.parse(textOf(result));
  return { ok: result.isError !== true, data };
}
