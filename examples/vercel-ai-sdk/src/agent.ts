/**
 * Agent Bank money tools for the Vercel AI SDK, running on Claude through
 * `@ai-sdk/anthropic`. Each tool wraps the framework-neutral `MoneyTools`,
 * so the client-side limits apply before anything reaches Agent Bank, and
 * the owner's policy and the on-chain session scope apply after.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount, tool, type LanguageModel } from "ai";
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

/** The five money tools, bound to one agent and one run's budget. */
export function moneyTools(money: MoneyTools) {
  const run = (fn: () => Promise<ToolOutput>) => safely(fn);
  return {
    get_balance: tool({
      description:
        "Get this agent's USDC balances: available, reserved for pending payments, in escrow, the x402 spend float, and what is left of this run's budget.",
      inputSchema: z.object({}),
      execute: () => run(() => money.getBalance()),
    }),
    check_spend: tool({
      description:
        "Ask whether a payment would be allowed by the owner's policy, without moving money. Returns allow, deny, require_approval or require_owner and the rules that fired.",
      inputSchema: z.object({
        amount: Amount,
        to: Recipient.optional(),
        x402_domain: z
          .string()
          .max(253)
          .optional()
          .describe("Hostname of a paid API, e.g. api.example-data.com"),
      }),
      execute: (input) =>
        run(() =>
          money.checkSpend({
            amount: input.amount,
            ...(input.to ? { to: input.to } : {}),
            ...(input.x402_domain ? { x402Domain: input.x402_domain } : {}),
          }),
        ),
    }),
    pay: tool({
      description:
        "Send USDC to exactly one recipient. The owner's policy is enforced and Agent Bank co-signs; a 0.20% fee applies. Returns the payment status: settled, submitted or requires_approval. Payments cannot be undone.",
      inputSchema: z.object({
        to: Recipient,
        amount: Amount,
        memo: z.string().max(500).optional().describe("What the payment is for (visible to the owner)"),
      }),
      execute: (input) =>
        run(() =>
          money.pay({ to: input.to, amount: input.amount, ...(input.memo ? { memo: input.memo } : {}) }),
        ),
    }),
    fetch_paid_resource: tool({
      description:
        "Fetch an https URL. If it answers 402 Payment Required with an x402 offer, pay it automatically within this agent's limits and return the response body.",
      inputSchema: z.object({ url: z.url().describe("https URL to fetch") }),
      execute: (input) => run(() => money.fetchPaidResource({ url: input.url })),
    }),
    list_transactions: tool({
      description:
        "List this agent's latest payments, newest first, with amount, fee, counterparty and status.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe("How many to return (default 10)"),
      }),
      execute: (input) =>
        run(() => money.listTransactions(input.limit !== undefined ? { limit: input.limit } : {})),
    }),
  };
}

/** Run one task and return Claude's final answer. `maxSteps` bounds the tool loop. */
export async function runAgent(
  prompt: string,
  money: MoneyTools,
  options: { model?: LanguageModel; maxSteps?: number } = {},
): Promise<string> {
  const result = await generateText({
    model: options.model ?? anthropic(process.env.CLAUDE_MODEL ?? DEFAULT_MODEL),
    instructions: INSTRUCTIONS,
    prompt,
    tools: moneyTools(money),
    stopWhen: isStepCount(options.maxSteps ?? 10),
    providerOptions: {
      // Server-side refusal fallback ("default" routes by refusal category; the provider adds the beta header).
      anthropic: { effort: "high", fallbacks: "default" },
    },
  });
  return result.text;
}
