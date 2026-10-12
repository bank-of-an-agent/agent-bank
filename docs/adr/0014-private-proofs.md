# 0014: Private proofs via an attested-facts tree anchored on Base

- Status: Accepted (Base Sepolia)
- Date: 2026-10-12
- Design: [`docs/private-proofs.md`](../private-proofs.md)

## Context

Counterparties want to know facts about an agent (a verified business backs it, its spending is
capped, it can pay, it has a track record) before serving, hiring or negotiating with it. Agent
accounts are public on Base, so identifying the agent also exposes its balance and payment
history. We want agents to prove such facts without identifying themselves, and we will not
build a chain of our own.

Options considered:

1. **Signed credentials (JWT/SD-JWT) issued per agent.** Simple, but every presentation carries
   the same signature, so verifiers can link an agent across sites, and ranges ("balance ≥ X")
   need the value disclosed.
2. **BBS+ selective disclosure.** Unlinkable, but range proofs and JS/Python tooling are immature.
3. **Zero-knowledge proofs over a Merkle tree of attested facts, with the root anchored
   on-chain** (Semaphore-style membership plus range checks).
4. **Trustless on-chain proofs** (storage proofs of the hidden account's USDC balance). Removes
   the attester for balances only, at far higher proving cost; KYB status and reputation are not
   on-chain facts at all.

## Decision

Option 3. Agent Bank attests 13 facts per enrolled agent into a depth-20 Poseidon tree, publishes
each root to `AgentAttestationRegistry` on Base, and agents prove range statements about their own
leaf with a Groth16 circuit (ADR 0003 in `contracts`). One circuit serves agent credentials,
private reputation and proof of funds.

- The agent holds the only secret; Agent Bank sees the identity commitment, never the secret,
  so it cannot impersonate the agent or link nullifiers back to it.
- The owner controls disclosure per class through a mask the circuit enforces. Widening needs
  an owner signature; narrowing is immediate and revokes older roots.
- Proof of funds for a specific verifier uses a ledger hold bound to that verifier's scope tag,
  which prevents pledging the same funds to several verifiers.
- Base hosts the registry and the optional on-chain verifier (about 410,000 gas); off-chain
  verification needs no chain access beyond reading the registry.
- A dedicated attester key publishes roots. It can move no funds, which keeps the
  non-custodial rule intact.

## Consequences

- Verifiers trust Agent Bank as attester and the trusted setup. Both are stated in the design and
  the threat model; mainnet needs a multi-party ceremony and a circuit audit.
- Payments remain linkable on-chain; proofs protect facts, not the payment rail.
- New moving parts: the `@agentbank/proofs` package (tree, prover, verifier, gate), the
  `proofs-roots` job, migration `0006_proofs`, two contracts, and the circuit artifacts synced from
  `contracts` like ABIs.
- Python proves by shelling out to the TypeScript prover; it verifies natively.
