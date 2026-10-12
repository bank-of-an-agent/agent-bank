# Webhooks

Webhooks tell your systems when something happens: a payment settles, an approval is requested, an agent is frozen, reconciliation finds a mismatch. Each delivery is an HTTP `POST` of a JSON event, signed with HMAC-SHA256, and retried with backoff for 72 hours.

## Register an endpoint

::: code-group

```ts [TypeScript]
const endpoint = await principal.webhooks.createEndpoint({
  url: "https://ops.example.com/webhooks/agentbank",
  events: [
    "payment.settled",
    "payment.failed",
    "approval.requested",
    "agent.frozen",
    "reconciliation.mismatch",
  ],
});
// endpoint.secret (whsec_…) is shown once: store it in your secret manager.
```

```python [Python]
endpoint = bank.webhooks.create_endpoint(
    url="https://ops.example.com/webhooks/agentbank",
    events=["payment.settled", "payment.failed", "approval.requested", "agent.frozen"],
)
```

:::

`GET /v1/webhook-endpoints` lists endpoints and `DELETE /v1/webhook-endpoints/{id}` disables one. `GET /v1/events` lists past events (filter by `type`), so you can backfill after an outage or poll instead of receiving webhooks. Endpoint secrets are encrypted at rest.

## Events

| Event                        | When                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `payment.created`            | A payment was created                                        |
| `payment.requires_approval`  | A payment is waiting for an approver                         |
| `payment.submitted`          | A co-signed payment was sent to the bundler                  |
| `payment.settled`            | A payment is on-chain and posted in the ledger               |
| `payment.failed`             | A payment reverted, timed out or expired                     |
| `payment.denied`             | The policy or the co-signer refused a payment                |
| `approval.requested`         | An approval was opened (15 minutes to decide)                |
| `approval.decided`           | An approval was approved or denied                           |
| `escrow.locked`              | Escrowed funds are locked on-chain                           |
| `escrow.released`            | An escrow paid its payee                                     |
| `escrow.refunded`            | An escrow refunded its payer                                 |
| `escrow.disputed`            | An escrow is in dispute                                      |
| `stream.created`             | A stream started                                             |
| `stream.settled`             | Accrued stream payments were paid out                        |
| `stream.canceled`            | A stream was canceled                                        |
| `deposit.received`           | USDC arrived at a known address                              |
| `reconciliation.mismatch`    | A chain movement matched no ledger entry; sessions paused    |
| `agent.frozen`               | An agent was frozen                                          |
| `agent.unfrozen`             | An agent was unfrozen                                        |
| `org.frozen`                 | The whole org was frozen                                     |
| `policy.updated`             | A policy changed (including a loosening that is now pending) |
| `session.revoked`            | A session key was revoked                                    |
| `balance.low`                | An account's balance dropped low                             |
| `statement.ready`            | A monthly statement is available                             |
| `proof_settings.updated`     | What an agent may prove changed (on or off, classes)         |
| `proof_reservation.created`  | Funds were reserved for one verifier (proof of funds)        |
| `proof_reservation.released` | The owner released a reservation before it expired           |
| `proof_reservation.expired`  | A reservation ended and its funds returned to `operating`    |

The body is the event; `data` is the resource it is about (a payment, an approval, an escrow…):

```json
{
  "id": "evt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "object": "event",
  "type": "payment.settled",
  "org_id": "org_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "data": { "id": "pay_01JABCDEFGHJKMNPQRSTVWXYZ0", "object": "payment", "status": "settled", "…": "…" },
  "created_at": "2026-10-11T12:00:05.000Z"
}
```

## Headers

| Header                | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| `AgentBank-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>`                  |
| `AgentBank-Event`     | The event type                                           |
| `AgentBank-Delivery`  | The delivery id, the same across retries of one delivery |

## Verifying the signature

`v1 = hex(HMAC-SHA256(secret, "<t>.<raw body>"))`

1. Read the **raw** request body, before any JSON parsing or re-serialization.
2. Parse the header: `t` and one or more `v1` values (several during secret rotation).
3. Reject the delivery if `t` is more than **300 seconds** from your clock.
4. Compute the HMAC over `` `${t}.${rawBody}` `` with the endpoint secret and compare it to each `v1` in constant time. Accept if any matches.

::: code-group

```ts [TypeScript]
import { parseWebhookEvent } from "@agentbank/sdk";
import express from "express";

const app = express();
app.post("/webhooks/agentbank", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = parseWebhookEvent({
      secret: process.env.AGENTBANK_WEBHOOK_SECRET!,
      body: req.body, // Buffer: the raw bytes
      signature: req.get("agentbank-signature"),
    });
  } catch {
    return res.sendStatus(400);
  }
  if (event.type === "payment.settled") console.log(event.data.id, event.data.amount.amount);
  res.sendStatus(204);
});
```

```python [Python]
from agentbank import SignatureVerificationError, construct_event

def handle(raw_body: bytes, signature: str | None) -> int:
    try:
        event = construct_event(SECRET, raw_body, signature)
    except SignatureVerificationError:
        return 400
    if event.type == "payment.settled":
        ...
    return 204
```

```ts [Any language (Node shown)]
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(
  secret: string,
  rawBody: string,
  header: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return parts
    .filter(([k]) => k === "v1")
    .some(([, v]) => {
      const given = Buffer.from(v, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

:::

### Test vector

Both SDKs reproduce this vector from the shared [cross-language vectors](/guides/request-signing#test-vectors):

| Input       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| `secret`    | `whsec_test_vector`                                                                      |
| `timestamp` | `1790000000`                                                                             |
| `body`      | `{"id":"evt_01JABCDEFGHJKMNPQRSTVWXYZ0","type":"payment.settled","data":{"id":"pay_1"}}` |
| header      | `t=1790000000,v1=fe6f54776509c36a3c60aa6c9c7a87f7d7e825f12a125b3f1a7aab3cd749b72b`       |

## Retries

A delivery succeeds when your endpoint answers 2xx within 10 seconds. Anything else is retried on this schedule, measured from the first attempt: immediately, then after 30 seconds, 2, 10 and 30 minutes, 1, 2, 4, 8 and 12 hours, and 24, 36, 48, 60 and 72 hours. After 72 hours the delivery is abandoned; the event stays available in `GET /v1/events`.

So that retries are harmless:

- **Deduplicate on the event id** (`evt_…`): the same event can arrive more than once.
- **Do not rely on order**: a retried `payment.submitted` can arrive after `payment.settled`. Fetch the resource (`GET /v1/payments/{id}`) when you need its current state.
- **Answer quickly** and process asynchronously.
