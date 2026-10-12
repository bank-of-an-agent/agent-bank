# LangChain.js and LangGraph

Give an agent built with LangChain.js Agent Bank money tools. `createAgent` (from `langchain`) builds a LangGraph agent graph; the model is Claude through `@langchain/anthropic`, and LangChain middleware adds per-run call limits. The runnable package is [`examples/langchain`](https://github.com/bank-of-an-agent/agent-bank/tree/main/examples/langchain).

## Install

In this repository the example is a workspace package; `pnpm install` at the root is enough. In your own project:

```bash
npm install langchain @langchain/core @langchain/anthropic @langchain/langgraph zod @agentbank/sdk viem
```

Copy `src/money-tools.ts` and `src/env.ts` from the [quickstarts overview](/quickstarts/#the-five-tools), and set `ANTHROPIC_API_KEY`.

## The agent

<<< @/../../examples/langchain/src/agent.ts

- `tool(fn, { name, description, schema })` validates arguments with Zod before the function runs; results and errors go back to the model as JSON.
- `toolCallLimitMiddleware({ toolName: "pay", runLimit: 3 })` lets one run make at most three `pay` calls; further calls are answered with an error message instead of running. `modelCallLimitMiddleware({ runLimit: 12 })` bounds the loop.
- The model is Claude Opus 5.5 (`claude-opus-5-5`, override with `CLAUDE_MODEL`) with `effort: "high"`, and Anthropic's server-side refusal fallback (`fallbacks: "default"` with its beta header). The example sets no sampling parameters and no forced tool choice, which Claude Opus 5.5 rejects.

## Run it

```bash
export ANTHROPIC_API_KEY=…
pnpm --filter @agentbank/example-langchain start \
  "Check my balance, then fetch http://localhost:4021/weather and tell me the weather."
```

## Requiring a human for payments

Because `createAgent` is a LangGraph graph, `humanInTheLoopMiddleware` can interrupt the run before `pay` executes and resume it after a person approves; it needs a checkpointer to hold the paused state. For an approval at the bank instead, for every client of the agent, use the owner's [approval thresholds](/concepts/approvals).

## Using the MCP server instead

LangChain's MCP adapters (`@langchain/mcp-adapters`) load the tools of `agentbank-mcp` as LangChain tools over stdio or streamable HTTP. The [MCP server guide](/guides/mcp-server) has the command, the environment and the security settings.

## Test

The test runs the real agent graph with LangChain's `fakeModel()`, scripted to call `pay` and then answer, against a fake Agent Bank client. It checks the client limits, that a policy denial reaches the model as data, and that the fourth `pay` call in a run is blocked:

```bash
pnpm --filter @agentbank/example-langchain test
```

<<< @/../../examples/langchain/test/agent.test.ts
