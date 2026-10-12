# Claude Agent SDK

Give a Claude agent built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`) Agent Bank money tools, as an **in-process MCP server**, with every built-in tool switched off. The runnable package is [`examples/claude-agent-sdk`](https://github.com/bank-of-an-agent/agent-bank/tree/main/examples/claude-agent-sdk).

## Install

In this repository the example is a workspace package; `pnpm install` at the root is enough. In your own project:

```bash
npm install @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @modelcontextprotocol/sdk zod @agentbank/sdk viem
```

Copy `src/money-tools.ts` and `src/env.ts` from the [quickstarts overview](/quickstarts/#the-five-tools), and set `ANTHROPIC_API_KEY`.

## The agent

<<< @/../../examples/claude-agent-sdk/src/agent.ts

What the options do:

| Option                                       | Why                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model: "claude-opus-5-5"`, `effort: "high"` | Claude Opus 5.5; override with `CLAUDE_MODEL`                                                                                                                              |
| `mcpServers` with `createSdkMcpServer`       | The money tools run in your process; the model sees them as `mcp__agentbank__pay` and so on. `alwaysLoad` keeps the five tools in the prompt instead of behind tool search |
| `tools: []`                                  | Removes every built-in tool: no shell, no file reads or writes, no web fetch outside `fetch_paid_resource`                                                                 |
| `allowedTools`                               | Pre-approves exactly the five money tools                                                                                                                                  |
| `permissionMode: "dontAsk"`                  | Anything not pre-approved is denied instead of prompting                                                                                                                   |
| `strictMcpConfig`, `settingSources: []`      | Ignores `.mcp.json`, user MCP servers, settings files and `CLAUDE.md` on the machine                                                                                       |
| `maxTurns: 10`, `maxBudgetUsd: 1`            | Bounds the loop and the model spend of one run (separate from the USDC limits)                                                                                             |

## Run it

```bash
export ANTHROPIC_API_KEY=…
pnpm --filter @agentbank/example-claude-agent-sdk start \
  "Check my balance, then fetch http://localhost:4021/weather and tell me the weather."
```

<<< @/../../examples/claude-agent-sdk/src/main.ts

## Requiring a human for payments

To have a person confirm each payment instead of pre-approving it, leave `mcp__agentbank__pay` out of `allowedTools`, keep the default permission mode, and decide in `canUseTool`:

```ts
const options = agentOptions(money, {
  allowedTools: ALLOWED_TOOLS.filter((name) => name !== "mcp__agentbank__pay"),
  permissionMode: "default",
  canUseTool: async (toolName, input) =>
    toolName === "mcp__agentbank__pay" &&
    (await askHuman(`Pay ${String(input.amount)} USDC to ${String(input.to)}?`))
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user did not approve this payment." },
});
```

The owner's [approval thresholds](/concepts/approvals) do the same at the bank, for every client of the agent, with passkeys.

## Using the MCP server instead

The Agent SDK can also launch `agentbank-mcp` over stdio, which adds `request_payment`, `create_escrow` and `release_escrow`:

```ts
const options: Options = {
  model: "claude-opus-5-5",
  mcpServers: {
    agentbank: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@agentbank/mcp"],
      env: {
        PATH: process.env.PATH ?? "",
        AGENTBANK_API_URL: process.env.AGENTBANK_API_URL ?? "http://localhost:8080",
        AGENTBANK_ACCOUNT_ID: process.env.AGENTBANK_ACCOUNT_ID!,
        AGENTBANK_SESSION_ID: process.env.AGENTBANK_SESSION_ID!,
        AGENTBANK_KEYSTORE: process.env.AGENTBANK_KEYSTORE!,
        AGENTBANK_MAX_X402_PER_CALL: "0.10",
      },
    },
  },
  tools: [],
  allowedTools: [
    "mcp__agentbank__get_balance",
    "mcp__agentbank__check_spend",
    "mcp__agentbank__list_transactions",
  ],
  permissionMode: "default", // money-moving tools go through canUseTool
};
```

::: tip Not on npm yet
`@agentbank/mcp` is not published yet. Until it is, build it from the repository (`pnpm --filter @agentbank/mcp build`) and run `node packages/mcp/dist/cli.js` instead of `npx -y @agentbank/mcp`.
:::

## Test

The test connects an MCP client to the same in-process server the agent gets, with a fake Agent Bank client, and replaces `query` with a stub that yields a result message, so it never calls Claude or Agent Bank:

```bash
pnpm --filter @agentbank/example-claude-agent-sdk test
```

<<< @/../../examples/claude-agent-sdk/test/agent.test.ts
