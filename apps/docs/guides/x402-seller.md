# x402: charge for APIs

An agent (or any service) can sell its API per call with [x402](https://www.x402.org) and get paid in USDC. `@agentbank/sdk/x402-server` provides a paywall that answers unpaid requests with a 402 challenge, verifies and settles payments through Agent Bank's facilitator, and adapts to Express, Node `http`, Fastify, Hono and Web `Request`/`Response` runtimes. Any x402 client can pay it, not only Agent Bank agents.

## A paywall in a few lines

```ts
import { createPaywall, expressPaywall } from "@agentbank/sdk/x402-server";
import express from "express";

const weather = createPaywall({
  facilitatorUrl: "https://<agent-bank-host>/v1/x402", // Agent Bank's facilitator
  payTo: "0xYourAccountAddress", // your Agent Bank account
  price: "0.01", // USDC per request
  description: "Current weather",
  mimeType: "application/json",
});

const app = express();
app.get("/weather", expressPaywall(weather), (_req, res) => res.json({ city: "Lisbon", temp: 21 }));
app.listen(4021);
```

Locally, `pnpm --filter @agentbank/e2e sandbox` runs the facilitator at `http://localhost:8083/v1/x402`; no hosted facilitator is running yet.

## Settle before serve above $1

x402 separates verifying a payment from settling it, and a published security analysis traces several bug classes to that gap. The paywall therefore picks the order by price:

- **Above 1.00 USDC** (strictly), the payment is **settled before the handler runs**. If settlement fails, the client gets a 402 and the handler never runs.
- **At or below 1.00 USDC**, the handler runs first and the payment settles after; the response is **held back until settlement succeeds**, and a failed settlement turns it into a 402. A handler that fails (status 400 or above) is **never charged**.
- `settlement: "before-serve"` forces settle-before-serve at every price.

Every authorization is **single-use**: concurrent replays of the same payment are refused before they reach the facilitator, and the facilitator keeps its own single-use nonce table and checks `authorizationState` on-chain, so a replay across several server instances fails too.

## Options

| Option                    | Default                       | Meaning                                                                                  |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `facilitatorUrl`          | required                      | The paywall posts to `${facilitatorUrl}/verify` and `/settle`                            |
| `payTo`                   | required                      | Address that receives the payments                                                       |
| `price`                   | required                      | Price per request in USDC, `"0.01"` or `"$0.01"`                                         |
| `network`                 | `eip155:84532` (Base Sepolia) | CAIP-2 network; mainnets are refused                                                     |
| `asset`                   | USDC on the network           | Token address                                                                            |
| `description`, `mimeType` | none                          | Advertised in the challenge                                                              |
| `maxTimeoutSeconds`       | 60                            | How long the payer's authorization must stay valid                                       |
| `resource`                | the request URL               | A fixed resource URL to advertise                                                        |
| `settlement`              | `"auto"`                      | `"auto"` (settle before serving above $1.00) or `"before-serve"`                         |
| `facilitatorHeaders`      | none                          | Extra headers (or a function returning them) for third-party facilitators that need auth |
| `facilitatorTimeoutMs`    | 30000                         | Timeout of each facilitator call                                                         |
| `acceptV1`                | `true`                        | Also accept x402 v1 payments (`X-PAYMENT`) and advertise a v1 challenge body             |
| `fetch`                   | global `fetch`                | The `fetch` used to call the facilitator                                                 |

The challenge is sent as x402 v2 (`PAYMENT-REQUIRED` header) and, with `acceptV1`, as a v1 JSON body. Successful responses carry `PAYMENT-RESPONSE` with the settlement.

## Adapters

```ts
import {
  expressPaywall,
  fastifyPaywall,
  honoPaywall,
  nodePaywall,
  withPaywall,
} from "@agentbank/sdk/x402-server";

// Express / Connect
app.get("/weather", expressPaywall(paywall), (req, res) => res.json({ temp: 21 }));

// Node http
createServer(nodePaywall(paywall, (req, res) => res.end("paid content")));

// Fastify: route hooks
fastify.get("/weather", { ...fastifyPaywall(paywall) }, async () => ({ temp: 21 }));

// Hono
app.get("/weather", honoPaywall(paywall), (c) => c.json({ temp: 21 }));

// Web Request/Response: Next.js route handlers, Bun, Deno, Cloudflare Workers
export const GET = withPaywall(paywall, async () => Response.json({ temp: 21 }));
```

The adapters use structural types only, so the SDK has no runtime dependency on any framework. For anything else, `paywall.process({ url, method, headers })` returns either the 402 to send or a verified payment with `settle()`.

The SDK's `examples/seller-paywall.ts` runs a Node server with a 0.01 USDC route and a 2.00 USDC route, one on each side of the settle-before-serve threshold.

## Register as a payee

Register the account that receives the payments and the domains it sells on:

```ts
const payee = await principal.x402.registerPayee({
  account_id: account.id,
  domains: ["api.example-data.com"],
});
console.log(payee.pay_to, payee.facilitator_url, payee.fee_bps); // fee_bps: 50 (0.50%)
```

Agent Bank charges sellers **0.50% of the settled amount**; buyers pay nothing. The fee accrues to the seller account's `fees` pocket and is swept with its next outgoing operation ([Fees and plans](/concepts/fees-and-plans)). Payments into an Agent Bank account count as inbound income for [auto-save](/concepts/savings#auto-save) income splits.

## The facilitator

Agent Bank's facilitator implements the x402 v2 facilitator API for the `exact` EVM scheme, at `/v1/x402`:

| Endpoint                 | Does                                                  |
| ------------------------ | ----------------------------------------------------- |
| `POST /v1/x402/verify`   | Checks a payment without moving money                 |
| `POST /v1/x402/settle`   | Verifies again and relays `transferWithAuthorization` |
| `GET /v1/x402/supported` | Supported schemes and networks                        |

Verification checks the network, the asset, `payTo`, the amount, the time window (it rejects authorizations valid for less than 6 more seconds), the signature (EOA, or ERC-1271 for deployed contracts), the payer's balance, the token's `authorizationState` and its own single-use nonce table, and screens the payer. Answers use the x402 shapes (`isValid`/`invalidReason`, `success`/`errorReason`/`transaction`/`network`/`payer`). The routes are public, and standard x402 tooling (for example `HTTPFacilitatorClient`) can use them.
