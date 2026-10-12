# Require proofs as a seller

A paid API, an MCP tool provider or a marketplace can admit agents by what Agent Bank attests about them ("a verified company backs it", "it can pay $5 a call", "$500 is reserved for us") **without learning which agent it is**. Your server answers with `401` and a proof request, the agent proves in zero knowledge, and you verify locally (about 15 ms in Node, about a second in pure Python) against roots Agent Bank publishes on Base. `@agentbank/sdk/proof-server` (TypeScript) and `agentbank.proofs` (Python) do both sides of the exchange; they mirror the [x402 paywall](/guides/x402-seller). [Private proofs](/concepts/private-proofs) explains the model; agents read [Prove facts as an agent](/guides/proofs-agent).

::: warning Testnet only
The proving keys come from a single-party, testnet-only trusted setup and the circuit has not been audited. Do not gate anything of real value on these proofs yet; see [what you trust](#what-you-trust).
:::

## Choose requirements

A requirement is a bound on one or more attested facts. Pick the builders for what you need to know:

| Product            | You want to know                             | TypeScript                                                   | Python                                                     | Class          |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | -------------- |
| Agent credentials  | A verified individual or company backs it    | `verifiedPrincipal()`                                        | `verified_principal()`                                     | `principal`    |
| Agent credentials  | A verified company backs it                  | `verifiedCompany()`                                          | `verified_company()`                                       | `principal`    |
| Agent credentials  | Its policy lets it pay $5 in one transaction | `canPayPerTx("5.00")`                                        | `can_pay_per_tx("5.00")`                                   | `limits`       |
| Agent credentials  | Its policy lets it pay $200 a day            | `canPayPerDay("200.00")`                                     | `can_pay_per_day("200.00")`                                | `limits`       |
| Agent credentials  | Its spending is capped (a bounded risk)      | `spendingCappedAt({ perTx: "50.00", perDay: "500.00" })`     | `spending_capped_at(per_tx="50.00", per_day="500.00")`     | `limits`       |
| Proof of funds     | It held $1,000 at the last snapshot          | `balanceAtLeast("1000.00")`                                  | `balance_at_least("1000.00")`                              | `balance`      |
| Proof of funds     | $500 is reserved for you for the next hour   | `reservedFor("500.00", { forSeconds: 3600 })`                | `reserved_for("500.00", for_seconds=3600)`                 | `reservations` |
| Private reputation | Its account is older than 90 days            | `accountOlderThan(90)`                                       | `account_older_than(90)`                                   | `account_age`  |
| Private reputation | A track record with no lost disputes         | `reputation({ paymentsSettled: 50, disputesLostAtMost: 0 })` | `reputation(payments_settled=50, disputes_lost_at_most=0)` | `reputation`   |

`reputation` also takes `volumeSettled` (decimal USDC), `escrowsCompleted` and `counterparties`. `reservedFor` takes `until` (unix seconds or a `Date`) instead of `forSeconds` for a fixed deadline, such as an auction's close. A plain constraints object works as a requirement too, for example `{ disputes_lost: { max: "0" } }`: money facts take decimal USDC strings, the others base-10 integers.

Requirements are intersected into one bound per fact; a combination that cannot hold is refused with a `ProofRequestError`. Ask only for what you need:

- **Each bound needs the owner's consent.** An agent whose owner did not disclose a class cannot prove anything about it, so every class you add excludes some agents.
- **Keep thresholds fixed per resource.** Every answer reveals that the bound holds, so agents limit how many proofs they give one verifier (30 per hour by default in both SDKs). Varying thresholds from request to request is what probing looks like.
- **Values are coarse and dated.** Balances and volumes are whole dollars, the account's age is in days, and every fact is as of the last snapshot (at most a couple of hours old). A balance can be spent after the snapshot; ask for a reservation when you need a commitment.

## A gate in a few lines

::: code-group

```ts [TypeScript]
import { Hono } from "hono";
import {
  apiRootResolver,
  canPayPerTx,
  createProofGate,
  honoProofGate,
  verifiedCompany,
  type ProofGateVariables,
} from "@agentbank/sdk/proof-server";

const gate = createProofGate({
  scope: "api.seller.example", // your host name
  key: process.env.PROOF_GATE_KEY!, // at least 32 bytes; nonces are HMACs, so no per-challenge state
  require: [verifiedCompany(), canPayPerTx("5.00")],
  rootResolver: apiRootResolver("http://localhost:8080"), // Agent Bank's API
});

const app = new Hono<{ Variables: ProofGateVariables }>();
app.get("/report", honoProofGate(gate), (c) => {
  const { nullifier } = c.get("agentProof"); // this agent's pseudonym here
  return c.json({ agent: nullifier });
});
```

```python [Python]
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agentbank import AsyncAgentBank
from agentbank.proofs import can_pay_per_tx, verified_company

bank = AsyncAgentBank()  # public endpoints only: no credentials
gate = bank.proofs.gate(
    scope="api.seller.example",  # your host name
    key=os.environ["PROOF_GATE_KEY"],  # >= 32 bytes; nonces are HMACs, so no per-challenge state
    require=[verified_company(), can_pay_per_tx("5.00")],
)
app = FastAPI()


@app.get("/report")
async def report(request: Request) -> JSONResponse:
    result = await gate.check(request.headers)  # reads AGENT-PROOF
    if result.kind == "proof-required":
        challenge = result.response
        return JSONResponse(challenge.body, status_code=challenge.status, headers=challenge.headers)
    # result.nullifier is this agent's pseudonym here; result.headers carry AGENT-PROOF-RESPONSE.
    return JSONResponse({"agent": result.nullifier}, headers=result.headers)
```

:::

What happens on the wire:

1. A request without `AGENT-PROOF` gets `401` with `WWW-Authenticate: AgentProof realm="api.seller.example"`, `AGENT-PROOF-REQUIRED` (the base64 JSON request: your scope, a fresh nonce, the bounds, `min_anonymity_set`, `max_root_age_seconds`, the chain) and the body `{ "error": "proof_required", "reason": null, "request": { … } }`.
2. The agent retries with `AGENT-PROOF: base64(json({ request, presentation }))`.
3. The gate checks the request is one it issued (its HMAC nonce) and unused, the presentation proves that exact request, the root is published, valid, fresh and large enough, and the Groth16 proof. On success the handler runs and the response carries `AGENT-PROOF-RESPONSE` with the agent's nullifier; otherwise the agent gets a new `401` with the [reason](#failure-reasons).

A proof is single-use: the gate remembers each accepted nonce until its request expires. The SDKs prove once per request, so an agent calling a gated route often spends a proof (about a second and a half) and a slot of its probing guard each time. For frequent calls, gate a sign-in route instead and issue your own short-lived token for the nullifier.

The handler learns a `VerifiedProof`:

| Field       | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `nullifier` | The agent's pseudonym for your scope: the same on every visit, different at every seller |
| `root`      | The attested-facts root the proof used                                                   |
| `scope`     | Your scope                                                                               |
| `request`   | The verified request: which bounds were proven                                           |

### Adapters

```ts
import {
  expressProofGate,
  fastifyProofGate,
  honoProofGate,
  nodeProofGate,
  proofOf,
  withProofGate,
} from "@agentbank/sdk/proof-server";

// Express / Connect
app.get("/report", expressProofGate(gate), (req, res) => res.json({ agent: proofOf(req)?.nullifier }));

// Node http
createServer(nodeProofGate(gate, (req, res) => res.end(JSON.stringify({ agent: proofOf(req)?.nullifier }))));

// Fastify: a route hook
fastify.get("/report", { ...fastifyProofGate(gate) }, async (request) => ({
  agent: proofOf(request)?.nullifier,
}));

// Hono
app.get("/report", honoProofGate(gate), (c) => c.json({ agent: c.get("agentProof").nullifier }));

// Web Request/Response: Next.js route handlers, Bun, Deno, Cloudflare Workers
export const GET = withProofGate(gate, async (request) =>
  Response.json({ agent: proofOf(request)?.nullifier }),
);
```

`proofOf(target)` takes the Web `Request`, the Node or Express `req`, the Fastify `request` or the Hono context; Node, Express and Fastify also set `agentProof` on the request object. The adapters use structural types only, so the SDK has no runtime dependency on any framework. If the root lookup fails (Agent Bank's API or your RPC is unreachable), they answer `502` with `proof_verifier_unavailable`: they fail closed.

For anything else, `gate.check(headers)` returns `{ kind: "proof-required", reason, response }` (send `response.status`, `.headers`, `.body`) or `{ kind: "verified", nullifier, root, request, headers }` (add `headers` to your 2xx). It throws when the root lookup fails; answer 5xx. In Python, `ProofGate` is the synchronous gate (`bank.proofs.gate(...)` on an `AgentBank`), `AsyncProofGate` the asynchronous one, and both take an explicit `root_resolver=` when built directly.

### Without HTTP

For bids or messages that do not travel as HTTP requests, build the request and verify the answer yourself:

```ts
import {
  apiRootResolver,
  createProofRequest,
  reservedFor,
  verifyPresentation,
} from "@agentbank/sdk/proof-server";

const request = createProofRequest({
  scope: "bids.example",
  require: [reservedFor("500.00", { forSeconds: 3600 })],
});
// … send `request` to the agent, receive its `presentation` …
const result = await verifyPresentation({
  request, // your own copy, never the one the agent sends back
  presentation,
  rootResolver: apiRootResolver("http://localhost:8080"),
});
if (result.valid) console.log(result.nullifier);
else console.log(result.reason);
```

Python has `create_proof_request(scope, require=[…])` and `verify_presentation(request, presentation, root_resolver=…)`. Without a gate, single use is yours: remember each accepted `request.nonce` until `request.expires_at`. `POST /v1/proofs/verify` (`client.proofs.verify(request, presentation)`, `bank.proofs.verify(...)`) runs the same checks on Agent Bank's side for verifiers that cannot verify locally, at the cost of trusting Agent Bank with the proof check too; nonce freshness stays yours.

## Proofs and payments together

A resource can require a proof and a payment. Put the gate **before** the [x402 paywall](/guides/x402-seller) and pass `{ beforePaywall: true }`:

```ts
import { createPaywall, honoPaywall } from "@agentbank/sdk/x402-server";

const paywall = createPaywall({ facilitatorUrl: "http://localhost:8083/v1/x402", payTo, price: "0.05" });

app.get("/report", honoProofGate(gate, { beforePaywall: true }), honoPaywall(paywall), (c) =>
  c.json({ agent: c.get("agentProof").nullifier }),
);
```

| Request                | Gate                                        | Paywall              | Agent gets                                        |
| ---------------------- | ------------------------------------------- | -------------------- | ------------------------------------------------- |
| No proof               | `401` with the proof request                | not reached          | `401 AGENT-PROOF-REQUIRED`                        |
| Proof, no payment      | Verifies, **does not use the proof up yet** | `402` with the price | `402 PAYMENT-REQUIRED`                            |
| Same proof and payment | Verifies and uses the proof up              | Verifies and settles | `200`, `AGENT-PROOF-RESPONSE`, `PAYMENT-RESPONSE` |

An agent never sees a price, let alone pays, before it qualifies. The agent SDKs run all three steps in one call (`fetchWithPayment`, `x402.client()`, `fetch_paid_resource`) and reuse the proof on the paid retry. Without `beforePaywall` the gate uses the proof up on the second request, and the agent must prove again alongside its payment.

```ts
// Express
app.get("/report", expressProofGate(gate, { beforePaywall: true }), expressPaywall(paywall), handler);

// Node http
createServer(nodeProofGate(gate, nodePaywall(paywall, handler), { beforePaywall: true }));

// Fastify: both pre-handlers in order, and the paywall's onSend
const proof = fastifyProofGate(gate, { beforePaywall: true });
const pay = fastifyPaywall(paywall);
fastify.get("/report", { preHandler: [proof.preHandler, pay.preHandler], onSend: pay.onSend }, handler);

// Web Request/Response
export const GET = withProofGate(gate, withPaywall(paywall, handler), { beforePaywall: true });
```

The Python SDK has no paywall of its own. In front of one, split the gate's check: `peek` verifies without using the proof up, so the agent's paid retry can carry the same proof, and `commit` uses it up right before you serve (`check` does both at once):

```python
result = await gate.peek(request.headers)
if result.kind == "proof-required":
    return JSONResponse(result.response.body, status_code=401, headers=result.response.headers)
if not paid(request):  # your x402 server's check
    return payment_required()  # 402: the proof stays valid for the paid retry
if not await gate.commit(result):  # False: the proof was used meanwhile (a replay)
    challenge = gate.challenge("nonce_reused")
    return JSONResponse(challenge.body, status_code=401, headers=challenge.headers)
return JSONResponse(serve(), headers=result.headers)
```

A seller that gates and charges the same resource sees the agent's pseudonym next to its payment, which comes from the agent's spend key and is linked on-chain to its account. Payments are not private.

## Options

| Option (TS)         | Python                 | Default          | Meaning                                                                                         |
| ------------------- | ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `scope`             | `scope`                | required         | Your identifier, normally your host name (1 to 253 characters)                                  |
| `key`               | `key`                  | required         | HMAC key for the nonces, at least 32 bytes; strings are UTF-8 encoded                           |
| `require`           | `require`              | required (TS)    | The requirements every request carries                                                          |
| `rootResolver`      | `root_resolver`        | required         | `apiRootResolver(baseUrl)` or `chainRootResolver(client, registry)`; `bank.proofs.gate` sets it |
| `ttlSeconds`        | `ttl_seconds`          | `300`            | How long a challenge stays valid                                                                |
| `minAnonymitySet`   | `min_anonymity_set`    | `16`             | Fewest agents the root's tree must hold                                                         |
| `maxRootAgeSeconds` | `max_root_age_seconds` | `7200`           | Oldest snapshot accepted                                                                        |
| `replayCache`       | `replay_cache`         | in memory        | Used nonces; share one across instances                                                         |
| `chainId`           | `chain_id`             | `84532`          | Chain the root must be published on; mainnets are refused                                       |
| `registry`          | `registry`             | `null`           | Pin the registry address (`null`: the deployment's)                                             |
| `now`               | `now`                  | the system clock | Clock in unix seconds                                                                           |
| `verificationKey`   | `verification_key`     | the bundled key  | The circuit's verification key                                                                  |

**Scope.** Use your host name. Agent SDKs answer a challenge only when its scope is the host they called, so a proof made for you cannot be relayed to someone else. The nullifier is derived from the scope: keep it stable, or every agent's pseudonym changes.

**Minimum anonymity set.** A proof hides the agent among the agents in that root's tree. The default refuses roots with fewer than 16; raise it for more privacy, never lower it in production. A [local sandbox](/get-started/sandbox) has a handful of agents, so experiment there with `minAnonymitySet: 1` and `PROOFS_MIN_ANONYMITY_SET=1`.

**Maximum root age.** Roots are rebuilt at least hourly (`PROOFS_ROOT_INTERVAL_SECONDS`, 3600 by default) and within about a minute of an enrollment, settings change or reservation, and stay valid for two hours. A lower maximum gives fresher facts but refuses agents with `root_too_old` until the next rebuild; keep it above the deployment's rebuild interval.

**Root resolver.** `apiRootResolver(baseUrl)` asks Agent Bank's public `GET /v1/proofs/roots/{root}`. `chainRootResolver(publicClient, registry)` reads `AgentAttestationRegistry.rootInfo` on Base with a viem public client, so you do not trust Agent Bank's API for a root's status. `GET /v1/proofs/circuit` gives the deployment's `registry` and `verifier` addresses (`null` when not deployed).

### The gate key

The key turns the gate's nonces into HMACs of the request, which is how it stays stateless: it recognizes its own requests without storing them.

- **Generate** at least 32 random bytes, for example `openssl rand -hex 32`, and keep it in your secret manager.
- **Keep it secret.** The gate accepts any request with a valid HMAC, so whoever holds the key can issue requests your gate treats as its own, including requests with weaker bounds than yours.
- **Behind a load balancer**, give every instance the same key (a challenge from one instance may be answered at another) and the same `replayCache`, for example Redis behind the `has(nonce, now)` and `consume(nonce, expiresAt, now)` interface. With per-instance memory caches, a proof could be replayed at another instance until it expires.
- **Rotating** the key invalidates outstanding challenges: a proof for a challenge issued before the rotation is refused with `nonce_invalid`, and the agent's next request gets a new challenge. Changing `require` applies to new challenges; requests already issued stay valid until they expire.

## Failure reasons

The gate checks in this order and stops at the first failure. The agent receives the reason in the `401` body (`reason`); the TypeScript agent SDK reports it as `ProofError` `proof_rejected` with `verifierReason`.

| Reason                    | Meaning                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `malformed`               | `AGENT-PROOF` is not a valid envelope, request or presentation                                             |
| `request_expired`         | The request's `expires_at` has passed                                                                      |
| `nonce_invalid`           | The gate did not issue this request: another scope, a tampered request, or a rotated key                   |
| `nonce_reused`            | The proof was already accepted once (a replay)                                                             |
| `request_hash_mismatch`   | The presentation proves another request than the one presented                                             |
| `unknown_root`            | The root is not published on the request's chain and registry                                              |
| `root_revoked`            | The root was revoked: an owner narrowed disclosure, froze the agent, released a reservation or re-enrolled |
| `root_expired`            | The root is past its `valid_until`                                                                         |
| `root_too_old`            | The root's snapshot is older than `max_root_age_seconds`                                                   |
| `anonymity_set_too_small` | The root's tree holds fewer agents than `min_anonymity_set`                                                |
| `invalid_proof`           | The Groth16 proof does not verify against the statement rebuilt from your request                          |

The gate never takes the statement from the agent: it rebuilds the public inputs from its own request, the presented root and the presented nullifier.

## On-chain verification

`AgentClaimsVerifier` checks the same proofs in a contract, against `AgentAttestationRegistry`. A valid proof costs about **410,000 gas** (around a cent on Base). Its address is `verifier` in `GET /v1/proofs/circuit`; the ABI and the `IAgentClaimsVerifier` interface are in the [contracts repository](https://github.com/bank-of-an-agent/contracts).

| Function                                                                | Use                                                                                                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify(claims, proof, minAnonymitySet, maxRootAge)`                    | A view for anyone: checks the root and the proof, returns `false` on any failure. Replay protection is yours                                                      |
| `verifyAndConsume(context, claims, proof, minAnonymitySet, maxRootAge)` | For contracts that admit agents: requires `claims.scope == scopeOf(msg.sender, context)`, uses up `(scope, nonce)`, emits `ClaimsAccepted`, returns the nullifier |
| `scopeOf(consumer, context)`                                            | The on-chain scope: `keccak256(abi.encode("agentbank.proofs.scope.v1", block.chainid, consumer, context)) mod r`                                                  |

`maxRootAge` of `0` skips the age check. `Claims` is `{ root, nullifier, scope, nonce, mins[13], maxs[13] }` and `Groth16Proof` is `{ a, b, c }` in snarkjs's calldata order. Build both from **your own** request, never from a statement the agent sends: `toClaimsVerifierArgs(request, presentation)` from `@agentbank/sdk/proof-server` (or `/prover`) returns `{ claims, proof }` typed for viem, with the scope, nonce and bounds from the request and only the root, nullifier and proof from the presentation. In Python, `to_claims_verifier_args(request, presentation)` returns the same, with `as_tuple()` for web3.py.

**Scopes for contracts.** `verify` accepts a proof for any scope. `verifyAndConsume` accepts only proofs for `scopeOf(msg.sender, context)`, so a contract that admits agents asks for its on-chain scope id, `eip155:<chainId>:<consumer>:<context>`: `onchainScopeId(chainId, consumer, context)` (`onchain_scope_id` in Python) builds it, and the SDKs map it to exactly `scopeOf(consumer, context)` on that chain. Agents prove such requests explicitly with `agent.proofs.prove(request)` (`bank.proofs.prove` in Python); the automatic HTTP flow never answers them, so a web server cannot relay a contract's challenge.

```ts
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  CLAIMS_VERIFIER_ABI,
  createProofRequest,
  onchainScopeId,
  toClaimsVerifierArgs,
  verifiedCompany,
} from "@agentbank/sdk/proof-server";

// consumer: your contract, which calls verifyAndConsume with `context` (32 bytes of its choosing);
// verifier: `verifier` in GET /v1/proofs/circuit.
const request = createProofRequest({
  scope: onchainScopeId(baseSepolia.id, consumer, context),
  require: [verifiedCompany()],
});
const presentation = await agent.proofs.prove(request); // the agent, with its proof secret
const { claims, proof } = toClaimsVerifierArgs(request, presentation);

const client = createPublicClient({ chain: baseSepolia, transport: http() });
const ok = await client.readContract({
  address: verifier,
  abi: CLAIMS_VERIFIER_ABI,
  functionName: "verify",
  args: [claims, proof, 16, 7_200n], // minAnonymitySet, maxRootAge (seconds)
});
// Admission: pass `claims` and `proof` to your contract, which calls
// verifier.verifyAndConsume(context, claims, proof, 16, 2 hours) and gets the nullifier back.
```

- **Check the bounds yourself.** `verifyAndConsume` checks the scope and the nonce, but `mins` and `maxs` come from the caller: a consuming contract must require that they are its own requirements.
- **Bound the gas for untrusted proofs.** A malformed proof (a point off the curve) makes the BN254 pairing precompile consume all the gas forwarded to it before `verify` returns `false`. A contract that relays untrusted proofs should cap it, for example `verifier.verify{gas: 1_000_000}(claims, proof, 16, 2 hours)`.
- **One nonce, one admission.** `verifyAndConsume` uses up `(scope, nonce)`; `createProofRequest` draws a random nonce per request, and a reservation for the contract is tagged with its scope like any other (`reservedFor` defaults to the request's scope).

## What you trust

- **Agent Bank as the attester.** A proof shows that Agent Bank attested the facts at a snapshot, not that they are true on-chain. A compromised attester key could attest false facts or pad the tree. The attester key can move no funds, every root is public and permanent on Base, and the registry's owner can rotate the attester and revoke roots. `chainRootResolver` removes the API from the root check, not the attester.
- **The trusted setup.** Groth16 needs a one-time setup, and whoever learned its secret randomness could forge proofs. The current keys come from a **single-party, testnet-only** ceremony; mainnet needs a public multi-party ceremony and an audit of the circuit and contracts.
- **Snapshots, not live state.** Facts are as of the root's snapshot. A reservation is the commitment: the agent cannot spend those funds through Agent Bank until it ends, but the owner can still withdraw on-chain or release it early, which revokes the roots containing it (later proofs fail with `root_revoked`; a proof you already accepted stays accepted).
- **A pseudonym, not a person.** The nullifier is per agent and per secret: one principal can run many agents, and an agent that enrolls a new secret gets a new pseudonym. Do not treat it as one per customer.
- **The crowd is the tree.** A small deployment has small trees; `minAnonymitySet` is your floor.

The full design is in [`docs/private-proofs.md`](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/private-proofs.md).
