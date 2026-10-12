# Prove facts as an agent

An agent can prove facts Agent Bank attests about it, such as "a verified company backs me", "I can pay $5 a call" or "$500 is reserved for you", to a seller or another agent **without revealing which agent it is**. The verifier asks with an HTTP `401`, the SDK proves locally from the agent's secret and retries, and the verifier learns only that the statement holds. This page is the how-to for the agent and its owner. [Private proofs](/concepts/private-proofs) explains the model, the 13 attested facts and what stays private; sellers read [Require proofs as a seller](/guides/proofs-verifier).

::: warning Testnet only
Proofs work on Base Sepolia only. The proving keys come from a single-party, testnet-only trusted setup and the circuit has not been audited.
:::

## The flow

```text
owner ──configure(enabled, disclose)──▶ Agent Bank      (owner signature when it widens disclosure)
agent ──enroll Poseidon(secret)───────▶ Agent Bank      (once per secret)
Agent Bank ──publishRoot(root)────────▶ AgentAttestationRegistry on Base   (every snapshot)

agent ──GET /report──────────────────▶ seller
      ◀─401 AGENT-PROOF-REQUIRED───────  (scope, nonce, constraints)
agent ──GET …/proofs/witness─────────▶ Agent Bank      (its leaf and Merkle path)
agent proves locally (about 1.5 s)
agent ──GET /report + AGENT-PROOF─────▶ seller ──is the root valid?──▶ registry
      ◀─200 + AGENT-PROOF-RESPONSE─────  (the agent's pseudonym there), or 402 if the resource is also paid
```

1. **The owner enables proofs** for the agent and chooses which classes of facts may be disclosed.
2. **The agent enrolls** a commitment to a secret it generated. Agent Bank never sees the secret.
3. **A root includes the agent.** Agent Bank rebuilds its tree of attested facts within about a minute of an enrollment, a settings change or a reservation, and at least hourly otherwise.
4. **The agent answers challenges.** `fetchWithPayment` (TypeScript), the `httpx` transports (Python) and the MCP server's `fetch_paid_resource` answer a `401` proof challenge automatically, then pay a `402` if the resource is also paid. For other channels, prove by hand.

## 1. Enable proofs (owner)

