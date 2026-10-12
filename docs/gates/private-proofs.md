# Extension gate report · Private proofs

**Added after v1 planning** at the principal's request: three products on one zero-knowledge
proof. Agents prove a verified backer and their limits (agent credentials), their track record
(private reputation), and their funds, including funds reserved for one verifier (proof of
funds), without revealing which agent they are.
**Design:** [`docs/private-proofs.md`](../private-proofs.md), ADR 0014 here, ADR 0003 in
`contracts`.

**Gate criterion** (set for this extension): every product proves end to end with real proofs on
the full stack; no proof is accepted for a false statement, an undisclosed attribute, a revoked
root, a replay or another verifier's challenge; and before mainnet, the circuit is audited and
the keys come from a public multi-party ceremony.
**Status: met on testnet; needs humans for mainnet** (circuit audit, public ceremony, counsel).
Evidence: [`evidence/private-proofs.md`](evidence/private-proofs.md).

## Built

| Deliverable                                                                                                                               | Where                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Claims circuit (Circom, Groth16 on BN254, 10,270 constraints), testnet ceremony, artifacts re-verified in CI                              | `contracts/circuits`                        |
| `AgentAttestationRegistry` (roots, validity, revocation) and `AgentClaimsVerifier` (on-chain checks, nonce-consuming entry point)         | `contracts/src`                             |
| `@agentbank/proofs`: schema, Poseidon tree, request builders, prover, verifier, HTTP proof gate, `agentbank-prove` CLI                    | `packages/proofs`                           |
| Thirteen `Proofs` API operations, migration `0006_proofs`, the `proofs-roots` and `proofs-reservations` jobs, attester key, freeze hooks  | `packages/core`, `apps/api`, `packages/db`  |
| Simulated and Base Sepolia registry support in `ChainGateway`                                                                             | `packages/chain`                            |
| SDKs: `agent.proofs`, automatic proof challenges in `fetchWithPayment`, `@agentbank/sdk/proof-server` gates; Python verification and gate | `packages/sdk-ts`, `sdk-python`             |
| MCP tools `prove_claims` and `reserve_funds_for_proof`; console "Private proofs" card; docs guides                                        | `packages/mcp`, `apps/console`, `apps/docs` |

## Tests and evidence

- **Circuit:** 64 tests with real proofs: completeness for each product, every attribute just
  outside each bound fails, the disclosure mask cannot be bypassed even trivially, wrong secrets,
  siblings and path bits fail, and tampering with any public signal fails verification.
- **Contracts:** 308 Foundry tests (unit, fuzz, invariant) at 100% coverage, including real
  fixture proofs through the generated verifier; Slither triaged.
- **Packages:** `@agentbank/proofs` at 99.8% statement coverage, with cross-language vectors that
  the Python SDK reproduces byte for byte (scopes, bounds, request hashes, gate nonces, a full
  gate-issued presentation and 14 tampered variants).
- **End to end** (`tests/e2e/test/private-proofs.test.ts`): 9 scenarios, PASS. There were 26
  real proofs and 23 accepted presentations. Every refusal reason appeared: `root_revoked`,
  `nonce_invalid`, `nonce_reused`, `anonymity_set_too_small`, `unsatisfiable`,
  `reservation_required`, `reservation_pending`, `undisclosed` and `agent_frozen`. 23 roots were
  built and 20 revoked on-chain after narrowing, freezes and early releases. Median proving time
  was 1.6 s; a gate check takes about 100 ms including the root lookup.

## Demo script

```bash
pnpm --filter @agentbank/e2e sandbox      # demo seller: /premium (credentials + x402), /bid (reserved funds), /jobs (reputation)
pnpm --filter @agentbank/e2e gate:proofs  # rewrites evidence/private-proofs.md
# In the contracts repository:
cd circuits && npm ci && npm test         # circuit soundness suite
forge test --match-path 'test/unit/Agent*Verifier*'
```

## Decisions taken

- One circuit for all three products; facts as 64-bit ranges, coarsened to whole dollars and
  whole days to limit probing (ADR 0014).
- Groth16 for cheap on-chain verification (about 410,000 gas), with a testnet-only single-party
  ceremony committed with its transcript; mainnet needs a public ceremony (ADR 0003).
- The owner controls disclosure by class through a mask the circuit enforces; widening is
  owner-signed, narrowing is immediate and revokes roots.
- Proof of funds for a counterparty is a ledger hold bound to that verifier's scope tag, so the
  same funds cannot be pledged twice; only the owner can release it early.
- Every tree ends with a public salt leaf so an unchanged set of facts still yields a new root.

## What a human must do

1. Book a specialist audit of the circuit and the two contracts (add to the Phase 4 audits).
2. Run a public multi-party trusted setup (public Powers of Tau, independent phase-2
   contributors) and redeploy the verifier before any mainnet use.
3. Counsel: consent language for attesting customer facts to third parties, and how private
   proofs sit with AML expectations. They reveal less to counterparties, never less to Agent Bank.
4. Provision the attester key in KMS and fund it with a little Base ETH for root transactions.
