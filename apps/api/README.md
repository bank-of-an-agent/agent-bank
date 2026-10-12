# Agent Bank API

The public REST API (orgs, agents, accounts, sessions, policies, payments, x402, escrow, streams,
savings, private proofs, webhooks, billing) and its background worker. Routes, schemas and auth
come from the contract in [`@agentbank/core/api`](../../packages/core/src/api/routes.ts); the API
registers exactly those routes and the OpenAPI document is generated from the same registry.
Testnet only (Base Sepolia, Anvil or the in-memory simulated chain).

It holds no key that can move funds: payments are co-signed by the separate co-signer, the
relayer key only pays gas for permissionless calls, and the private-proof attester key only
publishes and revokes attestation roots.

## Run

```bash
pnpm --filter @agentbank/api dev:local   # simulated chain, in-process co-signer, PGlite, jobs in process
pnpm --filter @agentbank/api test        # PGlite + SimulatedChain + the real in-process co-signer
pnpm --filter @agentbank/api build && node apps/api/dist/index.js   # API
node apps/api/dist/worker.js             # background jobs on pg-boss (PostgreSQL only)
```

## Configuration

Validated with Zod at startup; an invalid environment exits with every problem listed. Secrets
come from the secret manager and are never logged.

| Variable                                                                                   | Meaning                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` (8080), `HOST`, `LOG_LEVEL`, `TRUST_PROXY`, `BODY_LIMIT_BYTES`                      | Server                                                                                                                                    |
| `NODE_ENV`, `APP_ENV`                                                                      | `production` refuses development settings (simulated chain, in-process co-signer, short secrets)                                          |
| `DATABASE_URL`, `MIGRATE_ON_START`                                                         | PostgreSQL (or `pglite://` for development); migrations run on start by default only for PGlite                                           |
| `AGENTBANK_CHAIN` or `CHAIN_ID`                                                            | `simulated` (default), `anvil` or `base-sepolia`; mainnet ids are refused                                                                 |
| `CHAIN_RPC_URL` (`BASE_SEPOLIA_RPC_URL`, `ANVIL_RPC_URL`)                                  | JSON-RPC; required on Base Sepolia                                                                                                        |
| `BUNDLER_URL`, `PIMLICO_API_KEY`, `PIMLICO_SPONSORSHIP_POLICY_ID`                          | ERC-4337 bundler and paymaster                                                                                                            |
| `AGENTBANK_DEPLOYMENT_JSON`                                                                | Agent Bank contract deployment (`deployments/<chainId>.json` of the contracts repo)                                                       |
| `REVENUE_ADDRESS`                                                                          | Where fees go; required outside the simulated chain                                                                                       |
| `API_RELAYER_KEY`                                                                          | Testnet gas wallet for permissionless keeper calls and spend-key permits; holds no funds                                                  |
| `COSIGNER_URL`, `COSIGNER_SHARED_SECRET`, `COSIGNER_TIMEOUT_MS`                            | The co-signer; without `COSIGNER_URL` every payment fails closed (`cosigner_unavailable`)                                                 |
| `COSIGNER_MODE=inprocess`, `COSIGNER_DEV_PRIVATE_KEY`, `COSIGNER_DATABASE_URL`             | Local development only (simulated chain or Anvil)                                                                                         |
| `INTERNAL_API_SHARED_SECRET`                                                               | HMAC key of the indexer's `/internal/*` calls                                                                                             |
| `PUBLIC_BASE_URL`, `CONSOLE_ORIGIN`, `WEBAUTHN_RP_ID`, `COOKIE_SECURE`                     | Agent signature target URL, console CORS and passkeys                                                                                     |
| `STAFF_TOKEN`                                                                              | Internal dashboards (`/v1/admin/*`)                                                                                                       |
| `ALLOW_OPEN_SIGNUP`                                                                        | Public `POST /v1/orgs`                                                                                                                    |
| `FEATURE_ESCROW`, `FEATURE_STREAMS` (on), `FEATURE_TREASURY_SWEEP` (off)                   | Product switches, reported by `GET /v1/meta`                                                                                              |
| `FEATURE_PRIVATE_PROOFS` (on)                                                              | Private proofs; off answers `feature_gated` (reading and releasing reservations stays available) and stops publishing roots               |
| `PROOFS_ATTESTER_KEY`                                                                      | 32-byte attester key of `AgentAttestationRegistry`; must differ from the relayer, co-signer and faucet keys (see below)                   |
| `PROOFS_ROOT_INTERVAL_SECONDS` (3600)                                                      | Build a new root at least this often                                                                                                      |
| `PROOFS_ROOT_TTL_SECONDS` (7200)                                                           | Root validity window (`valid_until = snapshot_at + TTL`); must exceed the interval, at most 7 days                                        |
| `PROOFS_MIN_ANONYMITY_SET` (16)                                                            | The anonymity set the deployment expects verifiers to require (the SDK default); the roots job warns about smaller roots. Sandboxes use 1 |
| `RATE_LIMIT_PER_MINUTE`, `IDEMPOTENCY_STALE_SECONDS`                                       | Per-credential rate limit; stale idempotency claims                                                                                       |
| `WEBHOOK_SIGNING_KEY`, `WEBHOOK_RETRY_SCHEDULE_SECONDS`, `WEBHOOK_TIMEOUT_MS`              | Webhook endpoint secrets at rest, retries, timeout                                                                                        |
| `FACILITATOR_PUBLIC_URL`, `PAY_LINK_BASE_URL`                                              | URLs handed to sellers and payers                                                                                                         |
| `PAYMENT_SIGNATURE_TTL_SECONDS`, `OWNER_OPERATION_TTL_SECONDS`, `X402_MAX_TIMEOUT_SECONDS` | Signing deadlines                                                                                                                         |
| `SCREENING_*`, `KYB_*`                                                                     | Vendor adapters (sandbox providers by default)                                                                                            |
| `SANDBOX_FAUCET_KEY`, `SIMULATED_BLOCK_TIME_MS`                                            | Test USDC on Anvil; the simulated chain's block producer                                                                                  |
| `AUDIT_LOG_BUCKET`, `AUDIT_LOG_PREFIX`, `METRICS_NAMESPACE`                                | WORM audit export and CloudWatch metrics                                                                                                  |
| `RUN_WORKER_IN_PROCESS`, `VALIDATE_RESPONSES`                                              | Run the jobs on timers inside the API (default with PGlite or the simulated chain); validate responses (default outside production)       |

