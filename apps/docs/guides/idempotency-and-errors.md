# Idempotency and errors

Money APIs must survive retries: networks drop responses, processes crash between steps, and agents retry. Agent Bank makes every write idempotent and every error machine-readable.

## Idempotency

Every operation that writes (creates a payment, signs one, locks an escrow, changes a policy…) requires an **`Idempotency-Key`** header: 8 to 255 characters, unique per logical operation. The [API reference](/api/) marks these operations, and the ledger applies the same rule internally.

- A retry with the **same key and the same request** returns the original result, with the original status code, instead of acting twice.
- The **same key with a different request** is rejected with `idempotency_conflict` (HTTP 409): the API stores a hash of the request with the key.
- A request still in progress under the same key is reported as a conflict too; retry it after a moment.

The SDKs generate a key (a UUID) for every write and reuse it across their own automatic retries, so a dropped response never causes a double payment inside one call. To make a retry safe **across process restarts**, derive the key from your own task and pass it in:

```ts
await agent.pay(
  { to: vendorAddress, amount: "12.50", memo: `invoice ${invoice.id}` },
  { idempotencyKey: `invoice-${invoice.id}` },
);
```

```python
agent.pay(to=vendor_address, amount="12.50", idempotency_key=f"invoice-{invoice.id}")
```

The high-level flows make several writes (create, then sign); the SDK derives a separate key per step from yours, and the signature step uses a key derived from the operation hash, so resuming a half-finished payment is safe. The MCP server's `pay`, `create_escrow` and `release_escrow` tools take an `idempotency_key` argument for the same reason.

### Which errors to retry

| Retry                        | Errors                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yes, with the **same** key   | Network errors, timeouts, `rate_limited` (429; honor `Retry-After`), `internal` (500), `chain_error` (502), `cosigner_unavailable` and `screening_unavailable` (503) |
| After fixing something       | `insufficient_funds` (fund the account), `session_expired` (grant a new session), `agent_frozen` (unfreeze)                                                          |
| Later, with the same request | `policy_denied` when the decision has a `retry_at` (a cooling period or time window that lifts)                                                                      |
| No                           | Other `policy_denied`, validation errors, `forbidden`, `mainnet_locked`, `idempotency_conflict`                                                                      |

Agents must treat a `policy_denied` refusal as final and never split a denied payment into smaller ones to get under a limit; the MCP server's instructions say so to the model, and the per-day and velocity limits catch it anyway.

## Problem details

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem documents with media type `application/problem+json`:

```json
{
  "type": "urn:agentbank:problem:policy_denied",
  "title": "Payment denied by policy",
  "status": 422,
  "detail": "1500.00 USDC exceeds the per-transaction limit of 25.00 USDC",
  "instance": "/v1/payments",
  "code": "policy_denied"
}
```

- `code` is stable and machine-readable; branch on it, not on `title` or `detail`.
- `type` is a URN derived from the code (`urn:agentbank:problem:<code>`), so clients never depend on a documentation host being reachable.
- `detail` explains this occurrence; extension members carry structured context, such as validation `issues` or the policy `decision` with its `rule_hits`.
- Send the `x-request-id` response header when you report a problem.

## Error codes

The catalog below is `ERROR_CATALOG` in `packages/core/src/errors.ts`, the single list the API, the SDKs and the MCP server share.

| Code                       | HTTP | Title                                           | Typical cause and what to do                                                                                 |
| -------------------------- | ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `invalid_request`          | 400  | Invalid request                                 | The body, query or path failed validation; `issues` lists each field. Fix the request                        |
| `invalid_amount`           | 400  | Invalid amount                                  | An amount is not a decimal string with at most 6 decimals, or is zero where a positive amount is required    |
| `unsupported_asset`        | 400  | Unsupported asset                               | Only `USDC` in v1                                                                                            |
| `unsupported_chain`        | 400  | Unsupported chain                               | Use `base-sepolia` (or `simulated`/`anvil` locally)                                                          |
| `unauthorized`             | 401  | Authentication required                         | Missing API key or request signature, or an unknown session id                                               |
| `signature_invalid`        | 401  | Signature invalid                               | A request signature, owner authorization or webhook signature did not verify, expired, or reused a nonce     |
| `session_expired`          | 401  | Session key expired                             | Grant a new session                                                                                          |
| `session_revoked`          | 401  | Session key revoked                             | The owner revoked it; grant a new session                                                                    |
| `forbidden`                | 403  | Forbidden                                       | The credentials may not call this operation (wrong role, agent calling a principal route)                    |
| `owner_signature_required` | 403  | Owner signature required                        | The change loosens limits or needs the owner key: add an `owner_authorization` signed by the org's owner key |
| `feature_gated`            | 403  | Feature not enabled                             | The feature is off in this deployment (for example the treasury sweep)                                       |
| `mainnet_locked`           | 403  | Mainnet is locked                               | A mainnet chain id was used; Agent Bank is testnet-only until the Phase 5 gate                               |
| `not_found`                | 404  | Not found                                       | The resource does not exist or is not visible to these credentials                                           |
| `conflict`                 | 409  | Conflict                                        | A concurrent change or an in-flight request with the same idempotency key                                    |
| `idempotency_conflict`     | 409  | Idempotency key reused with a different request | Use a new key for a new operation                                                                            |
| `invalid_state`            | 409  | Invalid state transition                        | The resource is not in a state that allows this (for example canceling a submitted payment)                  |
| `approval_expired`         | 409  | Approval expired                                | The 15-minute approval window passed; the payment must be made again                                         |
| `insufficient_funds`       | 422  | Insufficient funds                              | `available` (or the x402 float) cannot cover amount plus fee                                                 |
| `policy_denied`            | 422  | Payment denied by policy                        | The policy engine or the co-signer refused; see the decision's `rule_hits` and `retry_at`                    |
| `mandate_invalid`          | 422  | Mandate invalid                                 | The mandate is malformed, revoked, for another agent, or does not cover this payment                         |
| `mandate_expired`          | 422  | Mandate expired                                 | Issue a new mandate                                                                                          |
| `agent_frozen`             | 423  | Agent is frozen                                 | The co-signer refuses everything for this agent until the owner unfreezes it                                 |
| `org_frozen`               | 423  | Organization is frozen                          | The whole org is frozen                                                                                      |
| `rate_limited`             | 429  | Too many requests                               | Back off; honor `Retry-After`                                                                                |
| `cosigner_unavailable`     | 503  | Co-signer unavailable; failing closed           | The co-signer is unreachable, so payments stop rather than pass. Retry later with the same key               |
| `screening_unavailable`    | 503  | Screening unavailable; failing closed           | Wallet screening is unreachable; payments stop. Retry later                                                  |
| `chain_error`              | 502  | Chain or bundler error                          | The RPC or bundler failed; retry with the same key                                                           |
| `internal`                 | 500  | Internal error                                  | Unexpected; retry with the same key, and report the `x-request-id` if it persists                            |

## In the SDKs

The TypeScript SDK throws an `AgentBankError` subclass per code family (`PolicyDeniedError`, `InsufficientFundsError`, `FrozenError`…), with `code`, `httpStatus`, the raw `problem`, `operationId` and `requestId`; it validates requests against the contract before sending them, so most `invalid_request` errors never reach the network. The Python SDK raises the equivalent exceptions with `.code`, `.status` and `.detail`. See the [TypeScript](/guides/typescript-sdk#errors) and [Python](/guides/python-sdk#errors) guides.
