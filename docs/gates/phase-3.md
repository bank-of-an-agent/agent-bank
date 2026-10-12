# Phase 3 gate report · Payments and x402

**Gate criterion:** end-to-end suite on Base Sepolia passes; external audit firms booked.
**Status: code complete; gate needs humans.** The end-to-end suite passes on the simulated chain
and its Base Sepolia mode is ready, but running it needs funded testnet credentials and deployed
contracts that only a person can provide; audit firms are not booked.

## Built

| Deliverable                                                                                                    | Where                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Transfers and payment requests end to end, with webhooks (HMAC, 72-hour retries, outbox)                       | `apps/api`, `packages/db`                              |
| Two-step payments: hold → policy → session signature → independent co-signature → bundler → reconciliation     | `apps/api`, `apps/cosigner`, `packages/reconciliation` |
| x402 client in the SDKs (v2 and v1 wire formats), spend-key float with float-recovery permit                   | `packages/sdk-ts`, `sdk-python`, ADR 0001              |
| x402 facilitator with single-use settlement, USDC-exact signature rules, rate limits, registered-payee mode    | `apps/facilitator`                                     |
| Seller paywall with settle-before-serve above $1                                                               | `packages/sdk-ts` (`@agentbank/sdk/x402-server`)       |
| Paymaster integration (Pimlico) with gas billed to the fee pocket; fees batched into the payer's own operation | `packages/chain`, ADR 0008                             |
| Wallet screening on every counterparty (fail closed; sandbox provider, vendor adapter interface)               | `apps/api`, `apps/facilitator`                         |

## Tests

| Suite                                                                                                             | Result                                                          |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| API (route-level, every route, authz, idempotency, payment lifecycle, x402, escrow, streams, webhooks)            | 169 passed on PGlite and PostgreSQL 16                          |
| Facilitator (every rejection reason, concurrency, replay, ERC-1271/7702, interop with `@x402/core`)               | 203 passed                                                      |
| TypeScript SDK (incl. interop: our client ↔ official `@x402/express` middleware and facilitator, both directions) | 106 passed                                                      |
| Python SDK (incl. byte-identical cross-language vectors)                                                          | 563 passed, 99% coverage, CI on Python 3.10–3.14                |
| Chain fork suite (Anvil fork of Base Sepolia + local bundler): payments, x402 settlement on real USDC             | 26 passed                                                       |
| Full-stack end-to-end on the simulated chain (payments, approvals, controls, x402, escrow, streams, vaults, MCP)  | 33 passed; [`evidence/phase-3-e2e.md`](evidence/phase-3-e2e.md) |

## What a human must provide for the gate as written

1. A Pimlico API key (bundler + paymaster) for Base Sepolia.
2. Funded Base Sepolia keys: a deployer, the facilitator relayer, an owner and test USDC
   (Circle's faucet requires a person).
3. A broadcast of `contracts/script/Deploy.s.sol` (choose the pause guardian first).
4. Then run `E2E_CHAIN=base-sepolia pnpm --filter @agentbank/e2e test` with those values in the
   environment (never committed).
5. Book the two audit firms (Phase 4 scope is in `contracts/AUDIT_SCOPE.md`).

## Demo script

```bash
pnpm --filter @agentbank/e2e sandbox     # API :8080, facilitator :8083, demo x402 seller :4021
pnpm --filter @agentbank/e2e test        # the scenario suite
```

## Decisions taken

- Spend-key float for x402 (ADR 0001); fees batched into the payer's own operation (ADR 0008);
  x402 requests that need human approval are denied (an HTTP 402 retry cannot wait).
