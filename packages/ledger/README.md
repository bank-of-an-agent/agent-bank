# @agentbank/ledger

The double-entry ledger behind Agent Bank: ledger accounts and pockets, append-only journal
entries, two-phase holds (post, void, expire), reversals, idempotency and invariant checks. One
`Ledger` interface, two implementations: `InMemoryLedger` (simulations) and `PostgresLedger`.

Internal workspace package.

## Rules it enforces

- Amounts are `bigint` minor units; every entry's lines sum to zero per asset (also enforced by a
  deferred database constraint at commit).
- Journal tables are append-only (UPDATE/DELETE/TRUNCATE fail); corrections are reversals.
- Pockets never go negative; `reserved` and `spend_reserved` change only through holds.
- Every write takes a namespaced idempotency key; the same key with a different request fails
  with `idempotency_conflict`.
- `verifyInvariants()` checks zero-sum entries, cached balances against the journal, and hold
  resolution.

## Usage

```ts
import { PostgresLedger, pocketRef, chainRef, revenueRef } from "@agentbank/ledger";

const ledger = new PostgresLedger(tx); // inside the caller's serializable transaction
await ledger.openPockets(accountId, "USDC", 84532);
const hold = await ledger.hold({
  idempotencyKey: `pay:${id}:hold`,
  accountId,
  asset: "USDC",
  amount,
  from: "operating",
  expiresAt,
  refType: "payment",
  refId: id,
});
await ledger.postHold({
  idempotencyKey: `pay:${id}:post`,
  holdId: hold.id,
  destinations: [
    { to: chainRef(84532, "USDC"), amount },
    { to: revenueRef("USDC"), amount: fee },
  ],
});
```

Pockets: `operating`, `reserved`, `fees`, `savings`, `escrow`, `stream`, `spend`, `spend_reserved`
and `vault:<id>`, each with a funds location used by reconciliation
([architecture](../../docs/architecture.md#ledger-model)).

## Tests

113 tests on both engines, including fast-check model-based and differential properties, a
10,000-operation randomized run and a PostgreSQL concurrency test (parallel holds never
overdraw). Coverage is enforced at ≥ 90% (currently ~99%).

```bash
pnpm --filter @agentbank/ledger test
pnpm --filter @agentbank/ledger test:coverage
DATABASE_URL=postgres://… pnpm --filter @agentbank/ledger test
```
