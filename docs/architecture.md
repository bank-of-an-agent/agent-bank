# Agent Bank architecture

This document turns the [design](design.md) into the concrete system in this repository: which
service owns what, the interfaces between packages, and every money flow step by step. It is
the reference for anyone changing the code. Where the code and this document disagree, fix one
of them in the same pull request.

## Non-negotiables

These come from the design's regulatory posture and the implementing-agent rules. Code review
rejects any change that weakens them.

1. **Non-custodial.** No code path, upgrade path or admin function lets the co-signer, or any
   bank-held key, move funds alone. Bank keys can only _refuse_ (co-signer) or _trigger_ moves
   between a principal's own accounts that the owner configured (keepers for top-up and sweep
   executors).
2. **Testnet only.** `assertTestnet()` (packages/core) refuses mainnet chain ids; the database
   refuses mainnet `account.chain_id`; deploy scripts revert on chain 8453.
3. **Money is integer minor units** (`bigint` in TypeScript, `bigint` columns in Postgres,
   decimal strings on the wire). ESLint bans floats in the money packages.
4. **Every write is idempotent** (`Idempotency-Key` header; ledger idempotency keys).
5. **Fail closed.** If the co-signer, policy store, screening or database is unavailable, the
   payment stops. Errors are `cosigner_unavailable` / `screening_unavailable` (HTTP 503).
6. **No LLM in the decision path.** Policy evaluation is a pure, deterministic function.
7. **Secrets never enter the repo, logs or prompts.** Config comes from env vars populated by
   the secret manager.

## Services and trust boundaries

```
 Agents (SDK / MCP) ──RFC 9421──┐            ┌─────────── co-signer account (AWS) ───────────┐
 Principals (console / API key) ┼─► apps/api ┼─HMAC─► apps/cosigner ── KMS secp256k1 (Sign)  │
 Sellers (x402) ──► apps/facilitator         │        policy store · spend history · audit   │
                        │                     └───────────────────────────────────────────────┘
                        ▼                            ▲ freeze / pause sessions
                 PostgreSQL 16 ◄── reconciler ◄─ apps/indexer (own account) ┘
                        │                ▲
                        ▼                │ logs (USDC Transfer, AuthorizationUsed, escrow/stream/vault events)
          ChainGateway (packages/chain) ─┴──► Base Sepolia: Safe + ERC-7579 + Smart Sessions,
                                               EntryPoint v0.7, Pimlico bundler/paymaster, USDC
```

