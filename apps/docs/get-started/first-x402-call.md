# Your first x402 call

[x402](https://www.x402.org) turns HTTP status 402 Payment Required into a payment protocol: a server answers an unpaid request with a price, the client pays and retries with proof of payment, and the server serves the response. Agent Bank agents pay with USDC under the owner's policy, and Agent Bank runs a facilitator that sellers use to verify and settle those payments.

You will run a small paid API (the seller) and call it as an agent (the buyer).

## How the agent pays

1. The agent requests the resource and gets `402` with a `PAYMENT-REQUIRED` header: the x402 v2 challenge, listing the accepted `exact` payments (network, USDC contract, amount in atomic units, `payTo`, timeout).
2. The SDK picks the cheapest acceptable USDC option on its network and refuses anything above its client-side cap (`maxAmountPerRequest`, default 1.00 USDC) before contacting Agent Bank.
3. `POST /v1/x402/pay` asks Agent Bank to authorize the payment. The co-signer checks the seller's domain against the policy's `x402_domains` allowlist, the caps, the velocity limits and any mandate; the ledger holds the amount on the spend-key float; the API returns an EIP-3009 `TransferWithAuthorization` to sign, whose nonce is derived from the payment id.
4. The SDK checks that the authorization matches the challenge exactly (payee, amount, token, chain, validity window), signs it with the **spend key** and retries with the `PAYMENT-SIGNATURE` header.
5. The seller's facilitator verifies and settles the authorization on-chain; the indexer matches the `AuthorizationUsed` event to the payment and the ledger posts it.

The spend key is a plain EOA holding a small float, because x402's `exact` scheme needs an EIP-3009 signature that the smart account cannot produce through the session-plus-co-signer path. Its loss bound is the float. See [Accounts and keys](/concepts/accounts-and-keys#the-spend-key).

## 1. Start a paid API

The quickest way is the local sandbox, which already runs a demo seller next to the API and the
facilitator, paying a sandbox account:

```bash
pnpm --filter @agentbank/e2e sandbox
# Facilitator    http://localhost:8083/v1/x402
# Demo seller    http://localhost:4021   GET /weather $0.01 · GET /report $2.00
```

It also prints an agent env block (`AGENTBANK_API_URL`, `AGENTBANK_ACCOUNT_ID`,
`AGENTBANK_SESSION_ID`, `AGENTBANK_SESSION_KEY`, `AGENTBANK_SPEND_KEY`) for an agent funded with
1,000 USDC plus a 25 USDC spend-key float, with an open counterparty policy (caps of 500 USDC per
payment and 2,000 USDC a day, approval above 250 USDC). The sandbox runs on the simulated chain, so
its x402 network is `eip155:1337`; the SDKs read the network and the USDC contract from
`GET /v1/meta`.

To run your own seller instead, point the SDK's example at the facilitator:

```bash
AGENTBANK_FACILITATOR_URL=http://localhost:8083/v1/x402 \
SELLER_PAY_TO=0xYourSellerAccountAddress \
pnpm --filter @agentbank/sdk exec tsx examples/seller-paywall.ts
```

The paywall is a few lines with `@agentbank/sdk/x402-server`; see [x402: charge for APIs](/guides/x402-seller).

## 2. Allow the domain

x402 payments are matched against the policy by the seller's hostname. The policy from the [principal setup](/get-started/principal-setup#_4-set-the-policy) already allowlists `localhost`; for your own sellers add their domains to `counterparties.x402_domains`. Domains are lowercase hostnames: an IP address cannot be allowlisted, so call the seller as `localhost`, not `127.0.0.1`.

## 3. Call it as the agent

::: code-group

```ts [TypeScript]
import { AgentClient } from "@agentbank/sdk";
import { FileKeyStore, loadKey } from "@agentbank/sdk/node";

const sessionId = process.env.AGENTBANK_SESSION_ID!;
const store = new FileKeyStore({ path: process.env.AGENTBANK_KEYSTORE! });
const agent = new AgentClient({
  baseUrl: process.env.AGENTBANK_API_URL,
  accountId: process.env.AGENTBANK_ACCOUNT_ID!,
  session: { id: sessionId, signer: (await loadKey(store, `session:${sessionId}`))! },
  spendKey: await loadKey(store, "spend"),
  // Defense in depth on top of the owner's policy: never pay more than this per request.
  x402: { maxAmountPerRequest: "0.10" },
});

const result = await agent.fetchWithPayment("http://localhost:4021/weather");
console.log(result.response.status, result.paid ? `paid ${result.amount} USDC` : "free");
console.log(result.payment?.id, result.settlement?.transaction);
console.log(await result.response.json());
```

```python [Python]
from pathlib import Path
from agentbank import AgentBank, SessionKey, X402Error, x402_receipt

keys = Path(".agentbank")
agent = AgentBank(
    session_key=SessionKey.load(keys / "session.json"),
    spend_key=SessionKey.load(keys / "spend.json"),
)
with agent, agent.x402.client(max_amount="0.10") as http:
    try:
        response = http.get("http://localhost:4021/weather")
    except X402Error as err:
        raise SystemExit(f"not paid ({err.code}): {err.detail}")
    receipt = x402_receipt(response)
    print(response.status_code, receipt.payment.id if receipt else "free")
```

:::

`agent.fetch(url)` returns just the `Response`; `agent.wrapFetch(fetch)` gives you a paying `fetch` to hand to libraries that accept one. Try `/report` too: at 2.00 USDC it is above the 0.10 cap, so the SDK refuses it with `X402Error` reason `amount_exceeds_limit` and Agent Bank is never asked.

On the simulated chain, set the network on both sides to the deployment's CAIP-2 id from `GET /v1/meta` (`caip2`, `eip155:1337`): `x402: { network: "eip155:1337" }` for the buyer and `network: "eip155:1337"` in `createPaywall` for the seller. On Base Sepolia the default `eip155:84532` applies.

## When it does not pay

| Error                                   | Why                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `X402Error` `amount_exceeds_limit`      | The price is above `maxAmountPerRequest`; nothing was asked of Agent Bank                                         |
| `X402Error` `no_acceptable_requirement` | No `exact` USDC option on the client's network                                                                    |
| `PolicyDeniedError` `policy_denied`     | The owner's policy refused, e.g. the domain is not on the allowlist (`counterparties.allowlist`)                  |
| `X402Error` `approval_required`         | The price is above an approval threshold; x402 cannot wait for a human, so raise the threshold or lower the price |
| `InsufficientFundsError`                | The spend-key float cannot cover it: refill it with a payment to the spend key                                    |
| `X402Error` `payment_rejected`          | The seller refused the signed payment; it may still settle until the authorization expires                        |

## Next

- Give an LLM agent these tools: the [framework quickstarts](/quickstarts/).
- Sell your own API: [x402: charge for APIs](/guides/x402-seller).
