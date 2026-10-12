# Owner operations

The owner key is the principal's key. Agent Bank never holds it, and it is the only key that can loosen limits or move funds without the co-signer. It signs two kinds of things:

- **Owner authorizations**: EIP-712 signatures attached to API requests that change what an agent may do (a policy loosening, a session grant, a mandate, an unfreeze…). Off-chain; checked by the API and the co-signer.
- **Owner operations**: ERC-4337 user operations that only the owner may authorize on-chain (installing a session, configuring an executor…). Agent Bank prepares them, the owner signs them, and they need no co-signer.

## Owner authorizations

Every change that needs the owner is one EIP-712 message type, so wallet prompts stay legible and every service verifies it with the same code:

```text
domain:  { name: "Agent Bank", version: "1", chainId: <owner_authorization_chain_id> }
OwnerAuthorization {
  action:      string   // e.g. "policy.loosen"
  subject:     string   // the id the action applies to
  payloadHash: bytes32  // keccak256 of the canonical JSON of the payload
  issuedAt:    uint64   // Unix seconds
  expiresAt:   uint64   // at most 15 minutes after issuedAt
}
```

The request carries it as `owner_authorization: { signer, signature, issued_at, expires_at }`. The chain id comes from `GET /v1/meta` (`owner_authorization_chain_id`: 84532 on Base Sepolia); mainnet chain ids are refused. The payload is the request body without `owner_authorization`, **after the schema's defaults are applied**, serialized as canonical JSON (keys sorted, no whitespace), so signer and verifier hash the same bytes.

| Action           | Request                            | Subject    | Payload                                  |
| ---------------- | ---------------------------------- | ---------- | ---------------------------------------- |
| `session.grant`  | `POST /v1/sessions`                | account id | `{ account_id, public_key, scope }`      |
| `policy.loosen`  | `PUT /v1/agents/{id}/policy`       | agent id   | the policy document                      |
| `mandate.issue`  | `POST /v1/mandates`                | agent id   | the mandate object                       |
| `agent.unfreeze` | `POST /v1/agents/{id}/unfreeze`    | agent id   | `{ reason }`                             |
| `org.unfreeze`   | `POST /v1/orgs/me/unfreeze`        | org id     | `{ reason }`                             |
| `topup.set`      | `PUT /v1/agents/{id}/auto-topup`   | agent id   | `{ refill_to, when_below, max_per_day }` |
| `sweep.set`      | `PUT /v1/accounts/{id}/sweep-rule` | account id | the body without `owner_authorization`   |
| `treasury.set`   | `PUT /v1/orgs/me/treasury`         | org id     | `{ account_id }`                         |
| `vault.withdraw` | `POST /v1/vaults/{id}/withdraw`    | vault id   | `{ amount }`                             |
| `owner.rotate`   | `POST /v1/orgs/me/owner`           | org id     | `{ new_owner_address }`                  |

The SDKs build these for you: `PrincipalClient` methods (`setPolicy`, `grantSession`, `issueMandate`, `unfreezeAgent`, `setAutoTopUp`, `rotateOwner`, …) sign with the configured owner signer, and `ownerAuthorize(owner, { chainId, ...ownerPayloads.policyLoosen(agentId, policy) })` signs one by hand. In Python pass `owner=` to the resource method, or sign `owner_authorization_typed_data(...)` on a hardware wallet and pass `owner_authorization=`. The exact encoding and a test vector are in [Request signing](/guides/request-signing#owner-authorizations).

A missing or invalid authorization fails with `owner_signature_required` or `signature_invalid` (HTTP 403 or 401).

## Owner operations

Some on-chain actions must be authorized by the owner key alone. Agent Bank can prepare them, because it knows the account, the nonce, gas and the paymaster, but it can never sign them ([ADR 0005](/operations/adrs)). An **owner operation** is the API resource for that:

| Purpose           | Created by                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `session.install` | `POST /v1/sessions/{id}/install`                                                                   |
| `session.revoke`  | Revoking a session on-chain                                                                        |
| `topup.configure` | Configuring auto top-up (the `TopUpExecutor` on the treasury)                                      |
| `sweep.configure` | `PUT /v1/accounts/{id}/sweep-rule` (the `SweepExecutor`)                                           |
| `vault.withdraw`  | Early withdrawal from a time-locked vault                                                          |
| `payment`         | A payment whose policy decision is `require_owner`                                                 |
| `account.deploy`  | Deploying an account                                                                               |
| `owner.swap`      | `POST /v1/accounts/{id}/owner-swap` (one step of an [owner-key rotation](#rotating-the-owner-key)) |

Resources that need one point to it: a session's `install_operation_id`, a payment's `owner_operation_id`, a sweep rule's `install_operation_id`.

An agent account is deployed by its **setup operation**, the `session.install` of its first session: it deploys the Safe, installs the modules and the `AgentPolicyHook`, and executes the spend key's [float-recovery permit](/concepts/accounts-and-keys#float-recovery-permit) when one is attached.

### Signing

1. Fetch the operation: `GET /v1/owner-operations/{id}` returns `user_op_hash`, `chain_id`, `status` and `expires_at`.
2. Sign the **raw 32 bytes** of `user_op_hash` as an EIP-191 personal message with the owner key (viem: `signMessage({ message: { raw: hash } })`), the format the owner validator expects.
3. Submit: `POST /v1/owner-operations/{id}/signature` with `{ "signature": "0x…" }`.

The status moves `requires_signature` → `submitted` → `succeeded`, or `failed` / `expired` (an unsigned operation expires after 15 minutes by default).

::: code-group

```ts [TypeScript]
// PrincipalClient with an owner signer: checks the chain, signs and submits.
const op = await principal.signOwnerOperation("oop_01JABCDEFGHJKMNPQRSTVWXYZ0", { wait: true });
```

```python [Python]
op = bank.owner_operations.sign_and_submit("oop_01JABCDEFGHJKMNPQRSTVWXYZ0", owner=owner)
```

:::

The console shows pending owner operations and signs them with the owner key.

## Rotating the owner key

A voluntary rotation, while you still hold the current owner key, has two parts, both signed by the **current** key:

1. **On-chain, per account.** `POST /v1/accounts/{id}/owner-swap` with `{ new_owner_address }` prepares an `owner.swap` owner operation that swaps the Safe owner. Sign and submit it for every account in the org, the treasury included.
2. **Off-chain, once.** `POST /v1/orgs/me/owner` with an `owner.rotate` authorization updates the owner key that Agent Bank and the co-signer recognise.

```ts
// Signed by the current owner key (the PrincipalClient's owner signer).
for await (const account of principal.paginate("listAccounts")) {
  await principal.prepareOwnerSwap(account.id, newOwner.address, { wait: true });
}
await principal.rotateOwner(newOwner.address);
```

A **lost** key cannot sign either step. It is recovered on-chain by the guardians you chose, after a 72-hour delay the current owner can cancel, and then off-chain by Agent Bank operators: see [Recovery](/concepts/accounts-and-keys#recovery) and the [owner recovery runbook](/operations/runbooks#owner-recovery).

## Acting without Agent Bank

Owner operations still go through Agent Bank's bundler. The owner never depends on that: the Safe's native `execTransaction` accepts the owner's signature directly and bypasses the ERC-7579 modules and hooks, so the owner can always withdraw with the open-source [exit tool](/concepts/exit-tool), whatever state Agent Bank is in.
