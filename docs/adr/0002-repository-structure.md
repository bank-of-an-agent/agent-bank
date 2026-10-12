# 0002: Repository structure

- Status: Accepted
- Date: 2026-10-11

## Context

The design lays out a single `agent-bank/` monorepo that includes the Python SDK, the Solidity
contracts and the owner exit tool. Three of those have properties that argue for separation:
contracts are audited as a unit and must be frozen at a commit for each audit; the Python SDK
has its own toolchain, release cadence and package index; and the exit tool must be visibly
independent of Agent Bank, because its whole purpose is to work when Agent Bank is gone.

## Decision

The `bank-of-an-agent` GitHub organization holds:

| Repository   | Contents                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-bank` | Platform monorepo: API, co-signer, indexer, facilitator, console, docs site, ledger, policy, chain, TypeScript SDK, MCP server, Terraform |
| `contracts`  | Foundry: escrow, streams, policy hook, time-lock vaults, top-up and sweep executors, the x402/Safe spike                                  |
| `sdk-python` | The `agentbank` Python package                                                                                                            |
| `exit-tool`  | Open-source owner exit tool that needs only an RPC URL and the owner key                                                                  |
| `.github`    | Organization profile and community health files                                                                                           |

The TypeScript SDK and MCP server stay in the monorepo because they are typed directly from the
API's route registry (ADR 0003).

## Consequences

- Contract ABIs are copied into `packages/chain/src/abis` by `scripts/sync-abis.sh`; a CI job can
  compare them with the `contracts` release.
- The Python SDK copies `docs/openapi.json` and the cross-language vectors; its CI fails if
  signatures diverge from the TypeScript implementation.
- The exit tool depends on nothing in this monorepo.
