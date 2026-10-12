# Fees and plans

Agent Bank earns from fees on money movement and from subscriptions, not from deposits: being non-custodial, it has no float to lend. Every fee is a ledger entry into `sys:revenue` (plus a fee record), so revenue reconciles like every other movement.

::: info Pre-release pricing
These are the planned prices. During the testnet phase all money is test USDC; prices may change before launch.
:::

## Transaction fees

| Stream           | Price                                         | Paid by | Collected                                                            |
| ---------------- | --------------------------------------------- | ------- | -------------------------------------------------------------------- |
| Outbound payment | 0.20% of the amount, at most 5.00 USDC        | Payer   | In the same operation as the payment                                 |
| x402 receive     | 0.50% of the settled amount                   | Seller  | Accrued to the seller's `fees` pocket, swept with its next operation |
| x402 pay         | Free for buyers                               | —       | —                                                                    |
| Escrow           | 1% of the escrowed amount, at least 1.00 USDC | Payer   | In the lock operation                                                |
| Streams          | 0.50% of the deposit                          | Payer   | In the create operation                                              |
| Spend-key refill | Free                                          | —       | —                                                                    |
| Treasury sweep   | 0.15% a year on swept balances                | Owner   | Accrued daily, collected monthly (counsel-gated feature)             |
| Gas              | At cost, no margin                            | Account | The paymaster sponsors it; the cost accrues to the `fees` pocket     |

Fees are computed in integer minor units and round half up. Examples:

| Operation      | Amount   | Fee                |
| -------------- | -------- | ------------------ |
| Payment        | 2.50     | 0.005              |
| Payment        | 100.00   | 0.20               |
| Payment        | 5,000.00 | 5.00 (the cap)     |
| x402 sale      | 0.01     | 0.00005, accrued   |
| Escrow         | 50.00    | 1.00 (the minimum) |
| Escrow         | 500.00   | 5.00               |
| Stream deposit | 24.00    | 0.12               |

A payment's `fee` field shows what it costs before you sign, and the hold covers amount plus fee.

## How fees are collected

Agent Bank never holds an allowance or a key that could pull funds from an account; that would cross the non-custodial line ([ADR 0008](/operations/adrs)). Instead:

- Fees on operations the payer initiates (payments, escrow locks, stream creation) are a **second transfer to the revenue address inside the same user operation** that the agent signs and the co-signer approves. The agent sees and signs the fee.
- Fees with no payer operation (x402 receive, subscriptions, the treasury sweep, gas) **accrue** to the account's `pocket:fees` and are swept as an extra call in that account's next outgoing operation. Amounts owed show in the console, the balances (`fees`) and statements.
- An account that never transacts can accumulate owed fees; plan limits and the console handle collection, and the owner can settle with an owner operation.

## Plans

| Plan       | Price                           | For             | Includes                                                        |
| ---------- | ------------------------------- | --------------- | --------------------------------------------------------------- |
| Free       | $0                              | Developers      | Sandbox, up to 3 agents, a small monthly volume cap             |
| Pro        | $99 a month                     | Small teams     | Up to 25 agents, approvals, vaults, auto-save                   |
| Business   | $499 a month                    | Companies       | Unlimited agents, multi-approver, treasury sweep, audit exports |
| Enterprise | About $4,000 a month on average | Large companies | SSO, custom policy, SLA, a dedicated co-signer region           |

Subscriptions are billed monthly in USDC from the org treasury: they accrue on the treasury's `fees` pocket and are swept with its next operation. The API is the source of truth for current plans and features:

| Endpoint                              | Returns                                             |
| ------------------------------------- | --------------------------------------------------- |
| `GET /v1/billing/plans`               | Plans with price, agent limit and features (public) |
| `GET /v1/billing/subscription`        | The org's plan and billing period                   |
| `PUT /v1/billing/subscription`        | Change plan                                         |
| `GET /v1/billing/fees?period=YYYY-MM` | Fees charged in a month, by kind                    |

## Why these prices

Gross margin is about 92% at every stage of the model, so profit depends on volume per org against a fixed cost base. Escrow and subscriptions are the most defensible streams; x402 receive fees face the most competition, which is why buyers pay nothing. The full model, its assumptions and its sensitivity are in the [design document](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/design.md#business-model); every figure there is a planning assumption, not a forecast.
