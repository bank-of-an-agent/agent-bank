# Agent Bank indexer

Reads the chain and proves every movement against the ledger. It runs in its **own AWS account
with its own database** and never touches the ledger directly: it pushes normalized events to
the API's internal reconciliation endpoints ([contract](../../packages/core/src/indexer-api.ts)),
where [`@agentbank/reconciliation`](../../packages/reconciliation) posts them.

## What it does

- Polls blocks through `ChainGateway`, tracking block hashes to detect reorgs (walks back to the
  common ancestor and reports orphaned blocks).
- Reads USDC `Transfer` and `AuthorizationUsed` logs for watched addresses, all Agent Bank
  contract events, and ERC-4337 `UserOperationEvent`s; never splits a transaction across batches.
- Resends deferred large movements once their block is finalized.
- Nightly (and on demand) compares each account's on-chain USDC balance at its cursor with the
  ledger's expected balance and reports mismatches.

## Run

```bash
pnpm --filter @agentbank/indexer dev
node apps/indexer/dist/index.js balance-check     # one-off balance check; exit 1 on mismatch
pnpm --filter @agentbank/indexer test
```

| Variable                                                                                        | Meaning                                            |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                                                                                  | The indexer's own database                         |
| `API_INTERNAL_URL`, `INTERNAL_API_SHARED_SECRET`                                                | The API's internal endpoints and their HMAC secret |
| `AGENTBANK_CHAIN`, `CHAIN_RPC_URL`, `START_BLOCK`                                               | Chain, RPC and first block to index                |
| `RECONCILIATION_WINDOW` (20), `POLL_INTERVAL_MS`, `MAX_BLOCKS_PER_TICK`, `REORG_HISTORY_BLOCKS` | Tuning                                             |
| `BALANCE_CHECK_HOUR_UTC` (3)                                                                    | Nightly balance check                              |
| `METRICS_NAMESPACE`, `RECONCILIATION_METRICS_NS`                                                | CloudWatch EMF (`BlockLag`, `UnmatchedEvents`)     |

`GET /healthz` and `GET /metrics` listen on port 8082.
