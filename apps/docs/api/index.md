# API reference

The Agent Bank REST API (v1) is defined once, in the route registry of `@agentbank/core` (`packages/core/src/api/routes.ts`). The API server registers exactly those routes, the TypeScript SDK is typed from them, and `docs/openapi.json` (OpenAPI 3.1) is generated from them; CI fails if the committed document is stale ([ADR 0003](/operations/adrs)). The pages in this section are generated from that document every time the docs are built, so they describe the same contract the server enforces.

- Download the document: [openapi.json](/openapi.json)
- Every operation, grouped by resource: see the [operation index](#operation-index) below
- Every request and response shape: [Schemas](/api/schemas)

## Base URLs

| Environment              | API                     | x402 facilitator (`/v1/x402/*`) |
| ------------------------ | ----------------------- | ------------------------------- |
| Local sandbox            | `http://localhost:8080` | `http://localhost:8083`         |
| Hosted sandbox (testnet) | not yet published       | not yet published               |

<!-- verify: hosted sandbox URLs once infra/envs/sandbox is deployed -->

In a deployed environment a load balancer routes `/v1/x402/verify`, `/v1/x402/settle` and `/v1/x402/supported` to the facilitator, so one base URL serves both. Agent Bank is **testnet only** until the Phase 5 gate: the API refuses mainnet chain ids with `mainnet_locked`. `GET /v1/meta` tells a client which chain, USDC contract and feature flags a deployment uses.

## Authentication

| Caller                 | How it authenticates                                                                                                                                                                                                                                 | Routes                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Principal (automation) | `Authorization: Bearer abk_test_…` org API key. Only its SHA-256 is stored. Created at sign-up (`POST /v1/orgs`) or with `POST /v1/api-keys`.                                                                                                        | Everything marked `principal`           |
| Principal (console)    | Passkey (WebAuthn) sign-in to the console, which calls the API for you.                                                                                                                                                                              | Everything marked `principal`           |
| Agent                  | An [RFC 9421 HTTP Message Signature](/guides/request-signing) by the agent's session key: label `agentbank`, algorithm `eip191-secp256k1`, `keyid` = the session id. No static secret ever leaves the agent.                                         | Everything marked `agent`               |
| Approver               | A member with the approver or admin role. Console members also send a passkey assertion with each decision.                                                                                                                                          | `POST /v1/approvals/{id}/decide`        |
| Owner                  | Not a credential: owner-only changes carry an EIP-712 [`owner_authorization`](/concepts/owner-operations#owner-authorizations) in the body, and on-chain owner actions are [owner operations](/concepts/owner-operations) signed with the owner key. | Loosening changes, sessions, unfreezing |
| Public                 | Nothing.                                                                                                                                                                                                                                             | Sign-up, plans, `/v1/meta`, `/healthz`  |

::: warning Never give an API key to an agent
An org API key can create agents and change (tighten) policies. Agents authenticate with their session key only, and the [MCP server](/guides/mcp-server) and SDK agent clients never ask for an API key.
:::

## Conventions

**JSON and naming.** Requests and responses are JSON with `snake_case` fields. Every resource has an `object` field naming its type (`"payment"`, `"escrow"`, …).

**Money.** An amount is a decimal string in major units plus an asset code, never a JSON number:

```json
{ "amount": "25.00", "asset": "USDC" }
```

USDC is the only asset in v1 and has 6 decimals, so amounts carry at most 6 fraction digits. Internally every amount is an integer number of minor units (`25.00` USDC is `25000000`). x402 messages are the exception: they follow the x402 protocol and carry atomic units as integer strings (`"10000"` for 0.01 USDC).

**Ids.** Ids are a prefix and a 26-character ULID (Crockford base32), so they sort by creation time and are safe to expose: `org_`, `mem_` (member), `key_` (API key), `agt_`, `acct_`, `ses_` (session), `mdt_` (mandate), `pol_` (policy version), `pay_`, `preq_` (payment request), `dec_` (policy decision), `apr_` (approval), `esc_`, `str_` (stream), `ent_` (ledger entry), `evt_`, `whe_` (webhook endpoint), `vlt_` (vault), `atu_` (auto top-up rule), `swp_` (sweep rule), `fnd_` (fund), `oop_` (owner operation).

**Timestamps.** ISO 8601 with an offset, for example `2026-10-11T12:00:00.000Z`. Owner authorizations are the exception: `issued_at` and `expires_at` are Unix seconds because they are signed as EIP-712 integers.

**Pagination.** List endpoints take `limit` (1 to 200, default 50) and `cursor`, and return `{ "data": [...], "next_cursor": "..." }`. Pass `next_cursor` back as `cursor` until it is `null`. The SDKs iterate for you (`client.paginate(...)` in TypeScript, `list_all()` in Python).

**Idempotency.** Every write that can move money or create state requires an `Idempotency-Key` header (8 to 255 characters). A retry with the same key and the same request returns the original result; the same key with a different request is rejected with `idempotency_conflict`. See [Idempotency and errors](/guides/idempotency-and-errors).

**Errors.** Failures are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details (`application/problem+json`) with a stable `code`, for example `policy_denied` or `insufficient_funds`. The [error code table](/guides/idempotency-and-errors#error-codes) lists every code with its HTTP status.

**Versioning.** Paths are prefixed with `/v1`. `GET /v1/meta` returns `api_version` (currently `0.1.0`); until 1.0, minor versions may change the contract, and the SDKs are versioned with it.

## Operation index

<!--@include: ./_operations.md-->