### The attester key

`PROOFS_ATTESTER_KEY` publishes and revokes private-proof roots on `AgentAttestationRegistry` and
pays their gas; it can move nothing. On the simulated chain it defaults to the public simulated
attester. On Anvil and Base Sepolia it is required to publish: without it (or without a registry in
the deployment) the API serves everything else and the `proofs-roots` job reports a clear
`invalid_state` instead of publishing. It must not be the relayer key, and outside testnet it lives
in KMS.

## Background jobs

`src/jobs` (`JOBS`): pg-boss queues in `dist/worker.js`, or timers in the API with
`RUN_WORKER_IN_PROCESS=true`. Each job is a plain function of the dependencies, so tests call them
directly.

| Job                                                                 | Every | Does                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks-deliver`, `operations-receipts`                           | 5 s   | Webhook delivery with retries; receipts of submitted operations                                                                                                                                                                                                                                                                                                |
| `cosigner-outbox`                                                   | 10 s  | Freezes, revocations and settlement reports the co-signer has not acknowledged                                                                                                                                                                                                                                                                                 |
| `payments-expire`, `payments-post-settlement`                       | 15 s  | Unsigned payments, approvals, owner operations and x402 authorizations past their deadline; fee and auto-save follow-ups                                                                                                                                                                                                                                       |
| `agents-unfreeze`                                                   | 30 s  | Unfreezes whose 1-hour delay has elapsed                                                                                                                                                                                                                                                                                                                       |
| `proofs-roots`                                                      | 30 s  | When the tree is dirty (enrollment, settings, reservation, freeze), no root is valid or the newest is older than `PROOFS_ROOT_INTERVAL_SECONDS`: attest the 13 facts of every enrolled, enabled, active agent, build the tree, publish the root with the attester key and confirm it; a narrowing change revokes every older valid root once the new one lands |
| `proofs-reservations`                                               | 60 s  | Expire proof-of-funds reservations (void the hold, `proof_reservation.expired`) and prune leaves a day after their root lapsed; runs even with the feature off                                                                                                                                                                                                 |
| `streams-settle`, `topup-trigger`, `reconciliation-retry-reversals` | 60 s  | Keeper calls; reorg reversals that waited for funds                                                                                                                                                                                                                                                                                                            |
| `autosave-run`                                                      | 5 min | Scheduled saves and the excess sweep                                                                                                                                                                                                                                                                                                                           |
| `billing-subscriptions`, `statements-ready`, `maintenance-prune`    | 1 h   | Subscription accrual, monthly statements, housekeeping                                                                                                                                                                                                                                                                                                         |

## Private proofs

Design: [`docs/private-proofs.md`](../../docs/private-proofs.md) (ADR 0014). Handlers in
`src/routes/proofs.ts`, attested facts and the tree in `src/domain/proofs.ts`, jobs in
`src/jobs/proofs.ts`, tables in migration `0006_proofs`. The cryptography is
[`@agentbank/proofs`](../../packages/proofs/README.md).

- Widening disclosure (enabling or adding a class) needs the owner's `proofs.disclose`
  authorization; narrowing, re-enrollment with a new commitment, freezes and early releases mark
  the tree dirty with narrowing, so older roots are revoked as soon as the new root lands.
- Every epoch's tree ends with a public salt leaf derived from the chain and epoch (not counted in
  `leaf_count`), because the registry refuses a root it has seen and unchanged facts would hash to
  the same tree.
- Witness errors carry a `reason`: `not_enrolled` (404), `proofs_disabled`, `proof_not_ready`,
  `reservation_closed`, `root_<status>` (409).
