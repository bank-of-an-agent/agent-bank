# Phase gates

Agent Bank v1 is built in six phases over 20 weeks, from an empty repository to a capped mainnet beta. Each phase ends at a **gate** that the next phase depends on, and the implementing agent stops at every gate for human sign-off. A gate report states what was built, how it was tested, open issues, decisions taken, and a demo script a human can run.

Gates that need people (counsel, auditors, an on-call rotation, vendor accounts) are marked **needs human sign-off**: the code can be complete while the gate is still open. The reports live in [`docs/gates/`](https://github.com/bank-of-an-agent/agent-bank/tree/main/docs/gates).

| Phase                          | Weeks | Scope                                                                                                                             | Gate criterion                                                                                                              |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0 · Foundations                | 1–2   | Monorepo, CI, threat model, invariants as failing tests; the x402 + Safe (ERC-1271) spike; counsel engaged                        | The spike result is documented and a decision recorded                                                                      |
| 1 · Ledger and accounts        | 3–6   | The ledger (holds, post, void, idempotency), org/agent/account APIs, counterfactual Safes, the indexer and reconciliation         | 10,000 simulated deposits and transfers reconcile with zero drift, including injected reorgs                                |
| 2 · Keys, policy and co-signer | 7–10  | Session keys and on-chain scope, the policy engine and the KMS co-signer (failing closed), mandates, the console, KYB             | A red-team agent with a prompt-injection harness cannot exceed any limit or pay a non-allowlisted address in 1,000 attempts |
| 3 · Payments and x402          | 11–14 | Transfers, payment requests and webhooks; the x402 client and facilitator; the paymaster; wallet screening                        | The end-to-end suite passes on Base Sepolia; external audit firms are booked (**needs human sign-off**)                     |
| 4 · Escrow and streams         | 15–17 | Escrow and stream contracts with fuzz and invariant tests; ledger integration; two independent audits                             | No open high or critical audit findings (**needs human sign-off**)                                                          |
| 5 · Developer surface and beta | 18–20 | The Python SDK, the MCP server, these docs and quickstarts; statements; the exit tool; a closed beta capped at $1,000 per account | Legal sign-off, audits closed, exit tool verified, on-call rotation staffed (**needs human sign-off**)                      |

The security-heavy phases (2 and 4) gate everything after them: nothing reaches mainnet until a red team and two audits have failed to break the limits. Until the Phase 5 gate the code refuses mainnet chain ids everywhere.

Savings and revenue work slots into the same phases: goal vaults and auto-save in phase 2; the fee engine and subscriptions in phase 3; the `TimeLockVault` contract and the treasury sweep executor (shipped only after a counsel memo) in phase 4; the revenue dashboard in phase 5.
