# Local sandbox

The local sandbox runs the whole platform on your machine: PostgreSQL 16 in Docker, and the API, co-signer, x402 facilitator and console on Node 22, against an **in-memory simulated chain**. The simulated chain implements the same rules as Base Sepolia (owner signature, or session key plus co-signer within the session scope; ERC-20 balances; EIP-3009 authorizations; escrow, stream and vault contract semantics; blocks, finality and injectable reorgs), so everything in these docs works without a network or testnet funds. Its state lives in the API process and resets when the API restarts.

::: tip One command
`pnpm --filter @agentbank/e2e sandbox` starts everything in one process (API, co-signer, reconciler and indexer, x402 facilitator and a demo seller) with an in-memory database and no Docker. Sections 3 and 4 show the pieces separately.
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

## 3. Start the stack

**Everything in one process** (simulated chain, PGlite in memory unless `DATABASE_URL` is set):

```bash
pnpm --filter @agentbank/e2e sandbox
```

| Service          | URL                                                                 |
| ---------------- | ------------------------------------------------------------------- |
| API              | `http://localhost:8080`                                             |
| x402 facilitator | `http://localhost:8083/v1/x402`                                     |
| Demo x402 seller | `http://localhost:4021` (`/weather` 0.01 USDC, `/report` 2.00 USDC) |

It prints an org API key and an env block for a demo agent funded with 1,000 USDC, ready for the
SDKs, the MCP server and the [framework quickstarts](/quickstarts/). Stop it with Ctrl-C.

**Only the API** (with the co-signer, reconciler and a simulated indexer in-process):

```bash
pnpm --filter @agentbank/api dev:local
API_URL=http://localhost:8080 pnpm --filter @agentbank/api smoke:local   # end-to-end smoke test
```

**The console** (principal dashboard on port 3000, pointing at the API on 8080):

```bash
NEXT_PUBLIC_SANDBOX=true pnpm --filter @agentbank/console dev
```

## 4. Keep data between runs (optional)

```bash
pnpm db:up                     # PostgreSQL 16 on 127.0.0.1:54329 (docker compose)
DATABASE_URL=postgres://agentbank:agentbank@127.0.0.1:54329/agentbank pnpm --filter @agentbank/e2e sandbox
```

`pnpm db:down` stops it. Running the services as separate processes needs a chain they can share
(Anvil plus an ERC-4337 bundler, or Base Sepolia below); the in-memory simulated chain lives inside
one process. In production each service runs from its own container image
(`APP=api|cosigner|indexer|facilitator|console` in the root `Dockerfile`), and the co-signer and the
indexer run in separate cloud accounts ([Reconciliation](/concepts/reconciliation)).

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
