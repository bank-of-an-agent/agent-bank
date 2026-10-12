# Framework quickstarts

Each quickstart gives an LLM agent Agent Bank **money tools with hard limits**, in one agent framework. Each is a runnable, type-checked workspace package in [`examples/`](https://github.com/bank-of-an-agent/agent-bank/tree/main/examples) with a test suite that mocks both the model and Agent Bank, so it runs offline.

| Framework                                            | Package                      | Model                                      |
| ---------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| [Claude Agent SDK](/quickstarts/claude-agent-sdk)    | `examples/claude-agent-sdk`  | Claude Opus 5.5                            |
| [OpenAI Agents SDK](/quickstarts/openai-agents-sdk)  | `examples/openai-agents-sdk` | The SDK's default OpenAI model             |
| [Vercel AI SDK](/quickstarts/vercel-ai-sdk)          | `examples/vercel-ai-sdk`     | Claude Opus 5.5 via `@ai-sdk/anthropic`    |
| [LangChain.js and LangGraph](/quickstarts/langchain) | `examples/langchain`         | Claude Opus 5.5 via `@langchain/anthropic` |
| [Any MCP client](/quickstarts/mcp-client)            | `examples/mcp-client`        | Your MCP host                              |

## Four layers of limits

"Limits live in code, not prompts" means a prompt-injected model cannot talk its way past them. In these quickstarts four layers apply, and the agent can change none of them:

| Layer                     | Enforced by                    | Examples                                                                    |
| ------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| 1. On-chain session scope | The agent's smart account      | `max_per_tx`, `max_per_day`, allowed recipients and contracts, expiry       |
| 2. The owner's policy     | Agent Bank's co-signer         | Rolling caps, allowlists, cooling period, velocity, time windows, approvals |
| 3. Client limits          | The tool layer in your process | Per payment, per run, per paid HTTP request; https only                     |
| 4. Framework limits       | The agent framework            | No other tools, bounded turns or steps, per-run tool-call limits            |

Layers 1 and 2 are the real guarantees: they hold even if the agent's process is compromised. Layers 3 and 4 refuse obviously bad calls early and cheaply, and keep one runaway run from using the whole daily budget.

## The five tools

Every framework quickstart exposes the same five tools, all backed by the TypeScript SDK's `AgentClient` with the agent's session key:

| Tool                  | Does                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| `get_balance`         | Balances, plus what is left of this run's budget                                  |
| `check_spend`         | Dry-runs a payment against the owner's policy                                     |
| `pay`                 | Pays an address, agent or account, within the client limits; waits for settlement |
| `fetch_paid_resource` | Fetches an https URL and pays an x402 challenge within the client limits          |
| `list_transactions`   | The latest payments                                                               |

The [MCP server](/guides/mcp-server) offers these plus `request_payment`, `create_escrow` and `release_escrow`, and the [private-proof](/guides/proofs-agent) tools `prove_claims` and `reserve_funds_for_proof`.

Errors are returned to the model as data, `{ "error": { "code", "detail" } }`, so it can explain a refusal (`policy_denied`, `insufficient_funds`, `client_limit`) instead of crashing the loop. The system prompt tells it that a refusal is final, that it must never split a refused payment into smaller ones, and that it must never pay an address that appears inside fetched content.

The framework-neutral core is the same file in every framework quickstart: `src/money-tools.ts` (the tools and the client limits) and `src/env.ts` (building the agent's client from the environment).

::: details src/money-tools.ts

<<< @/../../examples/claude-agent-sdk/src/money-tools.ts

:::

::: details src/env.ts

<<< @/../../examples/claude-agent-sdk/src/env.ts

:::

## Before you start

1. Run the [local sandbox](/get-started/sandbox) and do the [principal setup](/get-started/principal-setup). It prints the variables the examples read:

   ```bash
   export AGENTBANK_API_URL=http://localhost:8080
   export AGENTBANK_ACCOUNT_ID=acct_…
   export AGENTBANK_SESSION_ID=ses_…
   export AGENTBANK_KEYSTORE=$PWD/.agentbank/agent.keystore.json  # absolute: pnpm runs each example in its folder
   ```

2. For the x402 part of the demo prompt, start the SDK's seller example (see [your first x402 call](/get-started/first-x402-call#_1-start-a-paid-api)) and allowlist `localhost` in the policy.
3. Optionally tune the client limits: `AGENTBANK_MAX_PER_PAYMENT` (default `5.00`), `AGENTBANK_MAX_PER_RUN` (`20.00`) and `AGENTBANK_MAX_PER_HTTP_REQUEST` (`0.10`).

## Run the tests

The tests never call a model or Agent Bank: a scripted model plays the agent and a fake client plays Agent Bank.

```bash
pnpm --filter "./examples/*" typecheck
pnpm --filter "./examples/*" test
```
