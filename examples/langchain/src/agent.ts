/**
 * Agent Bank money tools for LangChain.js, run by `createAgent` (a LangGraph
 * graph) on Claude through `@langchain/anthropic`. Each tool wraps the
 * framework-neutral `MoneyTools`, so the client-side limits apply before
 * anything reaches Agent Bank, and the owner's policy and the on-chain
 * session scope apply after. LangChain middleware adds two more brakes: at
 * most three `pay` calls and twelve model calls per run.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createAgent, modelCallLimitMiddleware, tool, toolCallLimitMiddleware } from "langchain";
import { z } from "zod";
import { INSTRUCTIONS, safely, type MoneyTools, type ToolOutput } from "./money-tools";

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

async function output(fn: () => Promise<ToolOutput>): Promise<string> {
  return JSON.stringify(await safely(fn));
}

/** The five money tools, bound to one agent and one run's budget. */
export function moneyTools(money: MoneyTools) {
  return [
    tool(() => output(() => money.getBalance()), {
      name: "get_balance",
      description:
        "Get this agent's USDC balances: available, reserved for pending payments, in escrow, the x402 spend float, and what is left of this run's budget.",
      schema: z.object({}),
    }),
    tool(
      (input) =>
        output(() =>
          money.checkSpend({
            amount: input.amount,
            ...(input.to ? { to: input.to } : {}),
            ...(input.x402_domain ? { x402Domain: input.x402_domain } : {}),
          }),
        ),
      {
        name: "check_spend",
        description:
          "Ask whether a payment would be allowed by the owner's policy, without moving money. Returns allow, deny, require_approval or require_owner and the rules that fired.",
        schema: z.object({
          amount: Amount,
          to: Recipient.optional(),
          x402_domain: z
            .string()
            .max(253)
            .optional()
            .describe("Hostname of a paid API, e.g. api.example-data.com"),
        }),
      },
    ),
    tool(
      (input) =>
        output(() =>
          money.pay({ to: input.to, amount: input.amount, ...(input.memo ? { memo: input.memo } : {}) }),
        ),
      {
        name: "pay",
        description:
          "Send USDC to exactly one recipient. The owner's policy is enforced and Agent Bank co-signs; a 0.20% fee applies. Returns the payment status: settled, submitted or requires_approval. Payments cannot be undone.",
        schema: z.object({
          to: Recipient,
          amount: Amount,
          memo: z.string().max(500).optional().describe("What the payment is for (visible to the owner)"),
        }),
      },
    ),
    tool((input) => output(() => money.fetchPaidResource({ url: input.url })), {
      name: "fetch_paid_resource",
      description:
        "Fetch an https URL. If it answers 402 Payment Required with an x402 offer, pay it automatically within this agent's limits and return the response body.",
      schema: z.object({ url: z.url().describe("https URL to fetch") }),
    }),
    tool(
      (input) =>
        output(() => money.listTransactions(input.limit !== undefined ? { limit: input.limit } : {})),
      {
        name: "list_transactions",
        description:
          "List this agent's latest payments, newest first, with amount, fee, counterparty and status.",
        schema: z.object({
          limit: z.number().int().min(1).max(50).optional().describe("How many to return (default 10)"),
        }),
      },
    ),
  ];
}

/** Claude Opus 5.5 with high effort and server-side refusal fallbacks. Needs `ANTHROPIC_API_KEY`. */
export function claude(): ChatAnthropic {
  return new ChatAnthropic({
    model: process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    outputConfig: { effort: "high" },
    betas: ["server-side-fallback-2026-07-01"],
    invocationKwargs: { fallbacks: "default" },
  });
}

/** A LangGraph agent with the money tools and per-run call limits. */
export function createBuyerAgent(money: MoneyTools, model: BaseChatModel = claude()) {
  return createAgent({
    model,
    tools: moneyTools(money),
    systemPrompt: INSTRUCTIONS,
    middleware: [
      toolCallLimitMiddleware({ toolName: "pay", runLimit: 3 }),
      modelCallLimitMiddleware({ runLimit: 12, exitBehavior: "end" }),
    ],
  });
}

/** Run one task and return the agent's final answer. */
export async function runAgent(prompt: string, money: MoneyTools, model?: BaseChatModel): Promise<string> {
  const agent = createBuyerAgent(money, model);
  const state = await agent.invoke({ messages: [{ role: "user", content: prompt }] });
  const last = state.messages.at(-1);
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
}
