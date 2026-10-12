# Phase 5 gate report · Developer surface and beta

**Gate criterion:** legal sign-off, audits closed, exit tool verified, on-call rotation staffed.
**Status: code complete; exit tool verified; the rest needs humans.**

## Built

| Deliverable                                                                                                                  | Where                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Python SDK (sync + async, x402 transport, owner helpers)                                                                     | [`sdk-python`](https://github.com/bank-of-an-agent/sdk-python)           |
| MCP server (stdio and streamable HTTP; money tools only)                                                                     | `packages/mcp`                                                           |
| Documentation site and framework quickstarts (Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK, LangChain.js, MCP clients) | `apps/docs`, `examples/`                                                 |
| Statements and exports (JSON + CSV), sandbox parity (simulated chain with production validation rules)                       | `apps/api`, `packages/chain`                                             |
| Owner exit tool, tested against a simulated bank shutdown                                                                    | [`exit-tool`](https://github.com/bank-of-an-agent/exit-tool)             |
| Revenue dashboard against the business-model drivers                                                                         | `apps/console` (`/admin/revenue`), `packages/core/src/business-model.ts` |

## Exit tool verified

- **Anvil shutdown drill (runs in CI on every push):** with every Agent Bank service absent, the
  owner's key alone returned 9,808.59 USDC, 2 ETH and the treasury-fund shares to the owner's
  wallet and left the account with no modules, guard or adapter; 31 days later a hardware-wallet
  flow collected the remaining 128.59 USDC as positions unlocked
  (`exit-tool/docs/shutdown-drill.md`).
- **Base Sepolia fork:** guardian recovery, then `sync-owner`, leaves the lost key refused and the
  new key in control.
- **In-stack drill (simulated chain):** with the API, co-signer, facilitator and indexer
  stopped, the owner key alone recovered every recoverable dollar (escrow, stream, locked vault,
  spend-key float) to a cold wallet, leaving $0.00; on restart, reconciliation flagged the
  owner's movements as unexplained and paused the agent, as the runbook describes
  ([`evidence/phase-5-exit-drill.md`](evidence/phase-5-exit-drill.md)).

## Demo script

```bash
pnpm --filter @agentbank/e2e sandbox                # the whole bank locally (API, facilitator, demo seller)
pnpm --filter @agentbank/e2e gate:phase5            # rewrites evidence/phase-5-exit-drill.md
# In the exit-tool repository:
pnpm test:integration                               # the Anvil shutdown drill
```

## What a human must do

1. Legal sign-off on the co-signer model, spend keys and the treasury sweep (broker/adviser
   questions); choose the legal entity and a product name without "bank" in it.
2. Close the Phase 4 audits; launch the bug bounty.
3. Staff the on-call rotation (runbooks are in `docs/runbooks`).
4. Lift the mainnet lock deliberately (code, database constraint, deploy scripts) only after the
   above, with the per-account $1,000 beta cap.