| Service            | Deploy                                 | Holds                                                                        | Can do                                                                                                                              |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`         | API account                            | Org/agent data, ledger, payments                                             | Validate, hold funds in the ledger, build operations, submit co-signed operations                                                   |
| `apps/cosigner`    | **Separate AWS account**               | Policies, sessions, mandates, freezes, its own spend history, KMS key handle | Evaluate policy independently and add (or refuse) the second signature                                                              |
| `apps/indexer`     | **Separate AWS account**, own database | Chain cursor, block hashes, raw logs                                         | Read the chain, detect reorgs, push normalized events to the API's internal reconciliation endpoints, run the nightly balance check |
| `apps/facilitator` | API account                            | x402 authorization log, testnet relayer key                                  | Verify and settle payer-signed EIP-3009 authorizations                                                                              |
| `apps/console`     | API account                            | Nothing (calls the API)                                                      | Principal dashboard: sign-in, approvals, freeze, policies                                                                           |

The API never sees the co-signer key. A compromised API can ask the co-signer to sign, but the
co-signer re-derives what the operation does from the raw user operation, evaluates its own
copy of the policy against its own spend history, and still needs the agent's session
signature. A compromised co-signer key is useless without a session key, and both together are
bounded by the on-chain session scope.

## Packages

| Package                   | Responsibility                                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`           | Money, ids, errors (RFC 9457), chains and the mainnet lock, assets, canonical JSON, RFC 9421 request signing, webhook HMAC, EIP-712 owner authorizations, policy and mandate schemas, **the API contract** (`src/api/routes.ts`) and the OpenAPI generator           |
| `packages/db`             | `SqlClient` over node-postgres or PGlite, serializable transactions with retry, SQL migrations                                                                                                                                                                       |
| `packages/ledger`         | Double-entry ledger: accounts, journal entries, holds (post/void/expire), reversals, idempotency, invariants. `InMemoryLedger` and `PostgresLedger` behind one `Ledger` interface                                                                                    |
| `packages/policy`         | Deterministic policy evaluator, policy diff (tighten/loosen), mandate compiler, session-scope compiler, auto-save rules                                                                                                                                              |
| `packages/reconciliation` | The reconciler mounted inside the API at `/internal/v1/*`: matches chain events to expected movements, posts ledger entries, settles payments/escrows/streams, raises suspense and mismatch events, reverses entries on reorgs (contract: `core/src/indexer-api.ts`) |
| `packages/chain`          | `ChainGateway` interface with `SimulatedChain` (in-memory, reorg injection) and `EvmChainGateway` (Base Sepolia/Anvil via viem + permissionless + Rhinestone module-sdk); contract ABIs and addresses                                                                |
| `packages/sdk-ts`         | `@agentbank/sdk`: typed client, session keys, request signing, x402 client and seller middleware, webhook verification                                                                                                                                               |
| `packages/mcp`            | `@agentbank/mcp`: MCP server exposing money tools to agents (stdio + streamable HTTP)                                                                                                                                                                                |

Migrations live in `packages/db/migrations` and are owned by domain: `0001_ledger.sql`
(ledger), `0002_core.sql` (identity, authority, payments …), `0003_chain.sql` (indexer),
`0004_x402.sql` (facilitator). The co-signer has its own database and migrations in
`apps/cosigner/migrations`.

## Identity, accounts and keys

- **Org** (principal) owns agents and has an `owner_address`: the owner key, held by the
  principal (passkey/hardware wallet). Agent Bank never holds it.
- **Agent** has at most one **account** per chain: a Safe (v1.4.1) with the Safe7579 adapter,
  deployed counterfactually (CREATE2 via the Safe7579 launchpad), so it can receive funds
  before deployment. Each org also has a **treasury** account.
- **Session keys** are generated client-side by the SDK (secp256k1, default 24 h, max 7 days).
  On-chain they are Smart Sessions sessions whose session validator is an `OwnableValidator`
  configured **2-of-2: session key + Agent Bank co-signer**, with policies for the token
  spending limit (`max_per_day`), per-call value (`max_per_tx` via the hook), allowed
  recipients/contracts, and expiry (time-frame policy). Off-chain the co-signer stores the same
  scope (verified against the owner's EIP-712 authorization).
- **Spend key** (ADR 0001): a per-agent EOA holding a small USDC float, used only to sign
  EIP-3009 authorizations for x402. Refilled from the smart account under policy. The on-chain
  loss bound for a fully compromised agent is the float.
- **Owner operations**: anything only the owner key may authorize (installing sessions,
  configuring executors, early vault withdrawal, `require_owner` payments) is an
  `owner_operation`: the API prepares it, the owner signs `user_op_hash`, the API submits it.
  The owner can also bypass Agent Bank entirely with the open-source exit tool (Safe
  `execTransaction`), which never touches 7579 modules or hooks.

Validation rule on-chain (design § Identity): an operation is valid if the owner signs it, or
if a live session key and the co-signer both sign it and the session policies and
`AgentPolicyHook` pass.

## Authentication

| Caller                 | Mechanism                                                                                                                                                                                                                                         | Code                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Agent                  | RFC 9421 HTTP Message Signature by the session key: label `agentbank`, alg `eip191-secp256k1`, `keyid` = session id, covers `@method`, `@target-uri`, `content-digest`, `idempotency-key`; max lifetime 300 s; nonce single-use (`request_nonce`) | `core/http-signatures.ts`   |
| Principal (automation) | `Authorization: Bearer abk_test_<random>`; only the SHA-256 is stored                                                                                                                                                                             | `apps/api`                  |
| Principal (console)    | Passkey (WebAuthn) sign-in → session cookie                                                                                                                                                                                                       | `apps/console` + `apps/api` |
| Owner actions          | EIP-712 `OwnerAuthorization {action, subject, payloadHash, issuedAt, expiresAt}` over the canonical JSON payload, ≤ 15 min validity                                                                                                               | `core/eip712.ts`            |
| API → co-signer        | `Authorization: AgentBank-Internal t=<unix>,v1=<hmac>` (same construction as webhooks) over the raw body; mTLS/PrivateLink in AWS                                                                                                                 | `apps/cosigner`             |
| Staff                  | Bearer operator token (internal dashboards only)                                                                                                                                                                                                  | `apps/api`                  |

## Ledger model

Double-entry, append-only, integer minor units. Every entry's lines sum to zero (enforced by a
deferred constraint trigger and by the library). Balances are derived from the journal; the
cached `ledger_account.balance` is a projection checked nightly.

