# @agentbank/mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents **money tools** backed by
an Agent Bank account: check balances, dry-run a payment against the owner's policy, pay, buy
x402-protected HTTP resources, request payments, escrow, list transactions, and prove facts about
the agent privately (zero-knowledge). Every limit is enforced by Agent Bank and on-chain, not by
the model.

> [!NOTE]
> Pre-release, testnet only (Base Sepolia). Not yet published to npm: build from this
> repository (`pnpm --filter @agentbank/mcp build`, then run `dist/cli.js`).

## Tools

| Tool                               | What it does                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `get_balance`                      | Available, reserved, escrowed and saved USDC                                                 |
| `check_spend`                      | Dry-run a payment against the owner's policy (outcome and rule hits)                         |
| `pay`                              | Pay an address or another agent (create → session signature → co-sign → settle)              |
| `fetch_paid_resource`              | Fetch a URL; answer its proof challenge (401) and pay its x402 challenge, capped per call    |
| `request_payment`                  | Create a payment request with a pay link                                                     |
| `create_escrow` / `release_escrow` | Lock funds for a task, then release them to the payee                                        |
| `list_transactions`                | Recent ledger entries                                                                        |
| `prove_claims`                     | Answer a verifier's proof request privately; returns the `AGENT-PROOF` header to send        |
| `reserve_funds_for_proof`          | Hold funds for one verifier (at most 7 days) so the agent can prove they are reserved for it |

Agents get money tools only: nothing here can loosen limits, change policy or disclosure, or
withdraw to the owner. Errors come back as tool errors with the problem `code` and `detail`.

`prove_claims` reveals only that the verifier's constraints hold, plus a per-verifier pseudonym
(the nullifier); not which agent, account or company it is, nor the values. The SDK refuses more
than 30 proofs per verifier and hour, and `fetch_paid_resource` only proves to the URL's own host.
Proofs need `AGENTBANK_PROOF_SECRET`, the owner enabling proofs for the agent, and the secret's
commitment enrolled once (`agent.proofs.enroll()` with the SDK); see
[private proofs](../../docs/private-proofs.md).

## Usage

```bash
export AGENTBANK_API_URL=http://localhost:8080
export AGENTBANK_ACCOUNT_ID=acct_…
export AGENTBANK_SESSION_ID=ses_…
export AGENTBANK_KEYSTORE=.agentbank/agent.keystore.json   # 0600 file with session:<ses_id>, spend, proof

agentbank-mcp                 # stdio, for local agents
agentbank-mcp --http          # streamable HTTP at http://127.0.0.1:8090/mcp
```

Claude Code / Claude Desktop (`mcpServers` entry):

```json
{
  "agentbank": {
    "command": "node",
    "args": ["/path/to/agent-bank/packages/mcp/dist/cli.js"],
    "env": {
      "AGENTBANK_API_URL": "http://localhost:8080",
      "AGENTBANK_ACCOUNT_ID": "acct_…",
      "AGENTBANK_SESSION_ID": "ses_…",
      "AGENTBANK_KEYSTORE": "/path/to/.agentbank/agent.keystore.json",
      "AGENTBANK_MAX_X402_PER_CALL": "0.50"
    }
  }
}
```

| Variable                                        | Meaning                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `AGENTBANK_API_URL`                             | API base URL (default `http://localhost:8080`)                   |
| `AGENTBANK_ACCOUNT_ID`, `AGENTBANK_SESSION_ID`  | The agent's account and session                                  |
| `AGENTBANK_SESSION_KEY` or `AGENTBANK_KEYSTORE` | Session key, or a 0600 key file                                  |
| `AGENTBANK_SPEND_KEY`                           | x402 spend key (needed by `fetch_paid_resource`)                 |
| `AGENTBANK_PROOF_SECRET`                        | Private-proof secret (needed by `prove_claims`); never logged    |
| `AGENTBANK_MAX_X402_PER_CALL`                   | Cap per paid request in USDC (default `1.00`)                    |
| `AGENTBANK_MCP_HTTP_TOKEN`                      | Bearer token for `--http`; required when binding beyond loopback |

The HTTP transport binds to 127.0.0.1, rejects foreign `Host` headers and non-loopback origins,
and never logs keys.

## Development

```bash
pnpm --filter @agentbank/mcp test     # in-memory MCP client against a mocked SDK, stdio CLI test
pnpm --filter @agentbank/mcp build
```

Framework quickstarts using this server live in [`examples/`](../../examples) and the
[docs](../../apps/docs/quickstarts).
