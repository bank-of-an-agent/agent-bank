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
- Private proofs: an agent proves what Agent Bank attests about it (a verified company backs it,
  its limits, funds reserved for you, its track record) without revealing which agent it is;
  sellers admit agents with `@agentbank/sdk/proof-server`.
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

### Private proofs

An agent proves facts Agent Bank attests about it ("a verified company backs me", "I can pay $5 a
call", "$500 is reserved for you") without revealing which agent, account or company it is
([design](../../docs/private-proofs.md)). The secret never leaves the agent; Agent Bank only sees
`Poseidon(secret)`. The owner decides what may be disclosed.

```ts
import { AgentClient, generateProofSecret } from "@agentbank/sdk";

// Owner: enable proofs and choose classes (owner-signed only when it widens disclosure).
await principal.proofs.configure(agentId, {
  enabled: true,
  disclose: ["principal", "limits", "reservations"],
});

// Agent: keep the secret like a key, enroll its commitment once.
const agent = new AgentClient({ baseUrl, accountId, session, spendKey, proofSecret: generateProofSecret() });
await agent.proofs.enroll();

// Proof challenges (401 AGENT-PROOF-REQUIRED) are answered before x402 payments, in one call.
const { response, proofPresented, nullifier, paid } = await agent.fetchWithPayment(
  "https://api.seller.example/report",
);

// Proof of funds: hold $500 for one verifier (no spending or cancelling it until it expires);
// a request asking for reserved funds is then proved from it automatically.
await agent.proofs.reserve({ amount: "500.00", scope: "api.seller.example", forSeconds: 3600 });
const { header } = await agent.proofs.answer(request); // send as AGENT-PROOF
```

`prove` / `answer` refuse locally with a typed `ProofError` (`unsatisfiable`, `undisclosed`,
`reservation_required`, `scope_mismatch`, …) and answer at most 30 requests per verifier and hour
(`proofs.maxPresentationsPerScopePerHour`), since many questions with different thresholds would
narrow the values down. Proving runs in Node (about 1.5 s); the circuit files ship in `dist/circuits/`.
In Node the client loads the prover (`@agentbank/sdk/prover`) on its own, from a location bundlers
never follow, so importing `@agentbank/sdk` in a browser or a Next.js app stays free of it. In a
bundled server app pass it explicitly (`proofs: { prover: nodeProver }` from
`@agentbank/sdk/prover`); outside Node, pass a prover of your own.

Sellers verify locally, statelessly, against roots anchored on Base:

```ts
import {
  apiRootResolver,
  canPayPerTx,
  createProofGate,
  honoProofGate,
  verifiedCompany,
} from "@agentbank/sdk/proof-server";
import { honoPaywall } from "@agentbank/sdk/x402-server";

const gate = createProofGate({
  scope: "api.seller.example", // your host name
  key: process.env.PROOF_GATE_KEY!, // at least 32 bytes; nonces are HMACs, no per-challenge state
  require: [verifiedCompany(), canPayPerTx("5.00")],
  rootResolver: apiRootResolver("https://api.agentbank.example"), // or chainRootResolver(client, registry)
});
// Gate first, then the paywall: the agent's paid retry reuses its proof.
app.get(
  "/report",
  honoProofGate(gate, { beforePaywall: true }),
  honoPaywall(paywall),
  (c) => c.json({ agent: c.get("agentProof").nullifier }), // a stable pseudonym, different at every seller
);
```

Adapters: `withProofGate` (Web `Request`/`Response`), `honoProofGate`, `expressProofGate`,
`nodeProofGate`, `fastifyProofGate`; `proofOf(request)` returns the verified proof.

Contracts verify on-chain with `AgentClaimsVerifier`. A contract that admits agents through
`verifyAndConsume` asks for its own scope id, `onchainScopeId(chainId, consumer, context)`
(`eip155:<chainId>:<consumer>:<context>`, which maps to `scopeOf(consumer, context)`); the agent
proves it explicitly (the automatic fetch flow never answers on-chain scopes), and
`toClaimsVerifierArgs(request, presentation)` returns `{ claims, proof }` for viem with
`CLAIMS_VERIFIER_ABI` (all three from `@agentbank/sdk/proof-server`; the helper also from
`/prover`):

```ts
const request = createProofRequest({ scope: onchainScopeId(84532, consumer, context), require });
const { claims, proof } = toClaimsVerifierArgs(request, await agent.proofs.prove(request));
await client.readContract({
  address: verifier,
  abi: CLAIMS_VERIFIER_ABI,
  functionName: "verify",
  args: [claims, proof, 16, 7_200n],
});
```

Runnable versions: [`examples/`](examples) (principal setup, agent payment, x402 fetch, seller
paywall). Guides: the [documentation site](../../apps/docs).

## Development

```bash
pnpm --filter @agentbank/sdk test        # fake API that verifies signatures; x402 interop with @x402/*
pnpm --filter @agentbank/sdk build       # ESM + CJS + types in dist/, @agentbank/core and /proofs bundled
pnpm --filter @agentbank/sdk smoke:dist  # the built SDK (ESM and CJS) proves with dist/circuits/
```

A test fails whenever an operation in the route registry has no SDK method.

## License

Apache-2.0
