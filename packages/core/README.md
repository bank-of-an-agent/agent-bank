# @agentbank/core

Shared primitives for every Agent Bank service and SDK: money, ids, errors, the testnet lock,
request and webhook signatures, owner authorizations, policy and mandate schemas, and **the API
contract** the REST API, OpenAPI document and SDKs are generated from.

Internal workspace package (bundled into the published SDKs).

## What's inside

| Module                            | Purpose                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `money`, `assets`                 | Integer minor units (`bigint`) with strict decimal-string parsing and formatting; USDC on Base Sepolia |
| `chains`                          | Supported testnets and `assertTestnet()`, which refuses mainnet chain ids                              |
| `ids`, `errors`                   | Prefixed sortable ids (`pay_01J…`); `AgentBankError` and RFC 9457 problem details                      |
| `http-signatures`                 | RFC 9421 request signing with session keys (`eip191-secp256k1`)                                        |
| `eip712`, `owner-actions`         | `OwnerAuthorization` typed data and the canonical subject/payload for every owner action               |
| `policy-schema`, `mandate-schema` | Policy documents, decisions, session scopes; AP2 v0.2 open Payment Mandates                            |
| `webhooks`, `audit`, `canonical`  | Webhook HMAC, hash-chained audit records, canonical JSON                                               |
| `cosigner-api`, `indexer-api`     | Internal service contracts and HMAC request authentication                                             |
| `business-model`                  | The design doc's P&L model as tested code (all figures in cents)                                       |
| `api/`                            | Route registry (`routes`), resource schemas, OpenAPI 3.1 generator                                     |

## Usage

```ts
import { parseAmount, formatAmount, assertTestnet, signRequest } from "@agentbank/core";
import { routes, buildOpenApiDocument } from "@agentbank/core/api";

parseAmount("12.50", 6); // 12_500_000n
assertTestnet(8453); // throws mainnet_locked
```

## Commands

```bash
pnpm --filter @agentbank/core test            # unit tests, cross-language vectors, business model
pnpm --filter @agentbank/core openapi         # regenerate docs/openapi.json from the route registry
pnpm --filter @agentbank/core openapi:check   # CI: fail if docs/openapi.json is stale
pnpm --filter @agentbank/core vectors         # regenerate test/vectors/vectors.json (shared with the Python SDK)
```

Changing the API means editing `src/api/routes.ts` / `src/api/resources.ts`, then running
`pnpm openapi`. See [ADR 0003](../../docs/adr/0003-api-contract-single-source.md).
