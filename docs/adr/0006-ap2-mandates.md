# 0006: AP2 mandates

- Status: Accepted
- Date: 2026-10-11

## Context

The design grants agents authority through AP2 mandates. AP2 v0.2 defines open and closed
Checkout and Payment Mandates secured as SD-JWTs, with typed constraints
(`payment.amount_range`, `payment.allowed_payees`, `payment.budget`,
`payment.agent_recurrence`, `payment.execution_date`, `payment.reference`) and a `cnf` key
binding. Agent Bank principals hold Ethereum owner keys, not JWT signing keys.

## Decision

Mandates use the AP2 v0.2 **open Payment Mandate** claims (`vct: mandate.payment.open.1`,
`constraints`, `cnf`, `iat`, `exp`) plus two extension claims (`agent_id`, `description`) and
one extension constraint (`agentbank.x402_domains`). They are signed with the EIP-712
`OwnerAuthorization` (action `mandate.issue`) over the canonical JSON. The policy package
compiles a mandate into deny rules and into the session scope (intersection with the policy).
Every payment records the mandate it ran under.

## Consequences

- Counterparties and auditors can verify the owner's signature over the exact mandate JSON.
- An SD-JWT envelope (for verifiers that only speak AP2) is future work; the claims are already
  AP2-shaped, so it is an encoding change, not a model change.