Disclosure is the owner's decision, not the agent's. Enabling proofs or adding a class needs the [owner's signature](/concepts/owner-operations#owner-authorizations) and applies from the next root. Disabling or removing a class needs only the API key and applies at once: Agent Bank publishes a new root and revokes every older one, so proofs from the wider disclosure stop verifying.

::: code-group

```ts [TypeScript]
import { PrincipalClient, signerFromPrivateKey } from "@agentbank/sdk";

const principal = new PrincipalClient({
  baseUrl,
  apiKey: process.env.AGENTBANK_API_KEY!,
  owner: signerFromPrivateKey(process.env.AGENTBANK_OWNER_KEY!), // testnet development only
});

// Signs `proofs.disclose` only when the change widens disclosure.
await principal.proofs.configure(agentId, {
  enabled: true,
  disclose: ["principal", "limits", "reservations"],
});
const settings = await principal.proofs.settings(agentId); // enabled, disclose, disclosure_mask
```

```python [Python]
from agentbank import AgentBank, SessionKey

owner = SessionKey.from_env("AGENTBANK_OWNER_KEY")  # testnet development only
with AgentBank() as bank:  # AGENTBANK_API_KEY from the environment
    # Signs `proofs.disclose` only when the change widens disclosure.
    bank.proofs.update_settings(
        agent_id,
        enabled=True,
        disclose=["principal", "limits", "reservations"],
        owner=owner,
    )
```

:::

Disclose only what the agent's counterparties ask for. A request that bounds a fact of an undisclosed class is refused (`undisclosed`) before anything is proved; the circuit enforces the same rule.

| Class          | Facts                                                                                        | Verifier requirements that need it                       |
| -------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `principal`    | `principal_verification`                                                                     | `verifiedPrincipal()`, `verifiedCompany()`               |
| `limits`       | `per_tx_limit`, `per_day_limit`                                                              | `canPayPerTx`, `canPayPerDay`, `spendingCappedAt`        |
| `balance`      | `balance`                                                                                    | `balanceAtLeast`                                         |
| `reservations` | `reserved_amount`, `reserved_until`, `reserved_for`                                          | `reservedFor`; also needed to create reservations at all |
| `account_age`  | `account_created_on`                                                                         | `accountOlderThan`                                       |
| `reputation`   | `payments_settled`, `volume_settled`, `escrows_completed`, `disputes_lost`, `counterparties` | `reputation({ … })`                                      |

Each change emits a `proof_settings.updated` [webhook](/guides/webhooks). The facts themselves are listed in [Private proofs](/concepts/private-proofs#the-facts).

## 2. Enroll the agent

The agent generates a **proof secret** and enrolls only its commitment, `Poseidon(secret)`. Treat the secret like a key: whoever holds it can prove as the agent. Enrolling the same secret again is harmless.

::: code-group

```ts [TypeScript]
import { AgentClient, generateProofSecret } from "@agentbank/sdk";
import { FileKeyStore } from "@agentbank/sdk/node";

const store = new FileKeyStore({ path: ".agentbank/agent.keystore.json" });
let proofSecret = await store.get("proof");
if (!proofSecret) {
  proofSecret = generateProofSecret();
  await store.set("proof", proofSecret); // the MCP server reads this entry too
}

const agent = new AgentClient({
  baseUrl,
  accountId,
  session: { id: sessionId, signer: sessionKey },
  spendKey, // optional: only to pay x402 challenges
  proofSecret,
});
await agent.proofs.enroll(); // sends Poseidon(secret), never the secret
```

```python [Python]
from agentbank import AgentBank, SessionKey

# AGENTBANK_PROOF_SECRET: generated once with agentbank.generate_proof_secret(), kept secret
# AGENTBANK_PROVER="node /path/to/agent-bank/packages/proofs/bin/agentbank-prove.mjs"
with AgentBank(session_key=SessionKey.load(".agentbank/session.json")) as agent:
    agent.proofs.enroll()  # the prover computes Poseidon(secret); only that is sent
```

:::

Python proves through the `agentbank-prove` CLI of `@agentbank/proofs` (proving needs the circuit's WebAssembly witness generator), so it needs Node.js and a checkout of the monorepo; the secret only ever goes to the prover's stdin. The TypeScript SDK proves in-process in Node with the circuit files it ships; elsewhere (a browser), pass your own `proofs.prover`.

After enrolling, wait for the next root (usually under a minute). Until a published root includes the agent, fetching a witness fails with `invalid_state` and reason `proof_not_ready`. `GET /v1/proofs/roots` (`agent.proofs.listRoots()`, `bank.proofs.roots()`) lists the roots.

**Rotating the secret.** Enrolling a new secret replaces the commitment; Agent Bank publishes a new root and revokes the older ones. The agent's pseudonym changes at every verifier, because it is derived from the secret. A lost secret is recovered the same way: generate and enroll a new one.

## 3. Answer challenges automatically

### TypeScript

With a `proofSecret`, `fetch`, `fetchWithPayment` and `wrapFetch` answer a proof challenge before paying an x402 challenge, in one call. The proof is kept for the paid retry, so a resource behind both a proof gate and a paywall costs one proof and one payment.

```ts
const { response, proofPresented, nullifier, proofRequest, paid, amount } = await agent.fetchWithPayment(
  "https://api.seller.example/v1/report",
);
```

| Field            | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `proofPresented` | Whether a proof was sent with the final request                              |
| `nullifier`      | The agent's pseudonym at that verifier, from its `AGENT-PROOF-RESPONSE`      |
| `proofRequest`   | The verifier's request that was proved: its scope and the constraints it set |
| `paid`, `amount` | The x402 details, as in [x402: pay for APIs](/guides/x402-buyer#typescript)  |

Before proving, the SDK checks that the challenge's scope is the host name of the URL that answered (see [acceptScope](#privacy)), applies the probing guard, picks a matching reservation when the request asks for reserved funds, fetches the witness and checks locally that the attested facts satisfy every bound. A request it cannot satisfy is refused in milliseconds, without proving. Without a `proofSecret`, the `401` is returned unchanged.

Options go in `proofs`:

```ts
const agent = new AgentClient({
  baseUrl,
  accountId,
  session: { id: sessionId, signer: sessionKey },
  proofSecret,
  proofs: {
    maxPresentationsPerScopePerHour: 10, // probing guard (default 30)
    acceptScope: (scope, url) => scope === url.hostname, // the default
  },
});
```

| Option                            | Default                     | Meaning                                                                  |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `maxPresentationsPerScopePerHour` | `30`                        | At most this many proofs to one verifier scope per hour; `0` refuses all |
| `acceptScope`                     | scope equals the URL's host | Which challenges the automatic flow answers                              |
| `autoReserve`                     | `false`                     | Only `false` is accepted: the SDK never reserves funds on its own        |
| `prover`, `artifacts`             | the bundled Node prover     | Prove some other way, or with other circuit files                        |

`fetchWithProof(fetch, url, init, { prover: agent.proofs })` is the standalone form, without x402. Short-lived scripts call `await releaseProofResources()` before exiting, so snarkjs's worker threads do not keep the process alive.

### Python

`agent.x402.client()`, `agent.x402.transport()` and `agent.x402.fetch()` answer proof challenges before paying whenever a proof secret is configured (`AGENTBANK_PROOF_SECRET`, or `proof_secret=`); `proofs=False` turns it off. `agent.proofs.client()` answers proof challenges without paying anything.

```python
from agentbank import x402_receipt
from agentbank.proofs import proof_receipt

with agent.x402.client(max_amount="0.10") as http:
    response = http.get("https://api.seller.example/v1/report")
    proved = proof_receipt(response)  # request, presentation and nullifier, or None
    paid = x402_receipt(response)  # what was paid, or None
```

The Python transport answers only a challenge whose scope is the request's host; `agent.proofs.transport(allowed_scopes={…})` lists others (pass it as `transport=` to `agent.x402.client()`). The Python SDK has no probing guard: count the proofs you give each verifier yourself.

## 4. Prove by hand

For a challenge that does not arrive as an HTTP `401` (a bid API, an agent-to-agent message), or to look at a request before answering it, prove it directly. Check `request.scope` before you send the answer: it names the verifier the proof is for, and the automatic scope check does not run here.

::: code-group

```ts [TypeScript]
// `challenge`: the verifier's request object, or the base64 AGENT-PROOF-REQUIRED header value.
const { request, presentation, headerName, header } = await agent.proofs.answer(challenge);
console.log(request.scope, request.constraints); // who you are proving to, and what
await fetch(url, { headers: { [headerName]: header } }); // AGENT-PROOF

// Or only the presentation, from a chosen reservation:
const proof = await agent.proofs.prove(challenge, { reservationId: "prv_01JABCDEFGHJKMNPQRSTVWXYZ0" });
```

```python [Python]
from agentbank.proofs import decode_proof_required, encode_proof

request = decode_proof_required(challenge_header)  # or parse_proof_request(request_json)
print(request.scope, request.constraints)  # who you are proving to, and what
presentation = agent.proofs.prove(request)  # witness from Agent Bank, proof from AGENTBANK_PROVER
header = encode_proof(request, presentation)  # send as AGENT-PROOF
```

:::

`prove` and `answer` in TypeScript apply the same probing guard and local checks as the automatic flow. From another language, run the prover as a process: `agentbank-prove` reads `{"secret", "witness", "request"}` on stdin and writes the presentation on stdout, with the witness from `GET /v1/accounts/{id}/proofs/witness` ([`@agentbank/proofs`](https://github.com/bank-of-an-agent/agent-bank/tree/main/packages/proofs#cli-agentbank-prove)).

## 5. Proof of funds: reservations

A balance proof says what the agent held at the last snapshot; it could spend the money a minute later. A verifier that wants a commitment asks for funds **reserved for it** (`reserved_amount`, `reserved_until`, `reserved_for` in the request). The agent then reserves, and the SDK proves from that reservation automatically.

::: code-group

```ts [TypeScript]
const reservation = await agent.proofs.reserve({
  amount: "500.00",
  scope: "bids.example", // the verifier's scope, as in its proof requests
  forSeconds: 4 * 3600, // or expiresAt; more than 60 seconds, at most 7 days
});
// reservation.status: "pending" until the next root includes it, then "active"
const { data: active } = await agent.proofs.reservations({ status: "active" });
```

```python [Python]
from datetime import datetime, timedelta, timezone

reservation = agent.proofs.reserve(
    "500.00",
    scope="bids.example",  # the verifier's scope, as in its proof requests
    expires_at=datetime.now(timezone.utc) + timedelta(hours=4),  # at most 7 days ahead
)
```

:::

- Agent Bank moves the amount from `operating` to `reserved`. The agent cannot spend it through Agent Bank, and **cannot cancel the reservation**: it ends at `expires_at`, when the funds return to `operating`.
- The reservation is provable from the next root, and only to that verifier: the proof compares the reservation's tag with the verifier's own scope.
- The owner can release it early with an owner signature (`principal.proofs.releaseReservation(id)`, `bank.proofs.release_reservation(id, owner=owner)`), which revokes every root that contained it.
- Reserving needs the `reservations` class disclosed (`invalid_state`, reason `reservations_not_disclosed`) and enough available funds (`insufficient_funds`).
- Reserving does not pay the verifier. Pay it afterwards with a normal payment, x402 or [escrow](/concepts/escrow-and-streams).
- Webhooks: `proof_reservation.created`, `proof_reservation.released`, `proof_reservation.expired`.

The SDK never reserves funds on its own. When a request needs a reservation that does not exist, it refuses with `reservation_required` and says what would satisfy it:

```ts
import { ProofError } from "@agentbank/sdk";

try {
  await agent.fetchWithPayment("https://bids.example/v1/jobs/42/bid", {
    method: "POST",
    body: JSON.stringify(bid),
  });
} catch (error) {
  if (!(error instanceof ProofError) || error.reason !== "reservation_required") throw error;
  const { amount, scope, scopeTag, until } = error.reservationNeeded!; // until: unix seconds, 0 if unbounded
  // Decide whether to commit the funds, then reserve with a margin: a retry gets a fresh
  // challenge, and a verifier asking for funds held "for an hour" counts from that challenge.
  await agent.proofs.reserve({
    amount,
    ...(scope ? { scope } : { scopeTag: scopeTag! }),
    expiresAt: new Date(Math.max(until * 1000, Date.now()) + 2 * 3_600_000),
  });
  // Retry after the next root; until then the SDK refuses with reservation_pending.
}
```

In Python the `ProofRefusedError` message names the amount, the scope tag and the time; `bounds(request)` from `agentbank.proofs` gives the same values.

## When a proof is refused

The SDKs refuse before proving whenever the agent cannot or should not answer, and report a verifier's refusal the same way. `ProofError.reason` (TypeScript) and the Python exception's `.reason` say why; refusals carry `attributes` and `undisclosedClasses` (`undisclosed_classes` in Python).

| Reason                                                      | Meaning                                                                                 | What to do                                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservation_required`                                      | The request asks for funds reserved for this verifier and no active reservation matches | Decide whether to commit funds; `proofs.reserve(...)` with `reservationNeeded`, then retry after the next root                                 |
| `reservation_pending`                                       | A matching reservation exists, but no published root includes it yet                    | Wait for the next root (usually under a minute) and retry                                                                                      |
| `undisclosed`                                               | The request bounds facts of a class the owner did not disclose (`undisclosedClasses`)   | Decline, or ask the owner to disclose that class; the agent cannot widen disclosure                                                            |
| `unsatisfiable`                                             | The attested facts lie outside the requested bounds (`attributes`)                      | The agent does not qualify. Facts change only at the next snapshot (balances in whole dollars), and limits only by the owner's policy          |
| `rate_limited`                                              | The probing guard: this verifier already got `maxPresentationsPerScopePerHour` proofs   | Wait `retryAfterMs`. A verifier asking that often, with varying thresholds, may be narrowing down the values; do not just raise the limit      |
| `scope_mismatch` (TS), `scope_not_allowed` (Python)         | A server asked for a proof for another scope than its own host name                     | Do not prove: it may be relaying another verifier's challenge. Allow a scope explicitly (`acceptScope`, `allowed_scopes`) only if you trust it |
| `request_expired`                                           | The challenge expired before it was proved                                              | Request the resource again for a fresh challenge                                                                                               |
| `witness_mismatch`                                          | The secret does not match the enrolled commitment, or the witness is stale              | Check the configured secret; re-enroll after rotating it                                                                                       |
| `chain_mismatch`                                            | The request names another chain or registry than the agent's                            | The verifier uses another deployment; decline                                                                                                  |
| `proof_rejected`                                            | The verifier answered a fresh proof with another challenge                              | Read `verifierReason` (for example `root_too_old`); see the [verifier's reasons](/guides/proofs-verifier#failure-reasons)                      |
| `proof_secret_missing` (TS), `secret_missing` (Python)      | No proof secret is configured                                                           | Pass `proofSecret`, or set `AGENTBANK_PROOF_SECRET`                                                                                            |
| `prover_unavailable` (TS), `prover_not_configured` (Python) | The prover cannot run                                                                   | TypeScript: prove in Node or pass `proofs.prover`. Python: set `AGENTBANK_PROVER`                                                              |
| `invalid_request`                                           | The challenge is not a valid proof request                                              | The verifier is misconfigured; decline                                                                                                         |

Agent Bank can also refuse to serve the witness. These arrive as ordinary [API errors](/guides/idempotency-and-errors#error-codes):

| Error                                 | Meaning                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `invalid_state`, `proofs_disabled`    | The owner has not enabled proofs for this agent                         |
| `invalid_state`, `proof_not_ready`    | No published root includes the agent's leaf yet; wait for the next root |
| `not_found`, `not_enrolled`           | The agent has not enrolled a commitment                                 |
| `invalid_state`, `reservation_closed` | The reservation named for the proof was released or expired             |
| `agent_frozen`, `org_frozen`          | Frozen agents leave the tree and get no witnesses                       |
| `feature_gated`                       | Private proofs are off in this deployment (`FEATURE_PRIVATE_PROOFS`)    |

## With the MCP server

The [MCP server](/guides/mcp-server) proves for the model once it has the agent's proof secret, from `AGENTBANK_PROOF_SECRET` or the key file's `proof` entry. Enrollment is not a tool: enroll once with the SDK, using the same secret.

| Tool                      | Input                                                                               | Returns                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `fetch_paid_resource`     | `url`, …                                                                            | Also answers a proof challenge for the URL's own host; adds `proof_presented` and `nullifier`  |
| `prove_claims`            | `request` (the object) or `challenge` (the header value); optional `reservation_id` | `header_name`, `header_value`, `nullifier`, `root`, `expires_at`, `constrained`; sends nothing |
| `reserve_funds_for_proof` | `amount`, `scope`, `expires_in_seconds` (120 to 604800), optional `idempotency_key` | `reservation_id`, `status`, `amount`, `scope_tag`, `expires_at`                                |

A refusal comes back as a tool error with the `reason` and, when they apply, `undisclosed_classes`, `reservation_needed` (`amount`, `scope`, `scope_tag`, `until`), `verifier_reason` and `retry_after_seconds`, so the model can explain it or reserve. `reserve_funds_for_proof` is marked destructive: it holds funds that cannot be released before they expire, so leave it on "ask" in hosts that support it.

## Environment variables

| Variable                 | Read by                | Meaning                                                                                                     |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AGENTBANK_PROOF_SECRET` | Python SDK, MCP server | The proof secret, `0x` and 64 hex digits; never logged                                                      |
| `AGENTBANK_PROVER`       | Python SDK             | The `agentbank-prove` command line, e.g. `node /path/to/agent-bank/packages/proofs/bin/agentbank-prove.mjs` |
| `AGENTBANK_KEYSTORE`     | MCP server             | A 0600 key file; its `proof:<acct_id>` (or `proof`) entry holds the secret                                  |

The TypeScript SDK reads no environment variable: pass `proofSecret` to `AgentClient`.

## Privacy

- **What the verifier learns.** That every bound in its request holds, a pseudonym (the nullifier) that is the same every time the agent proves to that verifier and unlinkable across verifiers, and which root the proof used (so roughly when the facts were read). It does not learn which agent, account, organization or address it is, nor the values. See [What stays private](/concepts/private-proofs#what-stays-private).
- **Each answer still reveals something.** "Can pay at least $5" is true information. Many requests with different thresholds would narrow a value down, which is what the probing guard (30 proofs per verifier per hour by default) limits. Prove only to verifiers you intend to deal with.
- **Why `acceptScope` defaults to the URL's host.** A proof is bound to the verifier's scope and nonce, not to the connection it travels over. If `evil.example` received a challenge from `bank.example`, passed it to your agent as its own and got an answer, it could present that proof to `bank.example` as your agent: under your pseudonym there, with funds you reserved for `bank.example`. Answering only challenges whose scope is the host that sent them closes that relay. Widen it only for scopes you trust, for example a seller whose API runs on `api.seller.example` with scope `seller.example`.
- **Payments are not private.** If the agent then pays the verifier with x402, the payment comes from its spend key, which is linked on-chain to its account. A seller that gates and charges the same resource sees both. Proofs are most private for admission, bids and negotiation before (or without) a payment.
- **Agent Bank** knows the facts it attested, which verifier tag each reservation is for, and when the agent fetched a witness. It never sees the secret or the pseudonyms.
