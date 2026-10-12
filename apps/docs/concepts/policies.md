# Policies

A policy is the owner's spending rules for one agent. It is enforced twice: by a deterministic policy engine that the co-signer runs before every signature, and by the session key's scope on-chain. No language model sits in the decision path: models may flag anomalies, but only rules decide.

```json
{
  "agent": "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "asset": "USDC",
  "limits": { "per_tx": "25.00", "per_day": "200.00", "per_month": "2000.00" },
  "counterparties": {
    "mode": "allowlist",
    "x402_domains": ["api.example-data.com"],
    "new_cooldown_minutes": 60
  },
  "velocity": { "max_per_minute": 30 },
  "approvals": [
    { "above": "100.00", "approvers": 1 },
    { "above": "1000.00", "approvers": 2 }
  ],
  "max_balance": "500.00"
}
```

Set it with `PUT /v1/agents/{id}/policy` (`principal.setPolicy(agentId, policy)` in the TypeScript SDK, `bank.policies.put(agent_id, policy=..., owner=...)` in Python), read it with `GET /v1/agents/{id}/policy`, and dry-run any payment with `POST /v1/policy/check`. The full schema is [PolicyDocument](/api/schemas#policy-document). Amounts are decimal strings in USDC.

## Decisions

`evaluate(policy, context) → decision` is a pure function: the same policy and context always produce the same decision. Every applicable rule is evaluated (there is no short-circuit) and reported in `rule_hits` with a stable id, an effect and a human-readable detail. The outcome is the most severe effect:

**`deny` > `require_owner` > `require_approval` > `allow`**

| Outcome            | What happens                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `allow`            | The payment proceeds to signing and co-signing                                                        |
| `require_approval` | The payment waits for `approvers_required` human approvals ([Approvals](/concepts/approvals))         |
| `require_owner`    | The owner key must sign the payment itself, as an [owner operation](/concepts/owner-operations)       |
| `deny`             | Nothing is held or sent. `retry_at` says when a time-based denial (cooling period, time window) lifts |

The engine fails closed: no policy denies with `policy.missing`, a malformed context with `context.invalid`, and any unexpected error with `engine.error`. A frozen agent or org denies with `agent.frozen` or `org.frozen`.

```json
{
  "outcome": "deny",
  "rule_hits": [
    {
      "rule": "counterparties.allowlist",
      "effect": "deny",
      "detail": "api.unknown-seller.com is not on the allowlist (x402 payments match by host name)"
    },
    {
      "rule": "limits.per_day",
      "effect": "allow",
      "detail": "0.05 USDC + 12.40 USDC already spent is within the daily limit (rolling 24 h) of 200.00 USDC"
    }
  ],
  "approvers_required": 0,
  "policy_version": 3,
  "evaluated_at": "2026-10-11T12:00:00.000Z",
  "retry_at": null
}
```

## Rules

### Amount limits

```json
"limits": { "per_tx": "25.00", "per_day": "200.00", "per_week": "800.00", "per_month": "2000.00" }
```

Caps on the payment amount (`limits.per_tx`) and on spend over **rolling** windows: a day is the last 24 hours, a week the last 7 days, a month the last 30 days (`limits.per_day`, `limits.per_week`, `limits.per_month`). A payment is denied when `spent + amount > cap`. Omit a field for no cap.

### Counterparties

`counterparties.mode` decides how the identifier lists are read. A counterparty is identified by its **address**, Agent Bank **agent id**, **ERC-8004 id** or, for x402 payments, the seller's **x402 domain** (lowercase hostname).

| Mode        | Top-level lists (`addresses`, `agent_ids`, `erc8004_ids`, `x402_domains`) | `deny` lists  |
| ----------- | ------------------------------------------------------------------------- | ------------- |
| `open`      | Not allowed (use `deny`)                                                  | Always denied |
| `allowlist` | The only counterparties that may be paid (`counterparties.allowlist`)     | Always denied |
| `denylist`  | Denied (`counterparties.denylist`)                                        | Also denied   |

```json
"counterparties": {
  "mode": "allowlist",
  "addresses": ["0x2222222222222222222222222222222222222222"],
  "agent_ids": ["agt_01JABCDEFGHJKMNPQRSTVWXYZ0"],
  "x402_domains": ["api.example-data.com"],
  "deny": { "addresses": ["0x9999999999999999999999999999999999999999"] }
}
```

x402 payments match by host name; transfers match by address, agent id or ERC-8004 id. Each list holds up to 1,000 entries.

**Cooling period.** `new_cooldown_minutes` (0 to 10,080) delays payments to counterparties the agent has never paid: a first payment is denied (`counterparties.cooldown`) with `retry_at` set to when the period ends.

**Per-counterparty caps.** Up to 100 caps, each matching exactly one identifier:

```json
"caps": [
  { "match": { "x402_domain": "api.example-data.com" }, "per_tx": "0.50", "per_day": "20.00" },
  { "match": { "agent_id": "agt_01JABCDEFGHJKMNPQRSTVWXYZ0" }, "per_month": "300.00" }
]
```

(`counterparties.caps.per_tx`, `counterparties.caps.per_day`, `counterparties.caps.per_month`; the day and month are rolling, per counterparty.)

### Velocity

```json
"velocity": { "max_per_minute": 30, "max_per_hour": 300, "max_per_day": 2000 }
```

Counts of payments in the last minute, hour and 24 hours. A payment is denied when the count already made in the window is `>= max` (`velocity.per_minute`, `velocity.per_hour`, `velocity.per_day`).

### Time windows

```json
"time_windows": [
  { "days": ["mon", "tue", "wed", "thu", "fri"], "start": "09:00", "end": "18:00", "timezone": "Europe/London" },
  { "days": ["fri"], "start": "22:00", "end": "02:00", "timezone": "UTC" }
]
```

Payments are allowed only inside one of the windows (`time_windows`). A window covers `[start, end)` in its IANA time zone (default `UTC`); `end` may be `24:00`; a window whose start is after its end runs overnight into the next day (the second example covers Friday 22:00 to Saturday 02:00). Daylight-saving changes are handled by the time-zone database. Outside every window the payment is denied with `retry_at` at the next opening.

### Approvals

```json
"approvals": [
  { "above": "100.00", "approvers": 1 },
  { "above": "1000.00", "approvers": 2 }
]
```

A ladder of up to five thresholds. A payment whose amount is strictly above a threshold needs that many approvers (1 to 5); the highest threshold it exceeds wins. The outcome is `require_approval` (`approvals`). Approvals expire after 15 minutes. See [Approvals](/concepts/approvals).

### Owner threshold

```json
"require_owner_above": "5000.00"
```

Above this amount the owner key must sign the payment itself (`require_owner_above`), as an owner operation. No co-signer is involved.

### Payment kinds

```json
"allowed_kinds": ["transfer", "x402"]
```

Restrict the kinds of payment the agent may make (`kinds.allowed`): `transfer`, `x402`, `escrow`, `stream`, `payout`, `refill`. Omit the field to allow all.

### Maximum balance

```json
"max_balance": "500.00"
```

The most the agent may hold. Anything above it is swept to the org treasury, or to the destination of `auto_save.excess_sweep`, by the auto-save job. Lowering it is a tightening.

### Auto-save

```json
"auto_save": {
  "income_split": { "bps": 1000, "to": "treasury" },
  "round_up": { "to_nearest": "1.00", "to": "vault:vlt_01JABCDEFGHJKMNPQRSTVWXYZ0" },
  "excess_sweep": { "to": "treasury" },
  "scheduled": [{ "amount": "10.00", "every": "week", "to": "treasury" }]
}
```

Rules that move money between the org's own accounts: save a share of every inbound payment (`bps` of 10,000), round outbound payments up and save the difference, sweep the excess above `max_balance`, or save a fixed amount every day, week or month. Targets are `treasury` or a vault (`vault:<vlt_ id>`). Fractions round down. See [Savings and treasury](/concepts/savings#auto-save).

### Refills

A payment from the agent's account to its own spend key is a `refill` (no fee). Counterparty rules do not apply to it, but the payment must go to the registered spend key (`refill.target`) and every amount, velocity, mandate and session rule still does.

### Mandate and session rules

When a payment runs under an AP2 [mandate](/concepts/mandates), the engine also checks it (`mandate.*`), and the co-signer checks the session key's scope (`session.*`). These are reported in the same `rule_hits`.

## Rule ids

| Group          | Rule ids                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural     | `policy.missing`, `policy.invalid`, `policy.agent`, `context.invalid`, `engine.error`, `agent.frozen`, `org.frozen`, `kinds.allowed`, `asset`, `counterparty.invalid`, `refill.target`                                                              |
| Counterparties | `counterparties.denylist`, `counterparties.allowlist`, `counterparties.cooldown`, `counterparties.caps.per_tx`, `counterparties.caps.per_day`, `counterparties.caps.per_month`                                                                      |
| Time           | `time_windows`                                                                                                                                                                                                                                      |
| Amounts        | `limits.per_tx`, `limits.per_day`, `limits.per_week`, `limits.per_month`                                                                                                                                                                            |
| Velocity       | `velocity.per_minute`, `velocity.per_hour`, `velocity.per_day`                                                                                                                                                                                      |
| Mandate        | `mandate.agent`, `mandate.asset`, `mandate.not_yet_valid`, `mandate.expired`, `mandate.execution_date`, `mandate.amount_range`, `mandate.allowed_payees`, `mandate.x402_domains`, `mandate.budget`, `mandate.max_occurrences`, `mandate.recurrence` |
| Session        | `session.revoked`, `session.expired`, `session.asset`, `session.max_per_tx`, `session.max_per_day`, `session.allowed_recipients`, `session.allowed_contracts`                                                                                       |
| Human controls | `require_owner_above`, `approvals`                                                                                                                                                                                                                  |

Rule ids are a public contract: dashboards, alerts, the audit log and agents key off them, so an id is never renamed or reused.

## Rolling windows

The off-chain engine uses rolling windows: 24 hours, 7 days and 30 days. Calendar windows would let an agent spend twice the daily cap across midnight. The on-chain hook counts UTC days, because that is cheap in Solidity; a UTC-day bucket is always looser than or equal to the rolling window, so the off-chain engine is the tighter of the two layers ([ADR 0010](/operations/adrs)).

## Tightening and loosening

Policy changes are asymmetric, so that a stolen admin session cannot quietly raise limits and drain an agent:

| Change kind | Example                                                      | Owner signature      | Takes effect |
| ----------- | ------------------------------------------------------------ | -------------------- | ------------ |
| `initial`   | The agent's first policy                                     | yes                  | immediately  |
| `tighten`   | Lower a cap, remove an allowlist entry, add a denylist entry | no                   | immediately  |
| `loosen`    | Raise or remove a cap, allowlist a new domain                | yes                  | after 1 hour |
| `mixed`     | Raise one cap and lower another                              | yes                  | after 1 hour |
| `unchanged` | Formatting, or only `auto_save` edits                        | only for `auto_save` | immediately  |

The classifier compares what the old and new policies allow, rule by rule: lower or newly added caps, removed allowlist entries, added denylist entries, a switch from open or denylist to allowlist, a longer cooling period, lower velocity limits, fewer allowed kinds, narrower time windows (compared minute by minute over a reference week), lower approval thresholds or more approvers, and binding the policy to an agent all **tighten**; their opposites, and removing a cap entirely, **loosen**. Anything it cannot prove tighter is treated as a loosening, so the worst case of an imprecise comparison is an unnecessary signature and delay. `auto_save` changes only move money between the org's own accounts, so they never wait, but they are always owner-signed.

The owner signs an EIP-712 `OwnerAuthorization` with action `policy.loosen`, subject the agent id, over the canonical JSON of the policy document. While a loosening waits, `GET /v1/agents/{id}/policy` shows it as `pending` with its `effective_at`, and a `policy.updated` webhook fires. The co-signer is the enforcement authority; the API keeps a copy for display.
