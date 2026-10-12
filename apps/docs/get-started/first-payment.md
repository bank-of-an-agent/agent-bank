# Your first payment

Now switch sides: you are the **agent**. The agent authenticates every request with an [RFC 9421 signature](/guides/request-signing) by its session key; it has no API key and cannot change its own limits. You need the environment printed at the end of the [principal setup](/get-started/principal-setup):

```bash
export AGENTBANK_API_URL=http://localhost:8080
export AGENTBANK_ACCOUNT_ID=acct_…
export AGENTBANK_SESSION_ID=ses_…
export AGENTBANK_KEYSTORE=$PWD/.agentbank/agent.keystore.json
```

## Create the agent client

::: code-group

```ts [TypeScript]
import { AgentClient } from "@agentbank/sdk";
import { FileKeyStore, loadKey } from "@agentbank/sdk/node";

const sessionId = process.env.AGENTBANK_SESSION_ID!;
const store = new FileKeyStore({ path: process.env.AGENTBANK_KEYSTORE! });
const sessionKey = await loadKey(store, `session:${sessionId}`);
if (!sessionKey) throw new Error("run the principal setup first");

const agent = new AgentClient({
  baseUrl: process.env.AGENTBANK_API_URL,
  accountId: process.env.AGENTBANK_ACCOUNT_ID!,
  session: { id: sessionId, signer: sessionKey },
});
```

```python [Python]
from pathlib import Path
from agentbank import AgentBank, SessionKey

# AGENTBANK_SESSION_ID and AGENTBANK_ACCOUNT_ID come from the environment.
agent = AgentBank(session_key=SessionKey.load(Path(".agentbank/session.json")))
```

:::

## Check the balance

```ts
const balance = await agent.balance();
console.log(balance.available, balance.reserved, balance.escrow, balance.spend_float);
```

`available` is the `operating` pocket, what the agent can spend now. `reserved` is held for payments in flight, `escrow` is locked in escrows, `savings` is in vaults, `spend_float` is the x402 float on the spend key and `fees` is fees accrued and not yet swept.

## Dry-run the payment

`checkSpend` evaluates the owner's policy without holding or moving anything (`POST /v1/policy/check`):

```ts
const decision = await agent.checkSpend({ amount: "2.50", to: "0x2222222222222222222222222222222222222222" });
console.log(decision.outcome); // "allow" | "deny" | "require_approval" | "require_owner"
for (const hit of decision.rule_hits) console.log(hit.rule, hit.effect, hit.detail);
```

Every rule that was checked reports a hit with a stable id, such as `limits.per_day` or `counterparties.allowlist`, so the agent can explain a denial instead of guessing. For time-based denials (a cooling period, a closed time window) `retry_at` says when the payment would pass.

## Pay

::: code-group

```ts [TypeScript]
import { PolicyDeniedError } from "@agentbank/sdk";

try {
  const payment = await agent.pay(
    { to: "0x2222222222222222222222222222222222222222", amount: "2.50", memo: "dataset purchase" },
    { waitForSettlement: true, idempotencyKey: "dataset-2026-10-11-001" },
  );
  console.log(payment.id, payment.status, payment.fee.amount, payment.tx_hash);
} catch (error) {
  if (error instanceof PolicyDeniedError) console.error(error.message, error.decision?.rule_hits);
  else throw error;
}
```

```python [Python]
from agentbank import PaymentError, PolicyDeniedError

try:
    payment = agent.pay(
        to="0x2222222222222222222222222222222222222222",
        amount="2.50",
        memo="dataset purchase",
        idempotency_key="dataset-2026-10-11-001",
        wait_for_settlement=True,
    )
    print(payment.id, payment.status, payment.fee.amount, payment.tx_hash)
except PolicyDeniedError as err:
    print("denied:", err.detail)
except PaymentError as err:
    print("did not settle:", err.code, err.detail)
```

:::

`to` can be an address (`0x…`), another agent (`agt_…`) or an Agent Bank account (`acct_…`). The amount is always a decimal string.

## What just happened

1. **Create.** `POST /v1/payments` (signed by the session key). The API resolves the counterparty, computes the fee (0.20%, at most 5.00 USDC; 0.005 here) and asks the co-signer for a dry-run decision.
2. **Decide and hold.** A denial ends here: the payment is `denied`, with the decision attached, and nothing is held. Otherwise the ledger moves amount plus fee from `operating` to `reserved`. Not enough funds gives `insufficient_funds`.
3. **Approval, if required.** Above an approval threshold the payment is `requires_approval` and an approver decides in the console within 15 minutes. With `waitForApproval: true` the SDK waits and then continues.
4. **Sign.** The API prepares one ERC-4337 user operation that transfers the amount to the payee, the fee to Agent Bank's revenue address, and any fees or savings due, and returns `requires_signature` with `signing_request.user_op_hash`. The SDK checks that the payment matches what you asked for, signs the raw hash with the session key and submits it (`POST /v1/payments/{id}/signature`).
5. **Co-sign.** The co-signer recomputes the hash from the raw operation, decodes the calls, verifies the session signature and scope, re-evaluates the policy against its own spend history and signs, or refuses (the payment becomes `denied` and the hold is voided).
6. **Settle.** The API submits through the bundler (`submitted`). The smart account checks both signatures and the session scope on-chain. When the indexer sees the transfer, the ledger posts the hold and the payment is `settled`; a revert or timeout makes it `failed` and voids the hold.

| Status               | Meaning                                                      | Terminal |
| -------------------- | ------------------------------------------------------------ | -------- |
| `requires_approval`  | Waiting for human approval (15 minutes)                      | no       |
| `requires_signature` | Waiting for the session key's signature (10 minutes)         | no       |
| `submitted`          | Co-signed and sent to the bundler                            | no       |
| `settled`            | On-chain and posted in the ledger                            | yes      |
| `denied`             | Refused by the policy engine or the co-signer; nothing moved | yes      |
| `failed`             | Reverted or timed out on-chain; the hold was released        | yes      |
| `canceled`           | Canceled before submission                                   | yes      |
| `expired`            | The signature or approval window passed                      | yes      |

## Retrying safely

Every write carries an `Idempotency-Key`. The SDK generates one per call and reuses it across its own retries; pass your own (as above) to make a retry safe across process restarts too. The same key with the same request returns the original payment; the same key with a different request is rejected with `idempotency_conflict`. See [Idempotency and errors](/guides/idempotency-and-errors).

## Next

[Your first x402 call](/get-started/first-x402-call): pay for an HTTP API per request.
