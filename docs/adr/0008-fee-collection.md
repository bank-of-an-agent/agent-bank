# 0008: Fee collection without pull authority

- Status: Accepted
- Date: 2026-10-11

## Context

Agent Bank charges fees (outbound 0.20%, escrow 1%, streams 0.5%, x402 receive 0.5%,
subscriptions). A standing ERC-20 allowance to a bank wallet would let a bank key move customer
funds alone, which crosses the non-custodial line.

## Decision

- Fees on payer-initiated operations (payments, escrow locks, stream creation) are a second
  transfer to the revenue address **inside the same user operation** the agent signs and the
  co-signer approves.
- Fees with no payer operation (x402 receive, subscriptions, treasury sweep) accrue to the
  account's `pocket:fees` and are swept as an extra call in that account's next outgoing
  operation; balances owed are shown in the console and statements.
- Every fee is a ledger entry into `sys:revenue` plus a `fee_charge` row.

## Consequences

- Agent Bank never holds an allowance or key that can take funds.
- A seller that never transacts can accumulate owed fees; plan limits and the console handle
  collection (the owner can settle with an owner operation).
