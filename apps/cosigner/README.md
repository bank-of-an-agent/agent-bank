# Agent Bank co-signer

The policy engine and co-signer. It holds Agent Bank's co-signing key (AWS KMS, non-exportable)
and adds the second signature an agent's session needs, **only after re-checking everything
itself**. It can refuse a payment; it can never make one, because the co-signer key alone has no
power over any account.

Deploys in its **own AWS account**, reachable from the API only over PrivateLink with HMAC-signed
requests ([contract](../../packages/core/src/cosigner-api.ts)).

## What it checks before signing

1. The session exists, belongs to the account, is active, and nothing (org, agent, session) is frozen.
2. It recomputes the user operation hash and verifies the session key's signature.
3. It **decodes the raw user operation itself** and requires the calls to match the stated
   intent exactly (recipient, amount, fee to the revenue address, sweeps); anything else is refused.
4. It evaluates **its own copy** of the owner's policy and mandates (`@agentbank/policy`) against
   **its own** spend history, serialized per agent.
5. Approvals must have enough distinct approvers; `require_owner` is never co-signed.

Everything fails closed (`COSIGNER_FAIL_CLOSED=true` refuses all), and every decision,
signature, policy change, freeze and registration is appended to a hash-chained audit log.
Loosening a policy or unfreezing needs the owner's EIP-712 authorization and waits 1 hour.

## Run

```bash
pnpm --filter @agentbank/cosigner dev        # local signer, PGlite (testnet/dev only)
pnpm --filter @agentbank/cosigner test       # 142 tests incl. adversarial cases and a latency benchmark
pnpm --filter @agentbank/cosigner build && node apps/cosigner/dist/index.js
```

| Variable                                                                   | Meaning                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `PORT` (8081), `HOST`                                                      | Listen address                                                        |
| `AGENTBANK_CHAIN`                                                          | `simulated`, `anvil` or `base-sepolia`                                |
| `COSIGNER_SHARED_SECRET`                                                   | HMAC secret shared with the API (≥ 32 characters)                     |
| `COSIGNER_DATABASE_URL`                                                    | The co-signer's own PostgreSQL (`pglite://` only outside production)  |
| `COSIGNER_SIGNER`                                                          | `kms` (required in production) or `local` (testnet/dev)               |
| `COSIGNER_KMS_KEY_ID`, `AWS_REGION`                                        | KMS key (`ECC_SECG_P256K1`, `SIGN_VERIFY`)                            |
| `COSIGNER_PRIVATE_KEY`                                                     | Local signer key (refused in production and on non-testnets)          |
| `COSIGNER_FAIL_CLOSED`                                                     | Refuse everything (incident switch)                                   |
| `COSIGNER_REVENUE_ADDRESS`, `COSIGNER_MAX_FEE_SWEEP`, `COSIGNER_CONTRACTS` | Fee and contract configuration                                        |
| `OWNER_AUTHORIZATION_CHAIN_ID`                                             | EIP-712 chain id for owner authorizations (defaults to the chain)     |
| `METRICS_NAMESPACE`                                                        | Emit CloudWatch EMF metrics (`DecisionLatency`, `Requests`, `Errors`) |

Latency (1,000 evaluations + 1,000 co-signatures in-process, PostgreSQL 16): co-sign p99 ≈ 30–100 ms
against a 300 ms objective.
