# Reconciliation

The ledger says why money moved; the chain says that it did. Reconciliation continuously proves the two agree, and stops an agent when they do not.

## Who does what

- **The indexer** (`apps/indexer`) runs in its **own cloud account with its own database** and never touches the ledger database. It fetches the watchlist of known addresses from the API, reads the chain, tracks block hashes to detect reorgs, and pushes normalized events to the API's internal endpoints, authenticated with an HMAC over each request.
- **The reconciler** (`packages/reconciliation`), mounted inside the API, matches each event to an expected movement and posts the ledger entry in the same database transaction, idempotently by event id.

The indexer polls through the same `ChainGateway` interface the rest of the platform uses, so the identical code path runs against the in-memory simulated chain in tests (including injected reorgs) and against Base Sepolia ([ADR 0011](/operations/adrs)). A compromised indexer can delay or withhold evidence, which raises lag and mismatch alarms, but cannot write arbitrary entries: the reconciler only posts what matches an expected movement, a deposit to a known address, or suspense.

## What is watched

USDC `Transfer` and EIP-3009 `AuthorizationUsed` events for every known address (smart accounts, spend keys, treasuries, the revenue address), and every event of Agent Bank's escrow, stream and vault contracts.

## Matching

Each on-chain movement must match a ledger expectation within **20 blocks**:

| Movement              | Matched by                                                 |
| --------------------- | ---------------------------------------------------------- |
| Payment               | User operation hash or transaction hash                    |
| x402 payment          | EIP-3009 authorization nonce (derived from the payment id) |
| Escrow, stream, vault | The contract's on-chain id                                 |
| Deposit               | Any inbound transfer to a known address                    |

**Finality.** Movements under $100 post on L2 inclusion; larger ones post only once the block is `finalized`. A reorg reverses the entries posted from orphaned blocks.

## When something does not match

An unmatched outflow, for example a spend key paying without `POST /v1/x402/pay` or an owner withdrawing with the exit tool, triggers four things at once:

1. The movement is posted to `sys:suspense` (`operating −x` or `spend −x`, `sys:suspense +x`), so balances stay true to the chain.
2. A `reconciliation.mismatch` [webhook](/guides/webhooks) fires.
3. An alert is raised for on-call.
4. The agent's sessions are **paused through the co-signer**: it refuses that agent's operations until the mismatch is reviewed.

Operators then classify it (a late match, an owner exit, a reorg artefact or something unknown) following the [reconciliation mismatch runbook](/operations/runbooks#reconciliation-mismatch). Unpausing is a loosening: owner signature plus the one-hour delay.

## Nightly balance check

Every night, for every account, the on-chain balance at the indexer's cursor block must equal the sum of the pockets held at that address: `operating + reserved + fees + savings + goal vaults` for the smart account, `spend + spend_reserved` for the spend key, and per-id balances for the shared escrow, stream and vault contracts. A difference is a mismatch.

## Evidence

The Phase 1 gate criterion is that 10,000 simulated deposits and transfers reconcile with zero drift, including injected reorgs. The gate test runs random deposits (faucet mints, transfers and EIP-3009 payments from outside Agent Bank), payments signed by session keys or owners, x402 payments from spend keys and refills on the simulated chain, with reorgs of depth 1 to 5 injected throughout, while the real indexer loop feeds the real reconciler. At the end every watched address must hold on-chain exactly what the ledger says, the ledger's invariants must hold, suspense must be zero, and every chain event must match at most one entry.

```bash
pnpm --filter @agentbank/reconciliation gate
```

`GATE_MOVEMENTS` (default 10,000, in-memory ledger), `GATE_PG_MOVEMENTS` (default 1,000, PostgreSQL ledger on PGlite, or on PostgreSQL when `DATABASE_URL` is set) and `GATE_SEED` tune the run. See the [phase gates](/operations/gates).
