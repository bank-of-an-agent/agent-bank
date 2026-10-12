# Savings and treasury

Savings keeps agents lean: by default an org's money lives in its **treasury** account, and agents draw what they need through auto top-up. In every tier the money stays in the customer's own smart account or in a fund the owner picked. **Agent Bank never pools deposits and never pays interest itself.**

| Tier                    | What it does                                                                                                           | Return                        | Status                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------ |
| Vaults                  | Goal vaults and time-locked vaults; agents can deposit but cannot withdraw early                                       | None                          | Paid plans                           |
| Treasury sweep          | The owner signs a standing rule to keep a liquid floor and sweep the excess into a tokenized Treasury fund they choose | Paid by the fund to the owner | **Gated on counsel**; off by default |
| Partner savings account | A licensed partner offers an interest-bearing account; Agent Bank is the interface                                     | Paid by the partner           | After v1                             |

## Vaults

`POST /v1/vaults` with `kind`:

- **`goal`**: a ledger pocket (`pocket:vault:<vlt_id>`) inside the account, with an optional `target`. It costs nothing on-chain; a policy rule stops agents from spending it.
- **`locked`**: a position in the `TimeLockVaults` contract (in the audit scope), owned by the account, with an `unlock_at` date. Deposits any time; withdrawals only back to the parent account, and only after the unlock date or with the owner's signature.

Agents and principals can deposit (`POST /v1/vaults/{id}/deposit`). Only principals withdraw (`POST /v1/vaults/{id}/withdraw`); before the unlock date that needs an owner authorization (`vault.withdraw`) and, for locked vaults, an owner operation.

```ts
const vault = await principal.vaults.create({
  account_id: account.id,
  kind: "goal",
  name: "GPU budget",
  target: { amount: "200.00", asset: "USDC" },
});
await agent.vaults.deposit(vault.id, { amount: { amount: "10.00", asset: "USDC" } });
await principal.withdrawVault(vault.id, { amount: "10.00", asset: "USDC" }); // owner-signed
```

## Auto-save

Auto-save rules live in the agent's [policy](/concepts/policies#auto-save) under `auto_save`, are always signed by the owner, and only move money between the org's own accounts. The co-signer enforces them.

| Rule           | Effect                                                                             | Suits                                   |
| -------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| `income_split` | Save `bps` basis points of every inbound payment                                   | Agents that earn through x402 or escrow |
| `excess_sweep` | Move anything above `max_balance` to the destination (the treasury if none is set) | Keeping agents lean                     |
| `round_up`     | Round each outbound payment up to `to_nearest` and save the difference             | Gradual saving                          |
| `scheduled`    | Save a fixed `amount` every `day`, `week` or `month` (up to 10 rules)              | Budgets                                 |

Each rule's destination (`to`) is `treasury` or a vault (`vault:<vlt_ id>`). Fractions round down, so a rule never saves more than it says. Money bound for the treasury waits in `pocket:savings` and is swept with the agent's next outgoing operation.

## Auto top-up

Refill an agent from the org treasury when it runs low: "refill to `refill_to` whenever the balance is below `when_below`, at most `max_per_day` a day".

```ts
await principal.setAutoTopUp(agent.id, {
  refill_to: { amount: "100.00", asset: "USDC" },
  when_below: { amount: "20.00", asset: "USDC" },
  max_per_day: { amount: "300.00", asset: "USDC" },
});
```

The owner signs a `topup.set` authorization, and installs the **`TopUpExecutor`** module on the treasury account with an owner operation. Agent Bank's keeper calls the executor when the rule fires. Triggering is permissionless, but the executor can only move funds from the treasury to that org's own agent accounts, within the configured limits ([ADR 0009](/operations/adrs)), so it is not a privileged bank power.

## Treasury sweep

::: warning Counsel-gated
The treasury sweep is disabled unless a deployment sets `FEATURE_TREASURY_SWEEP=true`, which happens only after counsel signs off on broker-dealer and investment-adviser questions. Until then `PUT /v1/accounts/{id}/sweep-rule` returns `feature_gated`. Nothing on this page is investment advice, and Agent Bank makes no recommendation about any fund.
:::

The design, for when it is enabled:

1. The owner picks a fund from a **neutral eligibility list** (`GET /v1/funds`): regulated funds that subscribe and redeem in USDC on Base and accept the owner's investor status. Each entry lists the issuer, settlement time (same day or next day), eligible investor types, jurisdictions, minimum and a disclosure.
2. The owner completes the fund's own KYC. Fund shares sit in the owner's treasury account, never in a bank-held wallet.
3. The owner signs a sweep rule (`sweep.set`) and installs the **`SweepExecutor`** with an owner operation. It can only subscribe and redeem between that account and the single allowlisted fund; session keys and the co-signer cannot touch fund shares.
4. The rule sets a liquid **floor** (default: two days of trailing seven-day spend), a sweep **threshold**, and a cap on the share of funds in savings (`max_share_bps`). Redemptions start when the floor is breached, sized for the fund's settlement time.
5. The ledger marks shares in `pocket:savings` to the fund's published price daily; gains belong to the owner. Agent Bank's fee is 0.15% a year on swept balances, accrued daily and collected monthly, or a flat plan feature if counsel requires it.

## What Agent Bank never does

- Pay yield itself, or pool customers' savings.
- Hold fund shares or savings in a bank-controlled wallet.
- Recommend a fund.
- Move savings anywhere the owner did not choose: executors move money only between the org's own accounts or to the one fund the owner allowlisted.
