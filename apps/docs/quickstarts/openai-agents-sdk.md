# OpenAI Agents SDK

Give an agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (`@openai/agents`) Agent Bank money tools as function tools, with client-side limits on every payment. The runnable package is [`examples/openai-agents-sdk`](https://github.com/bank-of-an-agent/agent-bank/tree/main/examples/openai-agents-sdk).

## Install

In this repository the example is a workspace package; `pnpm install` at the root is enough. In your own project:

```bash
npm install @openai/agents zod @agentbank/sdk viem
```

Copy `src/money-tools.ts` and `src/env.ts` from the [quickstarts overview](/quickstarts/#the-five-tools), and set `OPENAI_API_KEY`.

## The agent

<<< @/../../examples/openai-agents-sdk/src/agent.ts

- Each `tool()` validates its arguments with Zod (amounts must be decimal strings, recipients must be an address, agent id or account id) before `execute` runs, and `execute` returns the result or the error as JSON for the model.
- The agent gets the five money tools and nothing else; `maxTurns` bounds the loop.
- The model is the SDK's default unless you set `OPENAI_MODEL` or pass a model.

## Run it

```bash
export OPENAI_API_KEY=…
pnpm --filter @agentbank/example-openai-agents-sdk start \
  "Check my balance, then fetch http://localhost:4021/weather and tell me the weather."
```

The Agents SDK exports traces to OpenAI by default; call `setTracingDisabled(true)` if you do not want payment details in traces.

## Requiring a human for payments

The Agents SDK can pause a run for approval. Add `needsApproval` to the `pay` tool, for example for payments above 1.00 USDC:

```ts
import { parseAmount } from "@agentbank/sdk";

tool({
  name: "pay",
  // …description, parameters and execute as above…
  needsApproval: async (_context, input) => parseAmount(input.amount, 6) > 1_000_000n, // above 1.00 USDC
});
```

The run then returns with `result.interruptions`; approve or reject them on `result.state` and run again with that state. The owner's [approval thresholds](/concepts/approvals) do the same at the bank, for every client of the agent.

## Using the MCP server instead

```ts
import { Agent, MCPServerStdio, run } from "@openai/agents";

const agentbank = new MCPServerStdio({
  name: "agentbank",
  command: "npx",
  args: ["-y", "@agentbank/mcp"],
  env: {
    AGENTBANK_ACCOUNT_ID: process.env.AGENTBANK_ACCOUNT_ID!,
    AGENTBANK_SESSION_ID: process.env.AGENTBANK_SESSION_ID!,
    AGENTBANK_KEYSTORE: process.env.AGENTBANK_KEYSTORE!,
    AGENTBANK_MAX_X402_PER_CALL: "0.10",
  },
});
await agentbank.connect();
try {
  const agent = new Agent({ name: "Agent Bank buyer", instructions: INSTRUCTIONS, mcpServers: [agentbank] });
  console.log((await run(agent, "What is my balance?", { maxTurns: 10 })).finalOutput);
} finally {
  await agentbank.close();
}
```

::: tip Not on npm yet
`@agentbank/mcp` is not published yet. Until it is, build it from the repository (`pnpm --filter @agentbank/mcp build`) and run `node packages/mcp/dist/cli.js` instead of `npx -y @agentbank/mcp`.
:::

## Test

The test drives a real `run()` with the SDK's `ScriptedModel`, which replays scripted tool calls and answers instead of calling OpenAI, against a fake Agent Bank client:

```bash
pnpm --filter @agentbank/example-openai-agents-sdk test
```

<<< @/../../examples/openai-agents-sdk/test/agent.test.ts
