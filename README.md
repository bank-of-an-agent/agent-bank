<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
  <img alt="Agent Bank: programmable, non-custodial bank accounts for AI agents" src="docs/assets/banner-light.png">
</picture>

# Agent Bank

The Agent Bank platform: the API, the policy engine and co-signer, the double-entry ledger, the
chain indexer, the x402 facilitator, the principal console, the TypeScript SDK and MCP server,
the documentation site and the infrastructure, in one monorepo.

[![CI](https://github.com/bank-of-an-agent/agent-bank/actions/workflows/ci.yml/badge.svg)](https://github.com/bank-of-an-agent/agent-bank/actions/workflows/ci.yml)
![Node 22](https://img.shields.io/badge/node-22-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

> [!IMPORTANT]
> Pre-release and **testnet only** (Base Sepolia; mainnet chain ids are refused in code, in the
> database and in deploy scripts). Contracts are unaudited. Agent Bank is software, not a
> chartered bank or a money transmitter.

## About

Agent Bank gives every AI agent a non-custodial account: an ERC-7579 smart account holding USDC
on Base, owned by the human or company behind the agent. The agent signs payments with a
short-lived session key; Agent Bank's co-signer approves or refuses each one after checking the
owner's policy; the limits also hold on-chain, so a prompt-injected agent cannot spend past them.
Agent Bank can refuse a payment, never make one.

The [design](docs/design.md) is the source of the requirements; the
[architecture](docs/architecture.md) maps it onto this code.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.png">
  <img alt="Architecture: agents, principals and sellers call the API and facilitator; the policy engine and co-signer run in a separate cloud account; the indexer reconciles the chain with the ledger; smart accounts, Agent Bank contracts and USDC live on Base" src="docs/assets/architecture-light.png">
</picture>

## Quickstart: the whole bank on your laptop

Requirements: Node.js 22 and pnpm 10 (`corepack enable`). No Docker needed. On NixOS,
`nix develop` provides everything.

```bash
pnpm install
pnpm --filter @agentbank/e2e sandbox
```

That runs the whole platform in one process against an in-memory simulated chain that applies the
same rules as Base Sepolia: the API on `http://localhost:8080`, the co-signer, the reconciler and
indexer, the x402 facilitator on `http://localhost:8083/v1/x402`, and a demo x402 seller on
`http://localhost:4021`. It prints an org API key and the env block for a funded demo agent, ready
for the [SDK examples](packages/sdk-ts/examples), the [MCP server](packages/mcp) and the
[framework quickstarts](examples).

Other entry points:

```bash
pnpm --filter @agentbank/api dev:local                                  # just the API (+ co-signer, reconciler)
API_URL=http://localhost:8080 pnpm --filter @agentbank/api smoke:local  # end-to-end smoke test against it
NEXT_PUBLIC_SANDBOX=true pnpm --filter @agentbank/console dev            # the principal console on :3000
pnpm --filter @agentbank/docs dev                                        # the documentation site
```

## What's in the repository

| Path                                                 | What it is                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`apps/api`](apps/api)                               | Public REST API (90+ operations), webhooks and the background worker                |
| [`apps/cosigner`](apps/cosigner)                     | Policy engine + KMS co-signer; separate cloud account; fails closed                 |
| [`apps/indexer`](apps/indexer)                       | Chain indexer with reorg detection; own account and database                        |
| [`apps/facilitator`](apps/facilitator)               | x402 facilitator: verify and settle payer-signed EIP-3009 payments                  |
| [`apps/console`](apps/console)                       | Principal dashboard: passkeys, approvals, policies, owner signatures                |
| [`apps/docs`](apps/docs)                             | Documentation site (VitePress)                                                      |
| [`packages/core`](packages/core)                     | Money, ids, errors, signatures, schemas and **the API contract**                    |
| [`packages/db`](packages/db)                         | `SqlClient` over PostgreSQL or PGlite, migrations, outbox                           |
| [`packages/ledger`](packages/ledger)                 | Double-entry ledger with holds, reversals and invariants                            |
| [`packages/policy`](packages/policy)                 | Deterministic policy engine, change classifier, mandate compiler                    |
| [`packages/chain`](packages/chain)                   | `ChainGateway`: simulated chain and Base Sepolia (Safe + ERC-7579 + Smart Sessions) |
| [`packages/reconciliation`](packages/reconciliation) | Matches chain evidence to the ledger inside the API                                 |
| [`packages/sdk-ts`](packages/sdk-ts)                 | `@agentbank/sdk`: TypeScript SDK, x402 client and paywall                           |
| [`packages/mcp`](packages/mcp)                       | `@agentbank/mcp`: money tools for agents over MCP                                   |
| [`tests/e2e`](tests/e2e)                             | Full-stack scenarios, red-team and exit-drill gate suites                           |
| [`examples`](examples)                               | Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK, LangChain, MCP client           |
| [`infra`](infra)                                     | OpenTofu/Terraform for separate co-signer, API and indexer AWS accounts             |
| [`docs`](docs)                                       | Design, architecture, ADRs, threat model, runbooks, gate reports, OpenAPI           |

Related repositories: [contracts](https://github.com/bank-of-an-agent/contracts) (Solidity),
[sdk-python](https://github.com/bank-of-an-agent/sdk-python) and
[exit-tool](https://github.com/bank-of-an-agent/exit-tool).

## Development

```bash
pnpm build            # every package and app (Turborepo)
pnpm test             # PGlite by default; set DATABASE_URL to run on PostgreSQL 16
pnpm lint && pnpm typecheck && pnpm format:check
pnpm openapi          # regenerate docs/openapi.json from the route registry
pnpm db:up            # PostgreSQL 16 on 127.0.0.1:54329 (docker compose)
```

Opt-in suites: `RUN_LIVE_TESTS=1` (read-only Base Sepolia checks) and `RUN_FORK_TESTS=1` (an Anvil
fork of Base Sepolia with a local bundler) in `packages/chain`. Coverage gates: `packages/ledger`
and `packages/policy` at ≥ 90%.

Ground rules (enforced in review and CI): no code path lets a bank-held key move funds; testnet
only; money is integer minor units (floats are banned by ESLint in money code); every write is
idempotent; no secrets in the repository; fail closed.

## Status

See the [phase gate reports](docs/gates). Code for all six phases exists and runs on testnet and
in simulation; the gates that need people (counsel, auditors, an on-call rotation, funded
Base Sepolia credentials) are marked as needing human sign-off.

## Documentation

- [Architecture](docs/architecture.md) and [decision records](docs/adr)
- [Threat model](docs/threat-model.md) and [incident runbooks](docs/runbooks)
- [OpenAPI 3.1](docs/openapi.json) (also rendered by the docs site)

## Security and contributing

Report vulnerabilities privately via
[GitHub security advisories](https://github.com/bank-of-an-agent/.github/blob/main/SECURITY.md).
Contributions follow the
[organization guide](https://github.com/bank-of-an-agent/.github/blob/main/CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
