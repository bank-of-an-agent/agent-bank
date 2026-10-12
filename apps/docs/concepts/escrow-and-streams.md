# Escrow and streams

Escrows lock funds for a task until it is done; streams pay for ongoing service over time. Both are Agent Bank contracts on Base (`AgentEscrow`, `PaymentStreams`), both are funded by the agent's own signed operation with the co-signer's approval, and both are subject to the owner's policy like any payment (kinds `escrow` and `stream`).

## Escrow

```ts
const escrow = await agent.createEscrow(
  {
    payee: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0", // or an address
    amount: "50.00",
    expiresInSeconds: 7 * 24 * 3600,
    terms: "Deliver a cleaned CSV of Q3 shipping data with a data dictionary.",
    memo: "Q3 shipping data",
  },
  { waitForSettlement: true },
);
// … the work is delivered and checked …
await agent.releaseEscrow(escrow.id, { waitForSettlement: true });
```

1. **Lock.** `POST /v1/escrows` holds amount plus fee and prepares one operation: approve the escrow contract for the amount, call `AgentEscrow.lock(…)`, and transfer the fee. The agent signs its `user_op_hash`, the co-signer co-signs, and once the `Locked` event is indexed the escrow is `locked` (`escrow.locked` webhook). Only the hash of `terms` goes on-chain (`terms_hash`).
2. **Release.** `POST /v1/escrows/{id}/release` prepares the release; the payer signs it and the funds go to the payee (`released`).
3. **Refund.** `POST /v1/escrows/{id}/refund`: the payee can refund at any time, and anyone can after `expires_at`; the funds return to the payer (`refunded`).
4. **Dispute.** `POST /v1/escrows/{id}/dispute` with a reason, before expiry; the arbiter decides (`disputed`, then `resolved`).

Each action that needs an on-chain call sets `pending_action` (`lock`, `release`, `refund`, `dispute`) and a `signing_request`; the SDK signs it for you, and `agent.completeEscrow(id)` finishes one that was interrupted.

### Who can release

| `release`   | Released by                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payer`     | The paying agent (default)                                                                                                                                       |
| `arbiter`   | An `arbiter` address you name                                                                                                                                    |
| `validator` | A validation result in an ERC-8004 validation registry: `validator.registry`, the `request_hash` of the validation request and a `min_response` score (0 to 100) |

Statuses: `requires_signature`, `locking`, `locked`, `released`, `refunded`, `disputed`, `resolved`, `failed`, `canceled`. Webhooks: `escrow.locked`, `escrow.released`, `escrow.refunded`, `escrow.disputed`.

**Fee:** 1% of the escrowed amount, at least 1.00 USDC, paid in the lock operation. A 50.00 USDC escrow costs 1.00; a 500.00 escrow costs 5.00.

## Streams

```ts
const stream = await agent.createStream(
  {
    payee: "0x2222222222222222222222222222222222222222",
    kind: "streaming",
    amountPerInterval: "0.000278", // per second: about 1.00 USDC an hour
    intervalSeconds: 1,
    deposit: "24.00",
    settleEverySeconds: 3600,
    stopAt: new Date(Date.now() + 24 * 3600 * 1000),
  },
  { waitForSettlement: true },
);
// later
await agent.cancelStream(stream.id);
```

A stream is **pre-funded**: the deposit is locked in `PaymentStreams` when the stream is created, and `amount_per_interval` accrues to the payee every `interval_seconds` from `start_at` until `stop_at` or until the deposit runs out.

| Kind        | Use                                | Example                                                               |
| ----------- | ---------------------------------- | --------------------------------------------------------------------- |
| `streaming` | Pay per second for ongoing service | `interval_seconds: 1`                                                 |
| `recurring` | Pay a fixed amount on a schedule   | `amount_per_interval: "99.00"`, `interval_seconds: 2592000` (30 days) |

Accrued amounts are paid out every `settle_every_seconds` (default 3,600, at least 60) by Agent Bank's keeper calling the contract's `settle`; triggering settlement is permissionless and can only pay the payee what has accrued. Canceling (`POST /v1/streams/{id}/cancel`) settles what has accrued and refunds the rest to the payer.

Statuses: `requires_signature`, `active`, `paused`, `completed`, `canceled`, `failed`; `pending_action` is `create`, `cancel` or `top_up`. Webhooks: `stream.created`, `stream.settled`, `stream.canceled`.

**Fee:** 0.5% of the deposit, paid when the stream is created. A 24.00 USDC deposit costs 0.12.

## Policy and session scope

Escrow locks and stream deposits are checked like payments: caps, allowlists and velocity apply to the amount, `allowed_kinds` can exclude them, and a [mandate](/concepts/mandates) can authorize them (`mandate_id`). If the session scope restricts `allowed_contracts`, it must include the escrow and stream contract addresses (from `GET /v1/meta`, `contracts`).

## Safety of the contracts

The contracts are deliberately small and get fuzz and invariant tests and two independent audits before mainnet; they are **unaudited today**. A pause guardian can stop **new** locks and deposits only. Releases, refunds, withdrawals and exits are never pausable ([contract pause runbook](/operations/runbooks#contract-pause)). Escrow and streams can also be switched off per deployment (`FEATURE_ESCROW`, `FEATURE_STREAMS`; `/v1/meta` reports the flags).

In Python: `client.escrows.lock(payee=…, amount=…, expires_at=…)`, `escrows.release`, `escrows.refund`, `escrows.dispute`, and `client.streams.start(payee=…, amount_per_interval=…, interval_seconds=…, deposit=…)`.
