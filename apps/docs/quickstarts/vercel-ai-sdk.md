# Vercel AI SDK

Give an agent built with the [Vercel AI SDK](https://ai-sdk.dev) (`ai`) Agent Bank money tools, running on Claude through `@ai-sdk/anthropic`. The runnable package is [`examples/vercel-ai-sdk`](https://github.com/bank-of-an-agent/agent-bank/tree/main/examples/vercel-ai-sdk).

## Install

In this repository the example is a workspace package; `pnpm install` at the root is enough. In your own project:

```bash
npm install ai @ai-sdk/anthropic zod @agentbank/sdk viem
```

Copy `src/money-tools.ts` and `src/env.ts` from the [quickstarts overview](/quickstarts/#the-five-tools), and set `ANTHROPIC_API_KEY`.

## The agent

<<< @/../../examples/vercel-ai-sdk/src/agent.ts

- `tool({ description, inputSchema, execute })` validates arguments with Zod before `execute` runs; results and errors go back to the model as JSON.
- `stopWhen: isStepCount(10)` bounds the tool loop.
- The model is Claude Opus 5.5 (`claude-opus-5-5`, override with `CLAUDE_MODEL`) with `effort: "high"`. `fallbacks: "default"` turns on Anthropic's server-side refusal fallback, which reroutes a request the model declines by refusal category; the provider adds the beta header for you.
- Claude Opus 5.5 always thinks adaptively and rejects forced tool choice, so the example leaves `toolChoice` at its default (`auto`) and sets no sampling parameters.

## Run it

```bash
export ANTHROPIC_API_KEY=…
pnpm --filter @agentbank/example-vercel-ai-sdk start \
  "Check my balance, then fetch http://localhost:4021/weather and tell me the weather."
```

## Requiring a human for payments

The AI SDK can stop the loop for approval: give the `pay` tool `needsApproval`, and the step ends with a tool-approval request that your UI answers before the next call. For an approval at the bank instead, for every client of the agent, use the owner's [approval thresholds](/concepts/approvals).

## Using the MCP server instead

The AI SDK's MCP client (the `@ai-sdk/mcp` package) can connect to `agentbank-mcp` over stdio or streamable HTTP and hand its tools to `generateText`. The [MCP server guide](/guides/mcp-server) has the command, the environment and the security settings.

## Test

The test runs the real `generateText` loop against the AI SDK's `MockLanguageModelV4`, scripted to call `pay` and then answer, with a fake Agent Bank client; it checks that the tool ran within limits, that over-limit and denied payments reach the model as errors, and that the fallback option is sent:

```bash
pnpm --filter @agentbank/example-vercel-ai-sdk test
```

<<< @/../../examples/vercel-ai-sdk/test/agent.test.ts
