# MCP server

`agentbank-mcp` (package `@agentbank/mcp`) gives any [Model Context Protocol](https://modelcontextprotocol.io) host the agent's **money tools**, over stdio for local agents or streamable HTTP for hosted ones. It holds only the agent's session key and, optionally, its x402 spend key. **Nothing it exposes can loosen a limit, change a policy, unfreeze an agent or withdraw to the owner**, and every payment is still checked by the owner's policy and co-signed by Agent Bank.

## Tools

| Tool                  | What it does                                                                                                       | Hints           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------- |
| `get_balance`         | Available, reserved, escrow, savings, spend float, fees and total, as decimal strings                              | read-only       |
| `check_spend`         | Dry-runs a payment against the policy: `allowed`, `outcome`, `approvers_required`, `rule_hits`                     | read-only       |
| `pay`                 | Pays exactly one of `to_address`, `to_agent_id`, `to_account_id`; waits briefly for settlement; returns the status | destructive     |
| `fetch_paid_resource` | Fetches a URL and pays an x402 challenge automatically, at most the per-call cap; returns status, body and payment | destructive     |
| `request_payment`     | Creates a payment request with a `pay_link` to share                                                               | not destructive |
| `create_escrow`       | Locks funds for a task (`payee_address` or `payee_agent_id`, expiry in hours, terms, optional arbiter)             | destructive     |
| `release_escrow`      | Releases a locked escrow to its payee                                                                              | destructive     |
| `list_transactions`   | The agent's payments, newest first, with `next_cursor`                                                             | read-only       |

Amounts are decimal strings in USDC (`"2.50"`), validated by pattern; ids are validated by prefix. `pay`, `create_escrow` and `release_escrow` accept an `idempotency_key`: a model that retries after a timeout with the same key never pays twice. The server also sends instructions to the model: amounts are decimal strings, use `check_spend` for large or unusual payments, a `policy_denied` refusal is final and must not be split into smaller payments, and approvals wait for a human.

Errors come back as tool errors (`isError: true`) whose text is `{"error": {"code", "detail", …}}`. Codes are the API's [problem codes](/guides/idempotency-and-errors#error-codes) (`policy_denied` adds the `rule_hits`; x402 failures add the `reason`), `timeout` and `network_error` for transport failures, and `invalid_request` for bad input. Stack traces and keys never appear.

## Configuration

The server reads its configuration from the environment and never logs, echoes or returns a key.

| Variable                      | Meaning                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `AGENTBANK_API_URL`           | API base URL (default `http://localhost:8080`)                                                                  |
| `AGENTBANK_ACCOUNT_ID`        | The agent's account (`acct_…`), required                                                                        |
| `AGENTBANK_SESSION_ID`        | The session (`ses_…`), required                                                                                 |
| `AGENTBANK_SESSION_KEY`       | The session private key, or use `AGENTBANK_KEYSTORE`                                                            |
| `AGENTBANK_KEYSTORE`          | Path of a 0600 key file holding `session:<ses_id>` (or `session`) and optionally `spend:<acct_id>` (or `spend`) |
| `AGENTBANK_SPEND_KEY`         | The x402 spend key; without one, `fetch_paid_resource` cannot pay                                               |
| `AGENTBANK_MAX_X402_PER_CALL` | Cap per paid request in USDC (default `1.00`); a tool call can only lower it                                    |
| `AGENTBANK_MCP_HTTP_TOKEN`    | Bearer token for `--http` (at least 16 characters; required when binding beyond loopback)                       |

The key file is the one the TypeScript SDK's `FileKeyStore` writes, for example in the [principal setup](/get-started/principal-setup#_7-hand-the-keys-to-the-agent).

## Running it

<!-- verify: npx -y @agentbank/mcp once the package is published -->

```bash
# Published package
npx -y @agentbank/mcp                      # stdio
npx -y @agentbank/mcp --http --port 8090   # streamable HTTP at http://127.0.0.1:8090/mcp

# From this repository
pnpm --filter @agentbank/mcp start                       # stdio, runs the TypeScript source
pnpm --filter @agentbank/mcp build && node packages/mcp/dist/cli.js --http
```

Logs go to stderr; on stdio, stdout carries only the protocol.

### HTTP transport security

The HTTP transport moves money, so it is locked down by default:

- It binds to `127.0.0.1`. Binding to any other interface (`--host 0.0.0.0`) **requires** `AGENTBANK_MCP_HTTP_TOKEN`; clients then send `Authorization: Bearer <token>`, compared in constant time.
- On loopback it accepts only `Host` headers naming `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS rebinding.
- Browser requests from non-loopback origins are refused (`Origin` check).
- It is stateless: each `POST /mcp` gets a fresh server instance; other methods get 405.

## Claude Code

Add it as a stdio server (`--scope project` writes `.mcp.json` for your team; `local`, the default, and `user` keep it to you):

```bash
claude mcp add agentbank --scope project \
  -e AGENTBANK_API_URL=http://localhost:8080 \
  -e AGENTBANK_ACCOUNT_ID=acct_01JABCDEFGHJKMNPQRSTVWXYZ0 \
  -e AGENTBANK_SESSION_ID=ses_01JABCDEFGHJKMNPQRSTVWXYZ0 \
  -e AGENTBANK_KEYSTORE=/absolute/path/to/.agentbank/agent.keystore.json \
  -- npx -y @agentbank/mcp
```

or point it at a running HTTP server:

```bash
claude mcp add --transport http agentbank http://127.0.0.1:8090/mcp \
  --header 'Authorization: Bearer ${AGENTBANK_MCP_HTTP_TOKEN}'
```

A project-scoped `.mcp.json` can use environment variables, so no ids or paths are committed:

```json
{
  "mcpServers": {
    "agentbank": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agentbank/mcp"],
      "env": {
        "AGENTBANK_API_URL": "${AGENTBANK_API_URL}",
        "AGENTBANK_ACCOUNT_ID": "${AGENTBANK_ACCOUNT_ID}",
        "AGENTBANK_SESSION_ID": "${AGENTBANK_SESSION_ID}",
        "AGENTBANK_KEYSTORE": "${AGENTBANK_KEYSTORE}"
      }
    }
  }
}
```

For HTTP use `"type": "http"`, `"url": "http://127.0.0.1:8090/mcp"` and `"headers": { "Authorization": "Bearer ${AGENTBANK_MCP_HTTP_TOKEN}" }`. Each person approves a project-scoped server the first time they use it. The tools appear as `mcp__agentbank__pay` and so on; leave `pay`, `fetch_paid_resource`, `create_escrow` and `release_escrow` on "ask" in your permission settings if you want to confirm each payment.

## Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config), then quit and restart Claude Desktop. The file lives at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

```json
{
  "mcpServers": {
    "agentbank": {
      "command": "npx",
      "args": ["-y", "@agentbank/mcp"],
      "env": {
        "AGENTBANK_API_URL": "http://localhost:8080",
        "AGENTBANK_ACCOUNT_ID": "acct_01JABCDEFGHJKMNPQRSTVWXYZ0",
        "AGENTBANK_SESSION_ID": "ses_01JABCDEFGHJKMNPQRSTVWXYZ0",
        "AGENTBANK_KEYSTORE": "/absolute/path/to/.agentbank/agent.keystore.json"
      }
    }
  }
}
```

Use literal values in this file. Claude Desktop adds remote servers as custom connectors, which must be reachable from the public internet, so use stdio for a local Agent Bank sandbox.

## Cursor

Add the server to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` for every project. Cursor interpolates `${env:NAME}`:

