/**
 * LangChain.js / LangGraph + Agent Bank quickstart (Claude via @langchain/anthropic).
 *
 *   export ANTHROPIC_API_KEY=…
 *   export AGENTBANK_ACCOUNT_ID=acct_… AGENTBANK_SESSION_ID=ses_…   # from the principal setup
 *   pnpm --filter @agentbank/example-langchain start "Buy the weather report at http://localhost:4021/weather"
 */
import { runAgent } from "./agent";
import { agentFromEnv, limitsFromEnv } from "./env";
import { MoneyTools } from "./money-tools";

const prompt =
  process.argv.slice(2).join(" ") ||
  "Check my balance. Then fetch http://localhost:4021/weather (it may ask for a small x402 payment) and tell me the weather.";

const money = new MoneyTools(await agentFromEnv(), limitsFromEnv());
console.log(await runAgent(prompt, money));
console.log(`\nUSDC committed this run: ${money.spent} (remaining budget ${money.remaining})`);
