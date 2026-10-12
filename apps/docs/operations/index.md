# Operations

How Agent Bank is run, gated and decided. The source documents live in the repository's [`docs/`](https://github.com/bank-of-an-agent/agent-bank/tree/main/docs) folder; these pages summarize them and link to the originals.

| Document                                                                                       | What it covers                                                                                                              |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Incident runbooks](/operations/runbooks)                                                      | Key compromise, contract pause, reconciliation mismatch, mass freeze, owner recovery                                        |
| [Phase gates](/operations/gates)                                                               | The six build phases and the criterion each must meet before the next starts                                                |
| [Architecture decisions](/operations/adrs)                                                     | The ADRs: spend keys, repository structure, the API contract, owner operations, mandates, guardian recovery, …              |
| [Security model](/concepts/security-model)                                                     | The threat model and its controls ([source](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/threat-model.md)) |
| [Architecture](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/architecture.md)  | Services, packages, the ledger model and every money flow, step by step                                                     |
| [Design](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/design.md)              | Product, regulatory posture, business model and the implementation plan                                                     |
| [OpenAPI document](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/openapi.json) | The API contract, generated from the route registry ([reference](/api/))                                                    |

## Deployment

![Agent Bank architecture](/architecture-dark.png){.dark-only .figure}
![Agent Bank architecture](/architecture-light.png){.light-only .figure}

| Service            | Runs in                                  | Holds                                                                            |
| ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/api`         | API account                              | Org and agent data, the ledger, payments                                         |
| `apps/cosigner`    | **Separate cloud account**               | Policies, sessions, mandates, freezes, its own spend history, the KMS key handle |
| `apps/indexer`     | **Separate cloud account**, own database | Chain cursor, block hashes, raw logs                                             |
| `apps/facilitator` | API account                              | The x402 authorization log, a testnet relayer key                                |
| `apps/console`     | API account                              | Nothing: it calls the API                                                        |

Infrastructure is Terraform in [`infra/`](https://github.com/bank-of-an-agent/agent-bank/tree/main/infra), one environment per stack: the sandbox runs on Base Sepolia, and production stays locked until the Phase 5 gate. Every service validates its environment at startup and exits with a full list of problems; secrets come from the secret manager, never from files in the repository.

## Continuous integration

Every pull request runs formatting, lint, type checks, an OpenAPI freshness check (`pnpm openapi:check`), the test suites on PostgreSQL 16, the coverage gates (at least 90% on the ledger and policy packages) and a full build, then builds every service's container image. The policy engine's red-team suite throws at least 1,000 adversarial payment intents at the evaluator, the ledger has property-based tests of its invariants, and the simulated chain injects reorgs for reconciliation tests.

## Contracts, SDK and exit tool repositories

| Repository                                                     | Contents                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`agent-bank`](https://github.com/bank-of-an-agent/agent-bank) | This platform: services, packages, the TypeScript SDK, the MCP server, these docs, Terraform                |
| [`contracts`](https://github.com/bank-of-an-agent/contracts)   | Foundry: escrow, streams, the policy hook, time-locked vaults, top-up and sweep executors, frozen per audit |
| [`sdk-python`](https://github.com/bank-of-an-agent/sdk-python) | The `agentbank` Python package                                                                              |
| [`exit-tool`](https://github.com/bank-of-an-agent/exit-tool)   | The owner exit tool, independent of everything else                                                         |
