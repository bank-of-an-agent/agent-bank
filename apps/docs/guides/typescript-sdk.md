# TypeScript SDK

`@agentbank/sdk` is the TypeScript client for Agent Bank. It is typed directly from the API's route registry, so its request and response types cannot drift from the server. It runs in Node 20 or later and in modern browsers, depends only on `viem` and `zod`, and ships ESM and CommonJS builds.

```bash
npm install @agentbank/sdk viem
```

::: tip Not on npm yet
`@agentbank/sdk` is not published yet. Inside this repository, depend on the workspace package (`"@agentbank/sdk": "workspace:*"`); elsewhere, build it with `pnpm --filter @agentbank/sdk build` and install the packed tarball (`pnpm --filter @agentbank/sdk pack`).
:::

Inside this repository it is the workspace package `packages/sdk-ts`; its `examples/` folder has runnable scripts for the principal setup, an agent payment, an x402 fetch and a seller paywall.

| Entry point                   | Contents                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@agentbank/sdk`              | `AgentBankClient`, `AgentClient`, `PrincipalClient`, keys and signers, owner authorizations, errors, the x402 client, webhooks, types                  |
| `@agentbank/sdk/x402-server`  | `createPaywall` and adapters for Express, Node `http`, Fastify, Hono and Web `Request`/`Response`                                                      |
| `@agentbank/sdk/proof-server` | `createProofGate`, the requirement builders, `verifyPresentation`, root resolvers and the same adapters, for [private proofs](/guides/proofs-verifier) |
| `@agentbank/sdk/node`         | `FileKeyStore`, a 0600 key file (Node only)                                                                                                            |

## Three clients

| Class             | For                      | Credentials                                                 |
| ----------------- | ------------------------ | ----------------------------------------------------------- |
| `AgentBankClient` | Any operation, low level | An API key, a session, or neither for public routes         |
| `PrincipalClient` | The human or company     | Org API key, plus the owner signer for owner-signed changes |
| `AgentClient`     | The agent                | Session id and session key, plus the spend key for x402     |

All three share the same options and resource namespaces; `PrincipalClient` and `AgentClient` add high-level flows.

```ts
import { AgentBankClient } from "@agentbank/sdk";

