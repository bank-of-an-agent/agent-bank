/**
 * Agent Bank money tools for the Claude Agent SDK, as an in-process MCP
 * server, and a locked-down `query()` configuration: no built-in tools (no
 * shell, no file access), exactly the money tools pre-approved, everything
 * else denied without prompting.
 */
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { INSTRUCTIONS, safely, type MoneyTools, type ToolOutput } from "./money-tools";

/** MCP server name; the model sees the tools as `mcp__agentbank__<tool>`. */
export const SERVER_NAME = "agentbank";

/** Default model: Claude Opus 5.5. Override with `CLAUDE_MODEL`. */
export const DEFAULT_MODEL = "claude-opus-5-5";

const Amount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/, 'a decimal string such as "2.50"')
  .describe('Amount in USDC as a decimal string, e.g. "2.50". Never a number.');
const Recipient = z
  .string()
  .regex(
    /^(0x[0-9a-fA-F]{40}|agt_[0-9A-HJKMNP-TV-Z]{26}|acct_[0-9A-HJKMNP-TV-Z]{26})$/,
    "an address, agent id or account id",
  )
  .describe("Who to pay: an EVM address (0x…), an Agent Bank agent id (agt_…) or account id (acct_…)");

async function result(fn: () => Promise<ToolOutput>): Promise<CallToolResult> {
  const output = await safely(fn);
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    ...("error" in output ? { isError: true } : {}),
  };
}

/** The five money tools, bound to one agent and one run's budget. */
export function moneyToolDefinitions(money: MoneyTools) {
  return [
    tool(
      "get_balance",
      "Get this agent's USDC balances: available, reserved for pending payments, in escrow, the x402 spend float, and what is left of this run's budget.",
      {},
      () => result(() => money.getBalance()),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "check_spend",
      "Ask whether a payment would be allowed by the owner's policy, without moving money. Returns allow, deny, require_approval or require_owner and the rules that fired.",
      {
        amount: Amount,
        to: Recipient.optional(),
        x402_domain: z
          .string()
          .max(253)
          .optional()
          .describe("Hostname of a paid API, e.g. api.example-data.com"),
      },
      (args) =>
        result(() =>
          money.checkSpend({
            amount: args.amount,
            ...(args.to ? { to: args.to } : {}),
            ...(args.x402_domain ? { x402Domain: args.x402_domain } : {}),
          }),
        ),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "pay",
      "Send USDC to exactly one recipient. The owner's policy is enforced and Agent Bank co-signs; a 0.20% fee applies. Returns the payment status: settled, submitted or requires_approval. Payments cannot be undone.",
      {
        to: Recipient,
        amount: Amount,
        memo: z.string().max(500).optional().describe("What the payment is for (visible to the owner)"),
      },
      (args) =>
        result(() =>
          money.pay({ to: args.to, amount: args.amount, ...(args.memo ? { memo: args.memo } : {}) }),
        ),
      { annotations: { destructiveHint: true, openWorldHint: true } },
    ),
    tool(
      "fetch_paid_resource",
      "Fetch an https URL. If it answers 402 Payment Required with an x402 offer, pay it automatically within this agent's limits and return the response body.",
      { url: z.url().describe("https URL to fetch") },
      (args) => result(() => money.fetchPaidResource({ url: args.url })),
      { annotations: { destructiveHint: true, openWorldHint: true } },
    ),
    tool(
      "list_transactions",
      "List this agent's latest payments, newest first, with amount, fee, counterparty and status.",
      { limit: z.number().int().min(1).max(50).optional().describe("How many to return (default 10)") },
      (args) => result(() => money.listTransactions(args.limit !== undefined ? { limit: args.limit } : {})),
      { annotations: { readOnlyHint: true } },
    ),
  ];
}

/** Fully qualified names of the money tools, as `allowedTools` expects them. */
export const ALLOWED_TOOLS = [
  "get_balance",
  "check_spend",
  "pay",
  "fetch_paid_resource",
  "list_transactions",
].map((name) => `mcp__${SERVER_NAME}__${name}`);

/** `query()` options that give Claude the money tools and nothing else. */
export function agentOptions(money: MoneyTools, overrides: Partial<Options> = {}): Options {
  return {
    model: process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    effort: "high",
    systemPrompt: INSTRUCTIONS,
    mcpServers: {
      [SERVER_NAME]: createSdkMcpServer({
        name: SERVER_NAME,
        version: "0.1.0",
        alwaysLoad: true,
        tools: moneyToolDefinitions(money),
      }),
    },
    tools: [], // no built-in tools: no shell, no file reads or writes, no web access
    allowedTools: ALLOWED_TOOLS, // pre-approve exactly the money tools
    permissionMode: "dontAsk", // anything not pre-approved is denied, never prompted
    strictMcpConfig: true, // ignore .mcp.json and user-level MCP servers
    settingSources: [], // ignore user and project settings and CLAUDE.md files
    maxTurns: 10,
    maxBudgetUsd: 1, // model spend cap for this run, separate from the USDC limits
    ...overrides,
  };
}

/** `query` itself, or a stand-in with the same shape (tests). */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** Run one task and return Claude's final answer. */
export async function runAgent(prompt: string, money: MoneyTools, run: QueryFn = query): Promise<string> {
  for await (const message of run({ prompt, options: agentOptions(money) })) {
    if (message.type !== "result") continue;
    if (message.subtype === "success") return message.result;
    throw new Error(`The agent stopped early (${message.subtype}): ${message.errors.join("; ")}`);
  }
  throw new Error("The agent finished without a result");
}
