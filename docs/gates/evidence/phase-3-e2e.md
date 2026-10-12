# Phase 3 evidence: end-to-end suite (simulated chain)

The full stack runs in one process on random ports over real HTTP: one `SimulatedChain` shared by
the API (`apps/api`, PGlite or PostgreSQL), the in-process co-signer (`apps/cosigner`, its own
database), the reconciler, the real indexer loop (`apps/indexer`, pushing over HMAC HTTP), the
x402 facilitator (`apps/facilitator`) and a demo seller behind the SDK's paywall. Clients are the
real TypeScript SDK and the MCP server. After every scenario the suite asserts the global
invariants: `ledger.verifyInvariants()` clean, `reconciler.verify()` clean, the on-chain USDC
balance of every watched address equal to the ledger's expected balance, and `sys:suspense` at
zero.

Reproduce with `pnpm --filter @agentbank/e2e test` (CI runs it on PostgreSQL 16).

| Test file                | Scenarios                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarios.test.ts`      | Onboarding (org, agent, account, spend key + permit, owner-signed policy, session, setup operation; permit executed on-chain); faucet deposit with a signed `deposit.received` webhook; external and agent-to-agent payments (pocket balances, 0.20% fee, ledger entries, webhooks); monthly statement as JSON and CSV; payment requests marked paid |
| `controls.test.ts`       | Approvals (approve, deny, 15-minute expiry); policy loosening needs the owner and waits an hour while tightening applies at once; freeze, then delayed unfreeze; mandate budget exhaustion                                                                                                                                                           |
| `x402.test.ts`           | Spend-key refill under policy; the buyer's `fetch` pays the seller through the facilitator ($0.01 settled after serving, $2.00 settled before serving); both sides reconciled; 0.5% receive fee accrued to the seller                                                                                                                                |
| `escrow-streams.test.ts` | Escrow lock, release, refund, dispute; stream create, keeper settlement, cancel; goal and locked vaults                                                                                                                                                                                                                                              |
| `mcp.test.ts`            | All eight MCP money tools end to end                                                                                                                                                                                                                                                                                                                 |
| `redteam.test.ts`        | Phase 2 red team (see [phase-2-red-team.md](phase-2-red-team.md))                                                                                                                                                                                                                                                                                    |
| `exit-drill.test.ts`     | Phase 5 exit drill (see [phase-5-exit-drill.md](phase-5-exit-drill.md))                                                                                                                                                                                                                                                                              |
| `base-sepolia.test.ts`   | The same scenarios against Base Sepolia; skipped unless a person provides credentials                                                                                                                                                                                                                                                                |

Result at the time of writing: 33 tests in 9 files pass in about 83 seconds; no bugs were found
in the services under test.

**Base Sepolia (the gate as written):** `E2E_CHAIN=base-sepolia pnpm --filter @agentbank/e2e
gate:phase3` runs the scenarios against the live testnet once a person provides
`BASE_SEPOLIA_RPC_URL`, `PIMLICO_API_KEY`, funded testnet keys, a revenue address and the deployed
contract addresses. Without them it skips and lists what is missing; nothing is broadcast.
