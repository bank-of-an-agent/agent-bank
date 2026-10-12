# 0011: Indexer on ChainGateway instead of Ponder

- Status: Accepted
- Date: 2026-10-11

## Context

The design's stack lists Ponder for typed, reorg-aware indexing. Reconciliation must write
ledger entries in the same PostgreSQL transaction as the `chain_event` rows, reverse entries
exactly on reorgs, and run unchanged against the in-memory `SimulatedChain` in tests (including
the Phase 1 gate's injected reorgs).

## Decision

`apps/indexer` polls logs through the `ChainGateway` interface, tracks block hashes to detect
reorgs, and owns its cursor in its own database, in its own cloud account (design: separate
accounts for co-signer, API and indexer). It never writes the ledger directly: it pushes
normalized events to the API's internal endpoints, where the reconciler
(`packages/reconciliation`) matches and posts them in the API's database transaction,
idempotently by event id. Ponder remains a candidate for analytics read models later.

## Consequences

- One code path for simulation and Base Sepolia.
- A compromised indexer can delay or withhold evidence (raising lag and mismatch alarms) but
  cannot write arbitrary ledger entries: the reconciler only posts what matches an expected
  movement, a deposit to a known address, or suspense.
- We own reorg handling, so it is covered by property tests rather than inherited.