const client = new AgentBankClient({
  baseUrl: "http://localhost:8080", // default
  apiKey: process.env.AGENTBANK_API_KEY, // principal routes: Authorization: Bearer abk_…
  timeoutMs: 30_000, // per attempt
  maxRetries: 2, // on network errors, timeouts, 429 and 5xx (safe requests only)
  validateRequests: true, // check params, query and body against the contract before sending
});
```

### Resource namespaces

Every API operation has a method, grouped like the API tags: `orgs`, `apiKeys`, `members`, `agents`, `accounts`, `sessions`, `ownerOperations`, `mandates`, `policies`, `payments`, `paymentRequests`, `x402`, `escrows`, `streams`, `approvals`, `ledger`, `vaults`, `treasury`, `webhooks`, `billing`, `proofs`, plus `client.meta()` and `client.health()`.

```ts
const agent = await client.agents.create({ name: "research-bot" });
const balances = await client.accounts.balances("acct_01JABCDEFGHJKMNPQRSTVWXYZ0");
const page = await client.payments.list({ account_id: "acct_01JABCDEFGHJKMNPQRSTVWXYZ0", limit: 20 });
```

Every method takes optional per-request options last: `idempotencyKey`, `signal`, `timeoutMs`, `maxRetries`, `headers`.

### Any operation by id

`request(operationId, …)` calls any operation of the route registry with full typing, and `paginate` follows `next_cursor` for list operations. The operation ids are listed in the [API reference](/api/).

```ts
const payment = await client.request("getPayment", { params: { id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ0" } });
for await (const p of client.paginate("listPayments", { query: { status: "settled" } })) {
  console.log(p.id, p.amount.amount);
}
```

## Principals

```ts
import { PrincipalClient, signerFromPrivateKey } from "@agentbank/sdk";

const principal = new PrincipalClient({
  baseUrl,
  apiKey: process.env.AGENTBANK_API_KEY!,
  owner: signerFromPrivateKey(process.env.AGENTBANK_OWNER_KEY!), // testnet; see "Owner signers" below
});
```

| Method                                                                                   | Does                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `setupAgentAccount({ agentId, chain, spendKey, session })`                               | Creates the account, attaches the spend key with its float-recovery permit, then grants and installs the first session |
| `provisionSpendKey(accountId, spendKey)`                                                 | Signs the spend key's float-recovery permit for the account and attaches it (`PUT /v1/accounts/{id}/spend-key`)        |
| `grantSession({ accountId, publicKey, scope, ttlSeconds, waitForInstall })`              | Signs `session.grant`, registers the session, prepares and signs its on-chain install                                  |
| `setPolicy(agentId, policy)`                                                             | Normalizes and signs the policy (`policy.loosen`); tightening applies now, loosening in 1 hour                         |
| `issueMandate(agentId, mandate)`                                                         | Signs an AP2 mandate (`mandate.issue`) and registers it                                                                |
| `unfreezeAgent(agentId, reason)`, `unfreezeOrg(reason)`                                  | Signed unfreeze, effective after the 1-hour delay                                                                      |
| `setTreasury(accountId)`, `setAutoTopUp(agentId, rule)`, `setSweepRule(accountId, rule)` | Treasury configuration, owner-signed                                                                                   |
| `withdrawVault(vaultId, amount)`                                                         | Vault withdrawal, owner-signed before the unlock date                                                                  |
| `signOwnerOperation(op, { wait })`                                                       | Signs an owner operation's `user_op_hash` and submits it                                                               |
| `prepareOwnerSwap(accountId, newOwner)`, `rotateOwner(newOwner)`                         | Voluntary owner-key rotation: the on-chain swap per account, then `owner.rotate`                                       |
| `authorize({ action, subject, payload })`                                                | Signs any owner authorization                                                                                          |

The EIP-712 chain id comes from `GET /v1/meta` (`owner_authorization_chain_id`), fetched once and cached; set `chainId` to sign without reaching the API.

### Owner signers

The owner key never needs to be a raw private key. Anything that implements `OwnerSigner` works: a viem account, a browser wallet, a hardware wallet or a KMS signer.

```ts
import type { OwnerSigner } from "@agentbank/sdk";

const owner: OwnerSigner = {
  address: account.address,
  signTypedData: (typedData) => walletClient.signTypedData({ account, ...typedData }),
  signMessage: ({ message }) => walletClient.signMessage({ account, message }),
};
```

## Agents

```ts
import { AgentClient } from "@agentbank/sdk";

const agent = new AgentClient({
  baseUrl,
  accountId: "acct_01JABCDEFGHJKMNPQRSTVWXYZ0",
  session: { id: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0", signer: sessionKey },
  spendKey, // optional: needed to pay x402 challenges
  x402: { maxAmountPerRequest: "0.10" },
});
```

| Method                                                                                         | Does                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `balance()`                                                                                    | Balances of the agent's account                                                                                            |
| `checkSpend({ amount, to, x402Domain })`                                                       | Dry-runs the policy (`POST /v1/policy/check`)                                                                              |
| `pay({ to, amount, memo, mandateId }, { waitForSettlement, waitForApproval, idempotencyKey })` | Creates the payment, checks it matches the request, signs the operation with the session key, submits it, optionally waits |
| `completePayment(payment)`, `waitForPayment(id)`                                               | Resumes or waits on a payment                                                                                              |
| `requestPayment({ amount, memo, reference })`                                                  | Creates a payment request with a `pay_link`                                                                                |
| `createEscrow`, `releaseEscrow`, `refundEscrow`, `disputeEscrow`, `completeEscrow`             | [Escrow](/concepts/escrow-and-streams) flows                                                                               |
| `createStream`, `cancelStream`, `completeStream`                                               | [Stream](/concepts/escrow-and-streams#streams) flows                                                                       |
| `fetch(url)`, `fetchWithPayment(url)`, `wrapFetch(fetch)`                                      | [x402](/guides/x402-buyer)-paying fetch; with a `proofSecret`, it answers proof challenges first                           |
| `proofs.enroll()`, `proofs.prove(request)`, `proofs.answer(challenge)`, `proofs.reserve(…)`    | [Private proofs](/guides/proofs-agent): enroll the secret's commitment, prove a request, hold funds for one verifier       |
| `listTransactions()`, `listEntries()`                                                          | Payments and ledger entries of the account                                                                                 |

Every agent request is signed with RFC 9421 over the exact bytes sent and re-signed with a fresh nonce on every retry. Before signing an operation, the SDK checks that what the API prepared matches what you asked for (amount, counterparty; for x402 the payee, amount, token, chain and validity window), and it refuses to sign anything that is not a 32-byte hash, so a compromised API cannot make the session key sign arbitrary data.

## Keys

```ts
import { generateSessionKey } from "@agentbank/sdk";
import { FileKeyStore, loadOrCreateKey } from "@agentbank/sdk/node";

const sessionKey = generateSessionKey(); // { address, privateKey (non-enumerable), account }
const store = new FileKeyStore({ path: ".agentbank/agent.keystore.json" });
await store.set("session:ses_01JABCDEFGHJKMNPQRSTVWXYZ0", sessionKey.privateKey);
const spend = await loadOrCreateKey(store, "spend");
```

`FileKeyStore` writes atomically with mode 0600 in a 0700 directory and refuses to read a key file that group or others can access, like OpenSSH. It stores **testnet keys in plain text**; use your secret manager in production. `MemoryKeyStore` keeps keys in memory for tests and ephemeral agents.

`generateSpendKey()` creates the agent's x402 spend key the same way. Its [float-recovery permit](/concepts/accounts-and-keys#float-recovery-permit) is EIP-2612 typed data: `signSpendKeyPermit({ spendKey, account, chainId, usdc })` signs it (`spendKeyPermitTypedData` returns the typed data for a custom signer), and `PrincipalClient.provisionSpendKey` signs and attaches it in one call. A key that has signed permits before needs its USDC `nonces(spendKey)`, readable with `EIP2612_NONCES_ABI`.

## Errors

Every error is an `AgentBankError` with a stable `code` from the [error catalog](/guides/idempotency-and-errors#error-codes), and API errors are mapped to subclasses:

| Class                              | Codes                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `InvalidRequestError`              | `invalid_request`, `invalid_amount`, `unsupported_asset`, `unsupported_chain` (also thrown before sending) |
| `AuthenticationError`              | `unauthorized`, `signature_invalid`, `session_expired`, `session_revoked`                                  |
| `PermissionDeniedError`            | `forbidden`, `owner_signature_required`, `feature_gated`, `mainnet_locked`                                 |
| `NotFoundError`                    | `not_found`                                                                                                |
| `ConflictError`                    | `conflict`, `idempotency_conflict`, `invalid_state`, `approval_expired`                                    |
| `InsufficientFundsError`           | `insufficient_funds`                                                                                       |
| `PolicyDeniedError`                | `policy_denied`, with `decision.rule_hits`                                                                 |
| `MandateError`                     | `mandate_invalid`, `mandate_expired`                                                                       |
| `FrozenError`                      | `agent_frozen`, `org_frozen`                                                                               |
| `RateLimitError`                   | `rate_limited`, with `retryAfterMs`                                                                        |
| `ServiceUnavailableError`          | `cosigner_unavailable`, `screening_unavailable`                                                            |
| `ChainError`, `PaymentFailedError` | `chain_error`; a payment, escrow or stream that `failed` on-chain                                          |
| `ConnectionError`, `TimeoutError`  | No response arrived                                                                                        |
| `X402Error`                        | An x402 payment could not be made (`reason`)                                                               |
| `ProofError`                       | A private proof was not made or was refused (`reason`)                                                     |

Errors carry `httpStatus`, the raw `problem` document, the `operationId` and the `requestId` to quote in support requests.

## Private proofs

An agent proves facts Agent Bank attests about it without revealing which agent it is. The owner enables it (`principal.proofs.configure(agentId, { enabled, disclose })`, owner-signed when it widens disclosure), the agent enrolls once, and `fetchWithPayment` answers proof challenges before paying:

```ts
import { AgentClient, generateProofSecret } from "@agentbank/sdk";

const proofSecret = generateProofSecret(); // once: store it like a key and reuse it
const agent = new AgentClient({ baseUrl, accountId, session, spendKey, proofSecret });
await agent.proofs.enroll(); // registers Poseidon(secret), never the secret
const { response, proofPresented, nullifier } = await agent.fetchWithPayment(
  "https://api.seller.example/report",
);
```

Sellers gate routes with `@agentbank/sdk/proof-server`. See [Prove facts as an agent](/guides/proofs-agent) and [Require proofs as a seller](/guides/proofs-verifier).

## Webhooks

```ts
import { parseWebhookEvent } from "@agentbank/sdk";

const event = parseWebhookEvent({ secret, body: rawBody, signature: headers["agentbank-signature"] });
if (event.type === "payment.settled") console.log(event.data.id, event.data.amount.amount);
```

See [Webhooks](/guides/webhooks).
