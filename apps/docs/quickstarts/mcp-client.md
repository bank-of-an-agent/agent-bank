# Any MCP client

Every MCP host can give its model Agent Bank's money tools through `agentbank-mcp`: Claude Code, Claude Desktop, Cursor, the Claude Agent SDK, the OpenAI Agents SDK, LangChain's MCP adapters, or a client you write. This quickstart is a minimal client with the official TypeScript MCP SDK that lists the tools, reads the balance, dry-runs a payment and pays only after you confirm on the terminal. The runnable package is [`examples/mcp-client`](https://github.com/bank-of-an-agent/agent-bank/tree/main/examples/mcp-client).

For ready-made host configurations (Claude Code, Claude Desktop, Cursor), see the [MCP server guide](/guides/mcp-server).

## The client

<<< @/../../examples/mcp-client/src/client.ts

- **Transport.** Stdio by default: the client starts the server as a child process and passes it only the `AGENTBANK_*` variables it needs, not your whole environment. Set `AGENTBANK_MCP_URL` (and `AGENTBANK_MCP_HTTP_TOKEN`) to use a server started with `agentbank-mcp --http`.
- **Confirmation.** MCP tools carry hints: the server marks `get_balance`, `check_spend`, `list_transactions` and `prove_claims` read-only and `pay`, `fetch_paid_resource`, `create_escrow`, `release_escrow` and `reserve_funds_for_proof` destructive. `callTool` asks before running anything that moves money; a host with no human in the loop can plug a policy into `confirm` instead.
- **Errors as data.** Tool errors come back as `{ "error": { "code", "detail" } }` with `ok: false`.

## Run it

```bash
export AGENTBANK_ACCOUNT_ID=acct_… AGENTBANK_SESSION_ID=ses_… AGENTBANK_KEYSTORE=$PWD/.agentbank/agent.keystore.json
pnpm --filter @agentbank/example-mcp-client start 0x2222222222222222222222222222222222222222 1.00
```

By default it runs `npx -y @agentbank/mcp`, which works once the package is published. Until then (and inside this repository), build the server and point the client at it:

```bash
pnpm --filter @agentbank/mcp build
AGENTBANK_MCP_COMMAND="node $PWD/packages/mcp/dist/cli.js" pnpm --filter @agentbank/example-mcp-client start
```

<<< @/../../examples/mcp-client/src/main.ts

## The limits

The server enforces its own cap on paid HTTP requests (`AGENTBANK_MAX_X402_PER_CALL`, default 1.00 USDC; a tool call can only lower it), and it exposes no tool that could change a limit or move money to the owner. The owner's policy and the session's on-chain scope apply to every payment, whichever client asks. The confirmation step in this client is one more layer, for hosts with a person present.

## Test

The test connects the client to the real `@agentbank/mcp` server over an in-memory transport, with a fake Agent Bank client behind it, so no process, network or key is involved:

```bash
pnpm --filter @agentbank/example-mcp-client test
```

<<< @/../../examples/mcp-client/test/client.test.ts
