# Framework quickstarts

Runnable agents that get Agent Bank money tools with hard spending limits. Each package
type-checks and has tests with the model and Agent Bank mocked; the
[docs](../apps/docs/quickstarts) embed their code.

| Package                                  | Framework                                            |
| ---------------------------------------- | ---------------------------------------------------- |
| [`claude-agent-sdk`](claude-agent-sdk)   | Claude Agent SDK (TypeScript), in-process MCP server |
| [`openai-agents-sdk`](openai-agents-sdk) | OpenAI Agents SDK                                    |
| [`vercel-ai-sdk`](vercel-ai-sdk)         | Vercel AI SDK with Claude                            |
| [`langchain`](langchain)                 | LangChain.js / LangGraph with Claude                 |
| [`mcp-client`](mcp-client)               | Any MCP client over stdio or streamable HTTP         |

```bash
pnpm --filter "./examples/*" typecheck
pnpm --filter "./examples/*" test
pnpm --filter @agentbank/example-claude-agent-sdk start "Buy today's weather report"
```

Set `AGENTBANK_API_URL`, `AGENTBANK_ACCOUNT_ID`, `AGENTBANK_SESSION_ID` and either
`AGENTBANK_KEYSTORE` or `AGENTBANK_SESSION_KEY` / `AGENTBANK_SPEND_KEY` (from
`packages/sdk-ts/examples/principal-setup.ts`), plus `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
Optional client-side caps: `AGENTBANK_MAX_PER_PAYMENT`, `AGENTBANK_MAX_PER_RUN`,
`AGENTBANK_MAX_PER_HTTP_REQUEST`.
