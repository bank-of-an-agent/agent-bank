# Mandates

A mandate is a principal's signed grant of authority to an agent: "this agent may spend up to this much, with these payees, until then". Agent Bank compiles each mandate into extra policy rules and into the session scope, and every payment records the mandate it ran under. Counterparties and auditors get cryptographic proof that a human authorized the spend.

## The AP2 open Payment Mandate profile

Mandates use the **AP2 v0.2 open Payment Mandate** claims (`vct: mandate.payment.open.1`): a list of typed constraints, an optional key binding (`cnf`), and issue and expiry times. Agent Bank adds two extension claims (`agent_id`, `description`) and one extension constraint (`agentbank.x402_domains`). AP2 secures mandates as SD-JWTs; Agent Bank principals hold Ethereum owner keys, so v1 signs the canonical JSON of the mandate with an EIP-712 `OwnerAuthorization` instead ([ADR 0006](/operations/adrs)). The claims are already AP2-shaped, so an SD-JWT envelope for AP2-only verifiers is an encoding change, planned for later.

```json
{
  "vct": "mandate.payment.open.1",
  "agent_id": "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "description": "Buy market data for the Q4 research report",
  "iat": 1791000000,
  "exp": 1798761599,
  "constraints": [
    { "type": "payment.amount_range", "currency": "USD", "max": 2500 },
    { "type": "payment.budget", "currency": "USD", "max": 50000 },
    {
      "type": "payment.allowed_payees",
      "allowed": [
        { "id": "api.example-data.com", "name": "Example Data", "website": "https://example-data.com" },
        { "id": "0x2222222222222222222222222222222222222222", "name": "Dataset vendor" }
      ]
    },
    { "type": "payment.agent_recurrence", "frequency": "ON_DEMAND", "max_occurrences": 200 },
    { "type": "payment.execution_date", "not_after": "2026-12-31T23:59:59Z" }
  ]
}
```

This mandate lets the agent pay the two listed payees up to $25 per payment and $500 in total, at most 200 times, until the end of 2026.

## Claims

| Claim         | Meaning                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `vct`         | Always `mandate.payment.open.1`                                                                                                           |
| `constraints` | 1 to 50 typed constraints; all must hold for every payment under the mandate                                                              |
| `cnf`         | Optional key binding: `{ "jwk": { "kty": "EC", "crv": "secp256k1", … } }` or `{ "eth_address": "0x…" }`, normally the agent's session key |
| `iat`, `exp`  | Issued-at and expiry, Unix seconds (`exp` after `iat`; 5 minutes of clock leeway on `iat`)                                                |
| `agent_id`    | Agent Bank extension: the agent the mandate is granted to                                                                                 |
| `description` | Agent Bank extension: the natural-language intent shown to the principal (at most 2,000 characters)                                       |

## Constraints

Amounts are integers in minor units of `currency`: cents for `USD`, micro-units (6 decimals) for `USDC`. USD and USDC are treated 1:1, so `{"currency": "USD", "max": 2500}` and `{"currency": "USDC", "max": 25000000}` both mean 25.00 USDC. Large values may be given as integer strings.

| Constraint                 | Fields                                        | A payment under the mandate must…                                                                                                                           | Rule id                                         |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `payment.amount_range`     | `currency`, `max`, optional `min`             | be between `min` and `max`                                                                                                                                  | `mandate.amount_range`                          |
| `payment.budget`           | `currency`, `max`                             | keep the mandate's cumulative spend, including this payment, at or below `max`                                                                              | `mandate.budget`                                |
| `payment.allowed_payees`   | `allowed[]`: `id`, `name`, optional `website` | go to one of the payees; an `id` is an address, an agent id (`agt_…`), an ERC-8004 id or an x402 domain                                                     | `mandate.allowed_payees`                        |
| `payment.agent_recurrence` | `frequency`, optional `max_occurrences`       | respect the count, and be spaced by at least the frequency's shortest period minus two hours (a day, 7, 14, 28, 89 or 365 days; `ON_DEMAND` has no spacing) | `mandate.max_occurrences`, `mandate.recurrence` |
| `payment.execution_date`   | optional `not_before`, `not_after`            | happen inside the window                                                                                                                                    | `mandate.execution_date`                        |
| `agentbank.x402_domains`   | `allowed[]` hostnames                         | be an x402 payment to a listed host (non-x402 payments are denied under such a mandate)                                                                     | `mandate.x402_domains`                          |

Repeated constraints of the same type intersect. The engine also checks that the mandate was granted to this agent (`mandate.agent`), is valid now (`mandate.not_yet_valid`, `mandate.expired`) and covers the asset (`mandate.asset`).

## Issuing a mandate

The owner signs an `OwnerAuthorization` with action `mandate.issue`, subject the agent id, over the canonical JSON of the mandate object, and the principal posts both to `POST /v1/mandates`:

::: code-group

```ts [TypeScript]
const mandate = await principal.issueMandate(agent.id, {
  vct: "mandate.payment.open.1",
  agent_id: agent.id,
  description: "Buy market data for the Q4 research report",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  constraints: [
    { type: "payment.budget", currency: "USD", max: 50_000 },
    { type: "agentbank.x402_domains", allowed: ["api.example-data.com"] },
  ],
});
```

```python [Python]
import time

mandate = bank.mandates.create(
    agent_id=agent.id,
    mandate={
        "vct": "mandate.payment.open.1",
        "agent_id": agent.id,
        "description": "Buy market data for the Q4 research report",
        "iat": int(time.time()),
        "exp": int(time.time()) + 30 * 24 * 3600,
        "constraints": [
            {"type": "payment.budget", "currency": "USD", "max": 50_000},
            {"type": "agentbank.x402_domains", "allowed": ["api.example-data.com"]},
        ],
    },
    owner=owner,
)
```

:::

The API returns the [Mandate](/api/schemas#mandate) with its `status` (`active`, `expired`, `revoked`) and `spent`, the cumulative spend that `payment.budget` is checked against. Revoke it with `DELETE /v1/mandates/{id}`.

## Paying under a mandate

Pass the mandate id on the payment: `mandate_id` on `POST /v1/payments`, `/v1/x402/pay`, `/v1/escrows` and `/v1/streams` (`mandateId` in the SDKs, `mandate_id` in the MCP tools). The payment then has to satisfy the policy **and** the mandate, the decision's `rule_hits` show both, and the payment and its ledger entries record the `mandate_id`. A session that acts under a mandate gets the intersection of the policy's and the mandate's caps as its on-chain scope, with the per-transaction cap no higher than the mandate's `amount_range.max` and the daily cap no higher than the remaining budget.

Errors specific to mandates are `mandate_invalid` (malformed, wrong agent, not usable) and `mandate_expired` (HTTP 422).

## Verifying a mandate

Anyone holding the mandate JSON and the owner authorization can check the signature: rebuild the EIP-712 `OwnerAuthorization` (`action: "mandate.issue"`, `subject` = agent id, `payloadHash` = Keccak-256 of the mandate's canonical JSON) and recover the signer. The [request signing](/guides/request-signing#owner-authorizations) page gives the exact encoding and a test vector.
