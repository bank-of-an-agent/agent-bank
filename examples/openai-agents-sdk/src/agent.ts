/**
 * Agent Bank money tools for the OpenAI Agents SDK. Each tool wraps the
 * framework-neutral `MoneyTools`, so the client-side limits apply before
 * anything reaches Agent Bank, and the owner's policy and the on-chain
 * session scope apply after.
 */
import { Agent, run, tool, type Model } from "@openai/agents";
import { z } from "zod";
import { INSTRUCTIONS, safely, type MoneyTools, type ToolOutput } from "./money-tools";

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
    tool({
      name: "get_balance",
      description:
        "Get this agent's USDC balances: available, reserved for pending payments, in escrow, the x402 spend float, and what is left of this run's budget.",
      parameters: z.object({}),
      execute: () => output(() => money.getBalance()),
    }),
    tool({
      name: "check_spend",
      description:
        "Ask whether a payment would be allowed by the owner's policy, without moving money. Returns allow, deny, require_approval or require_owner and the rules that fired.",
      parameters: z.object({
        amount: Amount,
        to: Recipient.optional(),
        x402_domain: z
          .string()
          .max(253)
          .optional()
          .describe("Hostname of a paid API, e.g. api.example-data.com"),
      }),
      execute: (input) =>
        output(() =>
          money.checkSpend({
            amount: input.amount,
            ...(input.to ? { to: input.to } : {}),
            ...(input.x402_domain ? { x402Domain: input.x402_domain } : {}),
          }),
        ),
    }),
    tool({
      name: "pay",
      description:
        "Send USDC to exactly one recipient. The owner's policy is enforced and Agent Bank co-signs; a 0.20% fee applies. Returns the payment status: settled, submitted or requires_approval. Payments cannot be undone.",
      parameters: z.object({
        to: Recipient,
        amount: Amount,
        memo: z.string().max(500).optional().describe("What the payment is for (visible to the owner)"),
      }),
      execute: (input) =>
        output(() =>
          money.pay({ to: input.to, amount: input.amount, ...(input.memo ? { memo: input.memo } : {}) }),
        ),
    }),
    tool({
      name: "fetch_paid_resource",
      description:
        "Fetch an https URL. If it answers 402 Payment Required with an x402 offer, pay it automatically within this agent's limits and return the response body.",
      parameters: z.object({ url: z.url().describe("https URL to fetch") }),
      execute: (input) => output(() => money.fetchPaidResource({ url: input.url })),
    }),
    tool({
      name: "list_transactions",
      description:
        "List this agent's latest payments, newest first, with amount, fee, counterparty and status.",
      parameters: z.object({
        limit: z.number().int().min(1).max(50).optional().describe("How many to return (default 10)"),
      }),
      execute: (input) =>
        output(() => money.listTransactions(input.limit !== undefined ? { limit: input.limit } : {})),
    }),
  ];
}

/** An agent with the money tools. `model` defaults to the SDK's default OpenAI model (or `OPENAI_MODEL`). */
export function createBuyerAgent(money: MoneyTools, model?: string | Model): Agent {
  const chosen = model ?? process.env.OPENAI_MODEL;
  return new Agent({
    name: "Agent Bank buyer",
    instructions: INSTRUCTIONS,
    tools: moneyTools(money),
    ...(chosen ? { model: chosen } : {}),
  });
}

/** Run one task and return the agent's final answer. `maxTurns` bounds the tool loop. */
export async function runAgent(
  prompt: string,
  money: MoneyTools,
  options: { model?: string | Model; maxTurns?: number } = {},
): Promise<string> {
  const result = await run(createBuyerAgent(money, options.model), prompt, {
    maxTurns: options.maxTurns ?? 10,
  });
  return String(result.finalOutput ?? "");
}
