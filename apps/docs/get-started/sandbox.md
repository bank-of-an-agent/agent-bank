# Local sandbox

The local sandbox runs the whole platform on your machine: PostgreSQL 16 in Docker, and the API, co-signer, x402 facilitator and console on Node 22, against an **in-memory simulated chain**. The simulated chain implements the same rules as Base Sepolia (owner signature, or session key plus co-signer within the session scope; ERC-20 balances; EIP-3009 authorizations; escrow, stream and vault contract semantics; blocks, finality and injectable reorgs), so everything in these docs works without a network or testnet funds. Its state lives in the API process and resets when the API restarts.

::: info Services are still being built
The API, co-signer, indexer, facilitator and console are under active development. The commands on this page follow the repository layout and each service's configuration schema; the ones marked for verification may change before the first tagged release.
:::

## Prerequisites

- Node.js 22.12 or later and pnpm 10 (`corepack enable` gives you the pinned version). The repository's Nix flake (`nix develop`) provides Node, pnpm, PostgreSQL client tools, Foundry and `uv`.
- Docker with Compose, for PostgreSQL.
- Git, to clone [`bank-of-an-agent/agent-bank`](https://github.com/bank-of-an-agent/agent-bank).

## 1. Install

```bash
git clone https://github.com/bank-of-an-agent/agent-bank.git
cd agent-bank
pnpm install
```

## 2. Configure

Copy the example environment. It contains local and testnet defaults only; never put real secrets in it.

```bash
cp .env.example .env
```

| Variable                 | Sandbox value                                              | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | `postgres://agentbank:agentbank@127.0.0.1:54329/agentbank` | The API's PostgreSQL database (the Compose service below)                                            |
| `AGENTBANK_CHAIN`        | `simulated`                                                | `simulated`, `anvil` or `base-sepolia`. Mainnet chain ids are refused everywhere (`mainnet_locked`)  |
| `BASE_SEPOLIA_RPC_URL`   | `https://sepolia.base.org`                                 | RPC endpoint, used only on `base-sepolia`                                                            |
| `PIMLICO_API_KEY`        | empty                                                      | ERC-4337 bundler and paymaster key, only on `base-sepolia` (from your secret manager)                |
| `COSIGNER_URL`           | `http://127.0.0.1:8081`                                    | Where the API reaches the co-signer. Unset means every payment fails closed (`cosigner_unavailable`) |
| `COSIGNER_SHARED_SECRET` | `dev-only-shared-secret-change-me`                         | HMAC secret between the API and the co-signer; the services refuse this value in production          |
| `COSIGNER_SIGNER`        | `local`                                                    | `local` (testnet and development only) or `kms` (AWS KMS, non-exportable)                            |
| `COSIGNER_KMS_KEY_ID`    | empty                                                      | KMS key id when `COSIGNER_SIGNER=kms`                                                                |
| `ALLOW_OPEN_SIGNUP`      | `true`                                                     | Lets `POST /v1/orgs` create orgs without an invitation; the sandbox KYB provider auto-approves them  |

The services read further optional variables (feature flags such as `FEATURE_ESCROW`, `FEATURE_STREAMS` and the counsel-gated `FEATURE_TREASURY_SWEEP`, rate limits, webhook settings), all validated at startup: a service with an invalid environment exits with a message listing every problem.

## 3. Start PostgreSQL and migrate

```bash
pnpm db:up                     # docker compose up -d --wait postgres (127.0.0.1:54329)
set -a && . ./.env && set +a   # export the variables to your shell
pnpm --filter @agentbank/db migrate
```

`pnpm db:down` stops it again. Tests use PGlite (PostgreSQL compiled to WebAssembly) unless `DATABASE_URL` is set, so you only need Docker to run the services.

## 4. Start the services

Run each in its own terminal, with the variables from `.env` exported.

<!-- verify: per-service start commands and the extra co-signer variables once the services are final -->

```bash
# Co-signer (port 8081): its own database and a throwaway local signing key
COSIGNER_DATABASE_URL=pglite://memory \
COSIGNER_PRIVATE_KEY=0x<a fresh testnet-only key> \
COSIGNER_REVENUE_ADDRESS=0x00000000000000000000000000000000000Fee00 \
pnpm --filter @agentbank/cosigner dev

# API (port 8080), with the background jobs in-process
RUN_WORKER_IN_PROCESS=true pnpm --filter @agentbank/api dev

# x402 facilitator (port 8083), only needed to sell or buy with x402
pnpm --filter @agentbank/facilitator dev

# Console (port 3000), the principal dashboard
pnpm --filter @agentbank/console dev
```

In production each service runs from its own container image (`APP=api|cosigner|indexer|facilitator|console` in the root `Dockerfile`), and the co-signer and the indexer run in separate cloud accounts. The indexer, which matches chain events to the ledger, is described in [Reconciliation](/concepts/reconciliation).

## 5. Check it

```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/v1/meta
```

`/v1/meta` returns the deployment facts clients need: the chain (`simulated`, chain id 1337), the USDC contract and its EIP-712 domain, Agent Bank's contract addresses, the co-signer address, the facilitator URL, feature flags, and `owner_authorization_chain_id`, the chain id the SDKs put in the EIP-712 domain of owner authorizations. The API also serves its own OpenAPI document at `/openapi.json` and a plain reference page at `/docs`.

## Testnet instead of the simulator

To run against Base Sepolia, set `AGENTBANK_CHAIN=base-sepolia`, an RPC URL, a Pimlico key, a revenue address and the deployment file of the Agent Bank contracts (`AGENTBANK_DEPLOYMENT_JSON`, from the `contracts` repository). Fund agent accounts with test USDC from [Circle's testnet faucet](https://faucet.circle.com): an account can receive funds at its counterfactual address before it is deployed. Never use a key that holds mainnet funds; the SDKs, the API and the deploy scripts refuse mainnet chain ids.

## Next

[Principal setup](/get-started/principal-setup): create an org, an agent with an account, a policy and a session key.
