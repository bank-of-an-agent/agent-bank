# @agentbank/proofs

Private proofs for Agent Bank (schema `agentbank.claims.v1`, design in
[`docs/private-proofs.md`](../../docs/private-proofs.md), ADR 0014). An agent proves a statement about
itself ("a verified company backs me, I can pay $5 a call, $500 is reserved for you") without revealing
which agent it is; the verifier learns only that the statement holds.

| Entry point                   | Runs in        | What it has                                                                                                |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `@agentbank/proofs`           | Node, browsers | Schema constants, scopes, the Poseidon tree, request builders, the verifier, root resolvers, the HTTP gate |
| `@agentbank/proofs/onchain`   | Node, browsers | `CLAIMS_VERIFIER_ABI`, `toClaimsVerifierArgs` (`AgentClaimsVerifier` calldata)                             |
| `@agentbank/proofs/prover`    | Node           | `prove`, `prepareProof`, `toClaimsVerifierArgs`, `toSolidityProof`, `toSolidityClaims`                     |
| `@agentbank/proofs/artifacts` | Node           | Paths to the bundled circuit files, manifest loading and SHA-256 checks                                    |
| `agentbank-prove`             | Node (CLI)     | The prover as a process, for SDKs without a WebAssembly witness generator (Python)                         |

Testnet only (Base Sepolia). The proving key comes from a single-party, testnet-only setup.

## Verify (a seller or tool provider)

```ts
import {
  apiRootResolver,
  canPayPerTx,
  createProofGate,
  reservedFor,
  verifiedCompany,
} from "@agentbank/proofs";

const gate = createProofGate({
  scope: "api.seller.example", // your host name
  key: process.env.PROOF_GATE_KEY!, // at least 32 bytes; nonces are HMACs of the request, no state
  require: [verifiedCompany(), canPayPerTx("5.00"), reservedFor("500.00", { forSeconds: 3600 })],
  rootResolver: apiRootResolver("https://api.agentbank.example"), // or chainRootResolver(publicClient, registry)
});

const result = await gate.check(request.headers); // reads AGENT-PROOF
if (result.kind === "proof-required")
  return reply(result.response.status, result.response.headers, result.response.body);
// result.nullifier is this agent's stable pseudonym for your scope; add result.headers to the 2xx response.
```

`verifyPresentation({ request, presentation, rootInfo | rootResolver, now })` is the gate-free check; it
rebuilds the public signals from your own request and returns `{ valid, reason, nullifier, root }` with
the reasons of the design doc (`malformed`, `request_expired`, `nonce_invalid`, `nonce_reused`,
`request_hash_mismatch`, `unknown_root`, `root_revoked`, `root_expired`, `root_too_old`,
`anonymity_set_too_small`, `invalid_proof`).

## On-chain consumers

A contract that admits agents with `AgentClaimsVerifier.verifyAndConsume(context, …)` asks for the
scope id `onchainScopeId(chainId, consumer, context)`, i.e. `eip155:<chainId>:<consumer>:<context>`;
`scopeField` maps exactly that form to `onchainScope(chainId, consumer, context)`, which equals the
contract's `scopeOf(consumer, context)`. `toClaimsVerifierArgs(request, presentation)` returns the
`claims` and `proof` arguments. `RUN_ANVIL_TESTS=1 pnpm --filter @agentbank/proofs test` deploys the
contracts repository's compiled verifier on a fresh Anvil and checks both with `verify` and
`verifyAndConsume` (`CONTRACTS_DIR`, `ANVIL_CMD`, `FORGE_CMD` override the defaults).

## Prove (an agent)

```ts
import { generateProofSecret, identityCommitment, toBytes32 } from "@agentbank/proofs";
import { prove } from "@agentbank/proofs/prover";

const secret = generateProofSecret(); // keep it secret; enroll only toBytes32(identityCommitment(secret))
const presentation = await prove({ secret, witness, request }); // witness: GET /v1/accounts/{id}/proofs/witness
```

`prove` refuses before proving (a `ProofRefusedError` with `reason` `unsatisfiable`, `undisclosed`,
`witness_mismatch` or `chain_mismatch`, plus the failing `attributes` and `undisclosedClasses`) when the
witness cannot satisfy the request.

## CLI: `agentbank-prove`

Run it from a checkout, without a build, from any directory:

```sh
node /path/to/agent-bank/packages/proofs/bin/agentbank-prove.mjs [prove|identity]
# or: pnpm --silent --dir /path/to/agent-bank --filter @agentbank/proofs prove [prove|identity]
```

The Python SDK takes the command from `AGENTBANK_PROVER`:

```sh
export AGENTBANK_PROVER="node /path/to/agent-bank/packages/proofs/bin/agentbank-prove.mjs"
```

| Mode              | stdin                              | stdout                                                          |
| ----------------- | ---------------------------------- | --------------------------------------------------------------- |
| `prove` (default) | `{"secret", "witness", "request"}` | the presentation (`agentbank.proof.v1`) as one JSON line        |
| `identity`        | `{"secret": "0x…"}`, or nothing    | `{"secret", "identity_commitment"}`; generates a secret if none |

`identity_commitment` is `Poseidon(secret)` as 32-byte hex: what `PUT /v1/accounts/{id}/proofs/identity`
enrolls. Exit codes: `0` ok, `1` internal error, `2` invalid input, `3` refused. Errors are one JSON line
on stderr: `{"error": "invalid_input" | "refused" | "internal", "message", …}`; refusals add `reason`,
`attributes` and `undisclosed_classes`. Proving takes about two seconds.

## Circuit artifacts

`artifacts/` holds `agent_claims.wasm`, `agent_claims.zkey`, `verification_key.json` and
`manifest.json`, produced and checked in the contracts repository (`contracts/circuits`: Circom 2.2.3,
circomlib 2.0.5, snarkjs 0.7.6, 10,270 constraints). Copy new ones with

```sh
pnpm --filter @agentbank/proofs sync-circuits   # CIRCUITS_ARTIFACTS=… to point elsewhere
```

which copies nothing unless every file matches the SHA-256 in the manifest. Do not edit or reformat
these files.

## Cross-language vectors

`test/vectors/proofs.json` (scopes and on-chain scope ids, bounds, request hashes, gate nonces, Poseidon
leaves, a tree, a gate-issued request with a real proof plus tampered variants, and a proof for an
on-chain scope id with its `AgentClaimsVerifier` calldata) is what the Python SDK checks against.
Regenerate with `pnpm --filter @agentbank/proofs vectors`; the tests fail if a deterministic part
changes.
