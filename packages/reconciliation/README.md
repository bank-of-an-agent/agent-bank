# @agentbank/reconciliation

The reconciler, mounted inside the API process: it receives normalized chain events from the
indexer (which runs in its own cloud account), matches them to the movements Agent Bank expects,
and posts ledger entries in the API's database transaction.

Internal workspace package. Contract: [`core/src/indexer-api.ts`](../core/src/indexer-api.ts).

## What it does

- Matches transfers to payments (by user operation or transaction hash), x402 payments (by
  EIP-3009 nonce), escrow, stream and vault events, fee and savings sweeps; books unsolicited
  inflows as deposits; accrues the x402 receive fee for sellers.
- Waits up to 20 blocks for a match, then posts unexplained movements to `sys:suspense`, emits
  `reconciliation.mismatch` and freezes the agent through the co-signer.
- Posts movements of $100 or more only once their block is finalized.
- On a reorg, reverses entries from orphaned blocks and reopens the affected payments.
- Computes the expected balance of every watched address for the nightly on-chain check.

## Usage

```ts
import { createReconciler, createInternalHandler } from "@agentbank/reconciliation";

const reconciler = createReconciler({
  db,
  ledger: (tx) => new PostgresLedger(tx, { clock }),
  cosigner, // only freeze() is used
  clock,
  config: {
    chainId,
    usdc,
    revenueAddress,
    contracts: { escrow, streams, vaults, topUpExecutor, sweepExecutor },
  },
});
const handle = createInternalHandler(reconciler, { secret: process.env.INTERNAL_API_SHARED_SECRET! });
```

## Phase 1 gate

```bash
pnpm --filter @agentbank/reconciliation gate   # rewrites docs/gates/evidence/phase-1-reconciliation.md
```

10,000 random deposits, payments, x402 payments and refills with 272 injected reorgs reconcile
with zero drift, zero suspense and zero invariant violations (plus 1,000 on PostgreSQL 16).
