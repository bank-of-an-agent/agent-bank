# Phase 1 gate report · Ledger and accounts

**Gate criterion:** 10,000 simulated deposits and transfers reconcile with zero drift, including
injected reorgs.
**Status: met** (testnet/simulation). Evidence:
[`evidence/phase-1-reconciliation.md`](evidence/phase-1-reconciliation.md).

## Built

| Deliverable                                                                                                                                                          | Where                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Double-entry ledger: journals, holds (post/void/expire), reversals, idempotency, invariants; `InMemoryLedger` and `PostgresLedger` behind one interface              | `packages/ledger`                                         |
| Database guarantees: append-only journal tables, a deferred zero-sum constraint per entry, no negative pockets, mainnet chain ids refused                            | `packages/db/migrations/0001_ledger.sql`, `0002_core.sql` |
| Org, member, agent and account APIs; counterfactual Safe7579 accounts (address commits to owner + co-signer + salt)                                                  | `apps/api`, `packages/chain`                              |
| Indexer (own account and database): block-hash reorg detection, finality-aware resends, nightly balance check                                                        | `apps/indexer`                                            |
| Reconciler (in the API process): matches chain events to payments, x402, escrow, streams, vaults and fee sweeps; deposits; suspense with agent pause; reorg reversal | `packages/reconciliation`                                 |

## Tests

| Suite                                                                                                                                                                  | Result                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Ledger: shared behavioural suite on both engines, model-based and differential properties, 10,000-operation run, Postgres concurrency (40 parallel holds, no overdraw) | 113 passed, coverage 99% statements / 96.6% branches     |
| Reconciliation: every movement type, idempotency, windows, finality, suspense + freeze, reorgs, invariants                                                             | 42 passed                                                |
| Indexer: loop, reorg depth 1–5, restart from cursor, deferred resend, HTTP + HMAC                                                                                      | 18 passed                                                |
| **Gate run (InMemory ledger):** 10,000 movements, 272 reorgs (791 orphaned blocks)                                                                                     | **0 mismatches, $0.00 suspense, 0 invariant violations** |
| **Gate run (PostgreSQL 16 ledger):** 1,000 movements, 26 reorgs                                                                                                        | **0 mismatches, $0.00 suspense, 0 invariant violations** |

Invariants checked (design § Data model): lines in each entry sum to zero; each chain event
matches at most one entry; no payment settles without an `allow` decision or approval; balances
are derived from the journal (the cached projection is verified against it).

## Open issues

- Post-settlement work in the API (auto-save, payment-request completion, API-side x402 fee) runs
  only once the settling block is final, and each effect is idempotent, so a reorg cannot leave it
  applied without the settlement.
- The scale limit is the single `sys:chain` / `sys:revenue` rows (serialization retries under
  heavy concurrency). Fine for beta; revisit before scale.

## Decisions taken

- The indexer runs in its own cloud account and pushes evidence to the API (ADR 0011).
- Rolling policy windows; pockets carry a funds location so reconciliation can compare each
  on-chain address with the pockets located there.

## Demo script

```bash
cd agent-bank
pnpm install
pnpm --filter @agentbank/reconciliation gate        # rewrites docs/gates/evidence/phase-1-reconciliation.md
DATABASE_URL=postgres://agentbank:agentbank@127.0.0.1:54329/agentbank pnpm --filter @agentbank/ledger test
```
