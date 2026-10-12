# Phase 2 gate report · Keys, policy and co-signer

**Gate criterion:** a red-team agent with a prompt-injection harness cannot exceed any limit or
pay a non-allowlisted address in 1,000 attempts.
**Status: met** (simulation and Anvil fork). Evidence:
[`evidence/phase-2-red-team.md`](evidence/phase-2-red-team.md).

## Built

| Deliverable                                                                                                                   | Where                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Session-key lifecycle in the SDKs and API; Smart Sessions V1 install signed by the owner (2-of-2 session key + co-signer)     | `packages/sdk-ts`, `sdk-python`, `apps/api`, `packages/chain` |
| Deterministic policy engine and the co-signer on KMS, failing closed                                                          | `packages/policy`, `apps/cosigner`                            |
| AP2 v0.2 open Payment Mandates compiled into scope plus rules; asymmetric policy changes (owner signature + 1 hour to loosen) | `packages/policy`, ADR 0006                                   |
| Console: passkey sign-in, approvals, freeze, policy editor, treasury auto top-up, owner operations                            | `apps/console`                                                |
| KYB/KYC: vendor adapter interface with a sandbox provider (a real vendor account needs a person)                              | `apps/api`                                                    |
| Savings: goal vaults, auto-save rules (owner-signed), time-locked vaults                                                      | `apps/api`, `packages/policy`, `contracts`                    |

## Evidence

- **Policy engine red team:** 1,636 adversarial intents across 14 categories, all denied; 266
  benign controls, none denied; four stateful simulations (15,240 attempts) with zero limit
  breaches (`packages/policy/test/redteam.test.ts`).
- **Co-signer adversarial suite:** 29 cases (tampered operations, extra calls, approvals to
  attackers, hash mismatch, wrong or expired sessions, frozen agents, over-limit, fail-closed).
- **On-chain enforcement (Anvil fork of Base Sepolia, real Safe7579 / Smart Sessions / USDC):**
  the session key alone and the co-signer alone cannot pay; over-limit payments revert; agent
  sessions cannot produce ERC-1271 signatures for `transferWithAuthorization` or `permit`; the
  owner can always withdraw.
- **Full-stack red team (API + co-signer + facilitator + chain + SDK + MCP):** 1,086 attempts by
  an adversary that fully controls its runtime, session key and spend key (strictly stronger than
  a prompt-injected LLM), including 24 LLM-style injections through the MCP tools: **0 leaks**,
  every refusal carries a rule id, invariants clean; the only funds moved outside policy were the
  spend-key float ($5.00 of a $5.00 float), the accepted bound of ADR 0001.

## Demo script

```bash
pnpm --filter @agentbank/e2e gate:phase2           # rewrites evidence/phase-2-red-team.md
pnpm --filter @agentbank/policy test               # includes the 1,636-intent policy red team
RUN_FORK_TESTS=1 pnpm --filter @agentbank/chain test   # on-chain enforcement on a Base Sepolia fork
```

## Open issues

- Approvals are attested by the API to the co-signer (ADR 0012).
- Owner keys that are smart contracts (ERC-1271) need a chain-aware verifier in the co-signer.
