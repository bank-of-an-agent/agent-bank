# x402: pay for APIs

An agent pays for HTTP APIs and MCP tools per call with [x402](https://www.x402.org): the server answers 402 with a price, the agent pays in USDC and retries. With Agent Bank every such payment is checked against the owner's policy and signed by the agent's spend key; buyers pay no Agent Bank fee. The [first x402 call](/get-started/first-x402-call) walks through it end to end; this page is the reference.

## The flow

```text
agent ──GET /report──────────────▶ seller
      ◀─402 PAYMENT-REQUIRED──────  (accepts: exact, USDC on eip155:84532, amount, payTo, maxTimeoutSeconds)
agent ──POST /v1/x402/pay────────▶ Agent Bank: policy (x402 domain, caps, velocity, mandate), hold on the float
      ◀─EIP-3009 authorization───  (from = spend key, to = payTo, value, validAfter/validBefore, nonce)
agent checks it, signs with the spend key
agent ──GET /report + PAYMENT-SIGNATURE─▶ seller ──verify/settle──▶ facilitator ──▶ USDC.transferWithAuthorization
      ◀─200 + PAYMENT-RESPONSE───────────  (settlement: transaction, network, payer)
```

1. **Parse the challenge.** x402 v2 sends it base64-encoded in the `PAYMENT-REQUIRED` header; v1 sends it as the JSON body. The client keeps the server's `error` field (for example why a previous payment was refused).
2. **Pick a requirement.** Only scheme `exact`, on the client's network (default `eip155:84532`, Base Sepolia; mainnets are refused), in Agent Bank's USDC on that network, with the EIP-3009 transfer method. The cheapest acceptable option wins.
3. **Apply the client cap.** A price above `maxAmountPerRequest` (default `1.00` USDC) is refused **before Agent Bank is asked**.
4. **Ask Agent Bank.** `POST /v1/x402/pay` with the account, the resource URL and the chosen requirement. The co-signer's policy matches the seller by the **hostname of the URL that actually answered 402** (after redirects) against `counterparties.x402_domains`, and checks caps, velocity and any mandate. The ledger holds the amount on the spend-key float (`spend → spend_reserved`). The response is the payment (kind `x402`) and the EIP-3009 `TransferWithAuthorization` to sign: the nonce is derived from the payment id, and `validBefore` is now plus the seller's `maxTimeoutSeconds`.
5. **Check before signing.** The SDK refuses to sign unless `from` is its spend key, `to` is the seller's `payTo`, `value` equals the price, the EIP-712 domain's chain id and verifying contract match the network and asset (and its name and version match the challenge's), and the validity window is sane.
6. **Retry with the payment.** The signed payload goes in the `PAYMENT-SIGNATURE` header (`X-PAYMENT` for v1). The seller's facilitator verifies and settles it; the response carries `PAYMENT-RESPONSE` with the settlement.
7. **Reconcile.** The indexer sees `AuthorizationUsed(nonce)` and the transfer, and the ledger posts the hold. If the seller never settles, the authorization expires and the hold is released.

## TypeScript

```ts
const agent = new AgentClient({
  baseUrl,
  accountId,
  session: { id: sessionId, signer: sessionKey },
  spendKey,
  x402: {
    maxAmountPerRequest: "0.10", // client-side cap per request (default 1.00)
    network: "eip155:84532", // default: Base Sepolia
    onPayment: (event) => console.log(`paid ${event.amount} USDC for ${event.requestUrl}`),
  },
});

const response = await agent.fetch("https://api.example-data.com/v1/report?ticker=ACME");

// With details: whether it paid, how much, the Agent Bank payment and the seller's settlement.
const result = await agent.fetchWithPayment(
  "https://api.example-data.com/v1/query",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker: "ACME" }),
  },
  { maxAmountPerRequest: "0.05" },
);
console.log(result.paid, result.amount, result.payment?.id, result.settlement?.transaction);

// A paying fetch for libraries that accept one.
const paidFetch = agent.wrapFetch(fetch);
```

With a `proofSecret`, the same calls first answer a [private-proof](/guides/proofs-agent) challenge (HTTP 401) from a seller that requires one. Set `x402.mandateId` to run every x402 payment under an AP2 [mandate](/concepts/mandates). A per-call `maxAmountPerRequest` override can only lower the configured cap. Request bodies are buffered so the paid retry can resend them. `readPaymentResponse(response)` decodes the settlement header.

Lower-level pieces are exported for custom payers: `wrapFetch(fetch, { payer })`, `fetchWithX402`, `parseChallenge`, `selectRequirement`, `createAgentBankPayer` and `transferWithAuthorizationTypedData`.

## Python

```python
with agent.x402.client(max_amount="0.10", allowed_domains={"api.example-data.com"}) as http:
    response = http.get("https://api.example-data.com/v1/report?ticker=ACME")
receipt = x402_receipt(response)
```

`allowed_domains` adds a client-side domain allowlist on top of the policy's.

## Errors

`X402Error` carries a machine-readable `reason`; API refusals arrive as the usual [errors](/guides/idempotency-and-errors).

| Reason / error              | Meaning                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `invalid_challenge`         | The 402 is not a valid x402 challenge                                                                       |
| `no_acceptable_requirement` | No `exact` USDC option on the client's network                                                              |
| `amount_exceeds_limit`      | The price is above `maxAmountPerRequest`                                                                    |
| `approval_required`         | The policy wants a human approval; x402 cannot wait, so lower the price or raise the approval threshold     |
| `authorization_mismatch`    | The authorization from Agent Bank does not match the challenge; nothing was signed                          |
| `payment_rejected`          | The seller answered 402 again after the signed payment; it may still settle until the authorization expires |
| `spend_key_missing`         | The client has no spend key                                                                                 |
| `PolicyDeniedError`         | The policy refused, for example `counterparties.allowlist` for an unlisted domain                           |
| `InsufficientFundsError`    | The spend-key float cannot cover the price                                                                  |

## The float

x402 payments come from the spend key's float, not the smart account. Refill it with a payment to the spend key (`agent.pay({ to: agent.spendKeyAddress!, amount: "5.00" })`), which is a `refill`: no fee, still within policy. Keep the float small: it is what a fully compromised agent could spend ([Accounts and keys](/concepts/accounts-and-keys#the-spend-key)). `balance().spend_float` shows it.

## Policy for x402

- Allowlist sellers by domain: `counterparties.x402_domains` in allowlist mode, or deny domains with `counterparties.deny.x402_domains`.
- Cap a seller: `counterparties.caps` with `{ "match": { "x402_domain": "api.example-data.com" }, "per_tx": "0.50", "per_day": "20.00" }`.
- Bound the rate: `velocity.max_per_minute`.
- Restrict a mandate to hosts with an `agentbank.x402_domains` constraint.