### Ledger accounts

| Code                          | Owner   | Location of the funds                             | Notes                                                                              |
| ----------------------------- | ------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pocket:operating`            | account | smart account                                     | Spendable                                                                          |
| `pocket:reserved`             | account | smart account                                     | Holds for pending payments from `operating`                                        |
| `pocket:fees`                 | account | smart account                                     | Fees accrued and owed, swept with the next outgoing operation                      |
| `pocket:savings`              | account | smart account                                     | Funds earmarked for the treasury by auto-save, swept with the next operation       |
| `pocket:vault:<vlt_id>`       | account | smart account (goal) or `TimeLockVaults` (locked) | Agents cannot spend from vaults                                                    |
| `pocket:escrow`               | account | `AgentEscrow` contract                            | Locked escrow funds                                                                |
| `pocket:stream`               | account | `PaymentStreams` contract                         | Unstreamed stream deposits                                                         |
| `pocket:spend`                | account | spend-key EOA                                     | x402 float                                                                         |
| `pocket:spend_reserved`       | account | spend-key EOA                                     | Holds on the float for pending x402 payments                                       |
| `sys:chain:<chainId>:<asset>` | system  | outside Agent Bank                                | Mirror of value entering/leaving known addresses (negative balance = value inside) |
| `sys:revenue`                 | system  | bank revenue address                              | Fee income                                                                         |
| `sys:suspense`                | system  | —                                                 | Unmatched chain movements awaiting review                                          |

Pockets never go negative; `sys:*` accounts may.

### Movements (all amounts USDC minor units)

| Movement                                      | Entry (debit → credit expressed as signed lines)                                                                                         | Posted by                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Deposit to account                            | `sys:chain −x`, `operating +x`                                                                                                           | indexer, on chain evidence    |
| Hold for payment                              | `operating −(x+f)`, `reserved +(x+f)`                                                                                                    | API, at payment creation      |
| Payment settles to external address           | `reserved −(x+f)`, `sys:chain +x`, `sys:revenue +f`                                                                                      | indexer, matching the user op |
| Payment settles to another Agent Bank account | `reserved(A) −(x+f)`, `operating(B) +x`, `sys:revenue +f`                                                                                | indexer                       |
| Hold voided (deny/expire/fail)                | `reserved −(x+f)`, `operating +(x+f)`                                                                                                    | API / worker                  |
| Spend-key refill                              | hold from `operating`; on settle `reserved −r`, `spend +r`                                                                               | API + indexer                 |
| x402 pay                                      | hold `spend −x`, `spend_reserved +x`; on `AuthorizationUsed` + transfer: `spend_reserved −x`, `sys:chain +x` (or payee's `operating +x`) | API + indexer                 |
| x402 receive fee (seller)                     | `operating −f`, `fees +f` (accrual)                                                                                                      | worker, after settlement      |
| Escrow lock                                   | hold; on `Locked`: `reserved −(x+f)`, `escrow +x`, `sys:revenue +f`                                                                      | indexer                       |
| Escrow release                                | `escrow(A) −x`, `sys:chain +x` or `operating(B) +x`                                                                                      | indexer                       |
| Escrow refund                                 | `escrow −x`, `operating +x`                                                                                                              | indexer                       |
| Stream create                                 | hold; on `StreamCreated`: `reserved −(d+f)`, `stream +d`, `sys:revenue +f`                                                               | indexer                       |
| Stream settle                                 | `stream(A) −s`, `sys:chain +s` or `operating(B) +s`                                                                                      | indexer                       |
| Fee sweep                                     | `fees −f`, `sys:revenue +f` (batched into the next outgoing operation)                                                                   | indexer                       |
| Goal-vault save                               | `operating −x`, `vault:<id> +x` (ledger only)                                                                                            | API/worker                    |
| Reversal                                      | the original lines negated, `reverses_entry_id` set                                                                                      | ledger                        |
| Unmatched outflow                             | `operating −x` (or `spend −x`), `sys:suspense +x`; sessions paused                                                                       | indexer                       |

Two-phase movement: a **hold** reserves funds at authorization, then is **posted** on chain
confirmation (optionally for a smaller amount, releasing the remainder) or **voided** on
failure/expiry. Holds expire (default: signature deadline + 1 h); the worker voids them.

### Reconciliation (indexer + reconciler)

The indexer runs in its own cloud account with its own database and never touches the ledger
database. It fetches the watchlist (`GET /internal/v1/watchlist`), reads logs, and pushes
normalized events (`POST /internal/v1/chain-events`, `…/reorg`) to the API, authenticated with
`signInternalRequest` and `INTERNAL_API_SHARED_SECRET`. The reconciler
(`packages/reconciliation`, mounted in the API process) does the matching and posting inside
the API's database transaction, idempotently by event id. Contract: `core/src/indexer-api.ts`.

- Reads USDC `Transfer` and `AuthorizationUsed` events for every known address (account,
  spend key, treasury, bank revenue) plus all events of the escrow, streams and vault
  contracts.
- Finality: movements below $100 post on L2 inclusion; larger ones when the block is
  `finalized`. A reorg reverses entries posted from orphaned blocks.
- Each on-chain movement must match a ledger expectation (payment by user-op/tx hash, x402 by
  authorization nonce, escrow/stream/vault by on-chain id) within 20 blocks. Unmatched →
  suspense entry, `reconciliation.mismatch` event, alert, and the agent's sessions are paused
  through the co-signer.
- Nightly: for every account, on-chain balance at the indexer cursor block == sum of the
  pockets located at that address (`operating + reserved + fees + savings + goal vaults` for
  the smart account, `spend + spend_reserved` for the spend key); per-id balances for shared
  contracts.

## Policy engine

`evaluate(policy, context) → Decision` is pure. The context carries everything time- or
history-dependent (now, spend in rolling windows, counterparty first-seen time, velocity
counts, mandate spend, session scope). Windows are rolling: day = 24 h, week = 7 d, month =
30 d. Outcomes by severity: `deny` > `require_owner` > `require_approval` > `allow`. Every
rule that fires is reported in `rule_hits` (stable rule ids such as `limits.per_day`,
`counterparties.allowlist`, `mandate.budget`, `session.max_per_tx`).

Policy changes are classified by `classifyChange(old, next)`: `tighten` applies immediately;
`loosen` or `mixed` requires an owner authorization (`policy.loosen`) and becomes effective
after 1 hour. The co-signer is the enforcement authority; the API keeps a display copy.

Mandates (AP2 open Payment Mandates) compile into extra deny rules (amount range, payees,
x402 domains, budget, recurrence, execution window, expiry) and into the session scope
(intersection of mandate and policy caps).

## Payment flows

### Agent-to-agent / external transfer

1. `POST /v1/payments` (agent-signed). API resolves the counterparty, computes the fee
   (0.20%, capped at $5.00), asks the co-signer for a **dry-run** decision.
2. `deny` → payment `denied` (decision recorded, webhook `payment.denied`), no hold.
3. Otherwise place a hold (`operating → reserved`, amount + fee). Insufficient →
   `insufficient_funds`.
4. `require_approval` → `approval` (expires in 15 min), payment `requires_approval`,
   `approval.requested` webhook. Approved → step 6; denied/expired → void hold.
5. `require_owner` → owner operation; the owner signs the transfer themselves.
6. `allow` → `ChainGateway.prepareOperation` (USDC transfer to payee + fee transfer to the
   revenue address + any pending fee/savings sweeps, batched) → payment
   `requires_signature` with `signing_request.user_op_hash`, deadline 10 min.
7. Agent signs the hash with the session key → `POST /v1/payments/{id}/signature`.
8. API → co-signer `/internal/v1/cosign` with the raw user op. Co-signer recomputes the hash,
   decodes the calls, verifies the session signature and scope, re-evaluates policy (its own
   history), records the spend, appends to its audit chain, signs. Refusal → payment
   `denied`, hold voided.
9. API submits (bundler), payment `submitted`. Indexer matches the transfer → posts the hold →
   payment `settled`, `payment.settled` webhook. Revert/timeout → `failed`, hold voided,
   co-signer told to release the spend.

### x402 pay (buyer agent)

1. SDK gets HTTP 402 with x402 v2 `accepts[]`, picks the `exact` USDC requirement on Base
   Sepolia, calls `POST /v1/x402/pay` with the requirement and resource.
2. API checks policy via the co-signer `/internal/v1/authorize-x402` (domain allowlist, caps,
   velocity, mandate), holds `spend → spend_reserved`, creates the payment (`x402`), returns the
   EIP-3009 `TransferWithAuthorization` to sign (nonce = keccak of the payment id; validBefore
   = now + maxTimeoutSeconds).
3. SDK signs with the spend key, retries the resource with the `PAYMENT-SIGNATURE` header.
4. Seller's facilitator settles; indexer sees `AuthorizationUsed(nonce)` + `Transfer` → posts.
5. If the float is low the SDK requests a refill (a normal session+co-signer payment of kind
   `refill` to the agent's own spend key, capped by policy).

### x402 receive (seller agent)

`apps/facilitator` implements x402 v2 `/verify`, `/settle`, `/supported` for the `exact` EVM
scheme: checks network, asset, `payTo`, amount, time window (rejects authorizations valid for
less than 6 s more), signature (EOA; ERC-1271 for deployed contracts), payer balance,
`authorizationState` on-chain and its own single-use nonce table, screening; then relays
`transferWithAuthorization`. Settle-before-serve above $1 is enforced by the SDK's seller
middleware. A 0.5% receive fee accrues to the seller's `fees` pocket.

### Escrow and streams

`POST /v1/escrows` holds amount + fee (1%, min $1), prepares `[USDC.approve(escrow, x),
AgentEscrow.lock(...)]` + fee transfer, same signature/co-sign flow. Release/refund/dispute
prepare the corresponding contract call. Streams use `PaymentStreams` (pre-funded deposit,
`amountPerInterval` per `interval`, settled hourly by the worker calling `settle`), fee 0.5%
of the deposit at creation.

### Savings and treasury

- Goal vaults: ledger pockets; deposits by agent or principal, withdrawals by principal only.
- Locked vaults: `TimeLockVaults` contract; early withdrawal is an owner operation.
- Auto-save (policy `auto_save`): income split and round-up move to a goal vault (ledger) or to
  `pocket:savings`, which is swept to the treasury in the next outgoing operation; excess
  above `max_balance` likewise.
- Auto top-up: owner installs `TopUpExecutor` on the treasury (owner operation); a keeper
  calls `topUp(treasury, agent)`; funds only ever move between the org's own accounts.
- Treasury sweep: `SweepExecutor` into an ERC-4626 fund from the neutral eligibility list.
  **Counsel-gated**: disabled unless `FEATURE_TREASURY_SWEEP=true`.

## Fees and billing

| Stream           | Price                       | Collected                                          |
| ---------------- | --------------------------- | -------------------------------------------------- |
| Outbound payment | 0.20%, cap $5.00            | Batched into the payment operation                 |
| x402 receive     | 0.50% of settled amount     | Accrued, swept with the seller's next operation    |
| Escrow           | 1%, min $1.00               | Batched into the lock operation                    |
| Streams          | 0.50% of deposit            | Batched into the create operation                  |
| Treasury sweep   | 0.15%/yr on swept balance   | Accrued daily, swept monthly (gated)               |
| Subscriptions    | Free / $99 / $499 / ~$4,000 | Accrued monthly on the treasury `fees` pocket      |
| Gas              | At cost                     | Pimlico paymaster sponsors; cost accrues to `fees` |

Every fee is a ledger entry into `sys:revenue` (plus a `fee_charge` row), so revenue
reconciles like every other movement.

## ChainGateway

```ts
interface ChainGateway {
  readonly chainId: number;
  predictAccountAddress(input: { owner: Address; cosigner: Address; salt: bigint }): Promise<Address>;
  isDeployed(address: Address): Promise<boolean>;
  getTokenBalance(token: Address, holder: Address, blockNumber?: bigint): Promise<bigint>;
  prepareOperation(input: PrepareOperationInput): Promise<PreparedOperation>; // session path
  prepareOwnerOperation(input: PrepareOwnerOperationInput): Promise<PreparedOperation>;
  decodeOperation(op: PreparedOperation): DecodedCall[]; // used by the co-signer, never trusts callers
  hashOperation(op: PreparedOperation): Hex;
  submitOperation(input: SubmitOperationInput): Promise<{ userOpHash: Hex }>;
  getOperationReceipt(userOpHash: Hex): Promise<OperationReceipt>;
  getBlock(tag: bigint | "latest" | "safe" | "finalized"): Promise<BlockRef>;
  getLogs(input: LogQuery): Promise<ChainLog[]>;
  settleAuthorization(input: SettleAuthorizationInput): Promise<{ txHash: Hex }>; // facilitator
  authorizationState(token: Address, authorizer: Address, nonce: Hex): Promise<boolean>;
  verifySignature(input: { address: Address; hash: Hex; signature: Hex }): Promise<boolean>;
}
```

`SimulatedChain` implements the same rules in memory (owner signature, or session + co-signer
within scope; ERC-20 balances; EIP-3009; escrow/stream/vault contract semantics; blocks,
finality and injectable reorgs) so the full stack runs and is tested without a network.

## Configuration

All services read env vars validated with Zod at startup (fail fast). See `.env.example`.
Notable: `AGENTBANK_CHAIN` (`simulated` | `anvil` | `base-sepolia`), `DATABASE_URL`,
`COSIGNER_URL`, `COSIGNER_SHARED_SECRET`, `COSIGNER_SIGNER` (`local` testnet-only | `kms`),
`PIMLICO_API_KEY`, `FEATURE_TREASURY_SWEEP`.

## Testing

- Unit and property tests with Vitest + fast-check next to each package (`test/`).
- `packages/ledger` and `packages/policy` require ≥ 90% coverage (CI enforced).
- Database tests run on PGlite by default and on PostgreSQL 16 in CI (`DATABASE_URL`).
- End-to-end tests run the API, co-signer and indexer against `SimulatedChain`; live Base
  Sepolia tests are opt-in (`RUN_LIVE_TESTS=1`).
- Contracts: Foundry unit, fuzz and invariant tests in the `contracts` repository.
