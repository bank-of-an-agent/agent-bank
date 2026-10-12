# @agentbank/sdk

The TypeScript SDK for [Agent Bank](https://github.com/bank-of-an-agent): give an AI agent a
non-custodial USDC account with hard spending limits, pay other agents and HTTP APIs with
[x402](https://x402.org), and charge for your own APIs.

> [!NOTE]
> Pre-release, testnet only (Base Sepolia). Not yet published to npm: build from this
> repository with `pnpm --filter @agentbank/sdk build`.

## Features

- A typed client for every REST operation, generated from the same route registry as the API.
- Agent requests signed with the session key (RFC 9421), automatic idempotency keys, retries
  with backoff, and RFC 9457 errors as typed exceptions (`PolicyDeniedError`, …).
- `AgentClient`: pay (create → sign → submit → wait for settlement), dry-run against policy,
  escrow, streams, payment requests, ledger entries.
- `PrincipalClient`: org and agent setup, owner-signed policies and mandates, session grants,
  spend-key provisioning, owner operations, freezes, owner-key rotation.
- x402 buyer: `fetchWithPayment` / `wrapFetch` answer HTTP 402 with a payment signed by the
  agent's spend key, after Agent Bank checks policy. Interoperates with the official x402 packages.
- x402 seller: `createPaywall` with Express, Fastify, Hono, Next.js and Node `http` adapters;
  settles before serving above $1.
- Webhook verification and typed event parsing; a 0600 file key store for Node.

## Requirements

Node.js 20 or later (or a modern browser for the client; `@agentbank/sdk/node` is Node-only).

## Usage

### Set up an agent (principal)

```ts
import { PrincipalClient, generateSessionKey, generateSpendKey, signerFromPrivateKey } from "@agentbank/sdk";

const principal = new PrincipalClient({ baseUrl, apiKey, owner: signerFromPrivateKey(ownerKey) });

const agent = await principal.agents.create({ name: "research-bot" });
await principal.setPolicy(agent.id, {
  limits: { per_tx: "25.00", per_day: "200.00" },
  counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"] },
  approvals: [{ above: "100.00", approvers: 1 }],
});

// Account, x402 spend key (with its float-recovery permit) and a first 24-hour session,
// installed on-chain by an owner-signed setup operation.
const spendKey = generateSpendKey();
const sessionKey = generateSessionKey();
const { account, session } = await principal.setupAgentAccount({
  agentId: agent.id,
  spendKey: spendKey.account,
  session: { publicKey: sessionKey.address, scope: { max_per_tx: "25.00", max_per_day: "200.00" } },
});
```

### Pay (agent)

```ts
import { AgentClient, PolicyDeniedError } from "@agentbank/sdk";

const agent = new AgentClient({
  baseUrl,
  accountId,
  session: { id: sessionId, signer: sessionKey },
  spendKey,
});

const decision = await agent.checkSpend({ amount: "12.50", to });
const payment = await agent.pay({ to, amount: "12.50", memo: "dataset" }, { waitForSettlement: true });

// Pay-per-call: answers a 402 within policy, capped per request on the client too.
const { response, paid, amount } = await agent.fetchWithPayment("https://api.example-data.com/v1/quotes");
```

### Charge per call (seller)

```ts
import { createPaywall, nodePaywall } from "@agentbank/sdk/x402-server";

const paywall = createPaywall({ facilitatorUrl: "http://localhost:8080/v1/x402", payTo, price: "0.01" });
const handler = nodePaywall(paywall, (_req, res) => res.end(JSON.stringify({ ok: true })));
```

Runnable versions: [`examples/`](examples) (principal setup, agent payment, x402 fetch, seller
paywall). Guides: the [documentation site](../../apps/docs).

## Development

```bash
pnpm --filter @agentbank/sdk test        # fake API that verifies signatures; x402 interop with @x402/*
pnpm --filter @agentbank/sdk build       # ESM + CJS + types in dist/, @agentbank/core bundled
```

A test fails whenever an operation in the route registry has no SDK method.

## License

Apache-2.0
