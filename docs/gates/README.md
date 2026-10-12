# Phase gates

The design splits v1 into six phases; each ends at a gate the next phase depends on. A gate
report states what was built, how it was tested, open issues, decisions taken, and a demo
script a human can run. Gates that need people (counsel, auditors, an on-call rotation,
vendor accounts) are marked **needs human sign-off**: code can be complete while the gate is
still open.

| Phase                          | Gate criterion (from the design)                                                                                            | Report                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0 · Foundations                | Spike result documented and a decision recorded                                                                             | [phase-0.md](phase-0.md) |
| 1 · Ledger and accounts        | 10,000 simulated deposits and transfers reconcile with zero drift, including injected reorgs                                | [phase-1.md](phase-1.md) |
| 2 · Keys, policy and co-signer | A red-team agent with a prompt-injection harness cannot exceed any limit or pay a non-allowlisted address in 1,000 attempts | [phase-2.md](phase-2.md) |
| 3 · Payments and x402          | End-to-end suite on Base Sepolia passes; external audit firms booked                                                        | [phase-3.md](phase-3.md) |
| 4 · Escrow and streams         | No open high or critical audit findings                                                                                     | [phase-4.md](phase-4.md) |
| 5 · Developer surface and beta | Legal sign-off, audits closed, exit tool verified, on-call rotation staffed                                                 | [phase-5.md](phase-5.md) |