```json
{
  "mcpServers": {
    "agentbank": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agentbank/mcp"],
      "env": {
        "AGENTBANK_API_URL": "${env:AGENTBANK_API_URL}",
        "AGENTBANK_ACCOUNT_ID": "${env:AGENTBANK_ACCOUNT_ID}",
        "AGENTBANK_SESSION_ID": "${env:AGENTBANK_SESSION_ID}",
        "AGENTBANK_KEYSTORE": "${env:AGENTBANK_KEYSTORE}"
      }
    }
  }
}
```

For a running HTTP server:

```json
{
  "mcpServers": {
    "agentbank": {
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer ${env:AGENTBANK_MCP_HTTP_TOKEN}" }
    }
  }
}
```

## Any other client

Any MCP client works: run the command over stdio, or connect to `http://127.0.0.1:8090/mcp` with streamable HTTP. With the official TypeScript SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["-y", "@agentbank/mcp"],
    // Added to a minimal inherited environment (PATH, HOME, …), not to all of process.env.
    env: {
      AGENTBANK_ACCOUNT_ID: "acct_01JABCDEFGHJKMNPQRSTVWXYZ0",
      AGENTBANK_SESSION_ID: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0",
      AGENTBANK_KEYSTORE: "/absolute/path/to/.agentbank/agent.keystore.json",
    },
  }),
);
const result = await client.callTool({ name: "get_balance", arguments: {} });
```

The [Any MCP client quickstart](/quickstarts/mcp-client) is a runnable version that asks for confirmation before every money-moving tool.

## Embedding the server

The package also exports the server, for hosts that run tools in-process:

```ts
import { createAgentBankMcpServer, createAgentClient, loadConfig } from "@agentbank/mcp";

const config = await loadConfig();
const server = createAgentBankMcpServer(createAgentClient(config), { maxX402PerCall: config.maxX402PerCall });
```

`createAgentBankMcpServer(backend, options)` takes any object with the `AgentClient` methods it uses, which is how its tests run without a network.
