# Principal setup

This walkthrough creates everything an agent needs, in the order the API requires it:

**org → agent → account → policy → session grant → owner operation**

You act as the _principal_. You need an org API key for the API calls and your **owner key** for the signatures only an owner can give. In the sandbox the owner key can be a throwaway testnet private key; in production it is a passkey or hardware wallet that signs EIP-712 messages, and Agent Bank never sees it. The [console](/get-started/sandbox#_4-start-the-services) does the same steps with passkeys if you prefer a UI.

The code is the TypeScript SDK; the Python SDK has the same steps (see the second tab). Install the SDK first: in this repository it is the workspace package `@agentbank/sdk`; outside it, `npm install @agentbank/sdk viem` once the package is published.

<!-- verify: npm package names (@agentbank/sdk, agentbank on PyPI) once published -->

## 1. Create the org

Sign-up is a public route. It returns the org and its first admin API key; the secret is shown once, so store it in your secret manager. The org records your owner key's address: it is the only key that can loosen limits or move funds without Agent Bank.

::: code-group

```ts [TypeScript]
import { AgentBankClient, PrincipalClient, signerFromPrivateKey } from "@agentbank/sdk";

const baseUrl = process.env.AGENTBANK_API_URL ?? "http://localhost:8080";
// Testnet only. In production the owner key is a passkey or hardware wallet (see OwnerSigner).
const owner = signerFromPrivateKey(process.env.AGENTBANK_OWNER_KEY!);

const { org, api_key } = await new AgentBankClient({ baseUrl }).orgs.create({
  legal_name: "Example Research Ltd",
  kind: "company",
  country: "GB",
  contact_email: "ops@example.test",
  owner_address: owner.address,
});
console.log(org.id, org.kyc_status); // sandbox KYB approves automatically

const principal = new PrincipalClient({ baseUrl, apiKey: api_key.secret, owner });
```

```python [Python]
from agentbank import AgentBank, SessionKey

owner = SessionKey.from_env("AGENTBANK_OWNER_KEY")  # testnet only

with AgentBank() as public:  # AGENTBANK_BASE_URL, default http://localhost:8080
    signup = public.orgs.create(
        legal_name="Example Research Ltd",
        kind="company",
        country="GB",
        contact_email="ops@example.test",
        owner_address=owner.address,
    )

bank = AgentBank(api_key=signup.api_key.secret)
```

:::

## 2. Create an agent

An agent is a named software identity. It can carry an ERC-8004 id and an agent card URL; its `did` (a `did:pkh`) is filled in once it has an account.

::: code-group

```ts [TypeScript]
const agent = await principal.agents.create({
  name: "research-bot",
  description: "Buys datasets and API calls",
  metadata: { team: "research" },
});
```

```python [Python]
agent = bank.agents.create(name="research-bot", description="Buys datasets and API calls")
```

:::

## 3. Create its account

One smart account per agent per chain. The address is computed counterfactually, so you can fund it right away; it deploys with its **setup operation**, the install of its first session in step 5.

Generate the agent's x402 **spend key** now. It pays x402 calls from a small float outside the account (see [Accounts and keys](/concepts/accounts-and-keys#the-spend-key)), so it also signs a **float-recovery permit**: a USDC allowance to the account that lets you sweep the float back without the agent. The permit names the account's address, so the account comes first; `provisionSpendKey` then signs the permit and attaches both with `PUT /v1/accounts/{id}/spend-key`. The setup operation executes the permit on-chain.

::: code-group

```ts [TypeScript]
import { generateSpendKey } from "@agentbank/sdk";

const { chain } = await principal.meta(); // "simulated" in the sandbox, "base-sepolia" on testnet
const created = await principal.accounts.create(agent.id, { chain });
const spendKey = generateSpendKey();
const account = await principal.provisionSpendKey(created.id, spendKey.account);
console.log(account.spend_key_permit); // "pending" until the setup operation runs
console.log(`fund ${account.address} with test USDC`);
```

```python [Python]
from agentbank import generate_spend_key

spend_key = generate_spend_key()
account = bank.accounts.create(agent.id, spend_key_address=spend_key.address)
```

:::

`principal.setupAgentAccount({ agentId, chain, spendKey, session })` does this step and step 5 in one call, in the right order.

The Python SDK registers the spend key when it creates the account but cannot sign the permit yet, so `spend_key_permit` stays `none` and only the spend key itself can move the float.

<!-- verify: Python SDK support for the spend-key permit (attachSpendKey / PUT /v1/accounts/{id}/spend-key) -->

## 4. Set the policy

An agent without a policy can spend nothing. The first policy is signed by the owner key (it is a loosening from "deny everything") but takes effect at once. Later changes that tighten apply immediately; changes that loosen wait one hour. See [Policies](/concepts/policies) for every rule.

::: code-group

```ts [TypeScript]
await principal.setPolicy(agent.id, {
  limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
  counterparties: {
    mode: "allowlist",
    addresses: ["0x2222222222222222222222222222222222222222"],
    x402_domains: ["api.example-data.com", "localhost"],
  },
  velocity: { max_per_minute: 30 },
  approvals: [{ above: "100.00", approvers: 1 }],
  max_balance: "500.00",
});
```

```python [Python]
bank.policies.put(
    agent.id,
    policy={
        "limits": {"per_tx": "25.00", "per_day": "200.00", "per_month": "2000.00"},
        "counterparties": {
            "mode": "allowlist",
            "addresses": ["0x2222222222222222222222222222222222222222"],
            "x402_domains": ["api.example-data.com", "localhost"],
        },
        "velocity": {"max_per_minute": 30},
        "approvals": [{"above": "100.00", "approvers": 1}],
        "max_balance": "500.00",
    },
    owner=owner,
)
```

:::

`setPolicy` normalizes the document with the policy schema, signs an EIP-712 `OwnerAuthorization` (action `policy.loosen`) over its canonical JSON, and calls `PUT /v1/agents/{id}/policy`. The response shows the `current` version and any `pending` loosening with its `effective_at`.

## 5. Grant a session key

The session key is the agent's own key. Generate it where the agent runs and share only its address; here both sides run in one script for brevity. The **scope** is enforced on-chain by the Smart Sessions module: a per-transaction cap, a daily cap, optional recipient and contract allowlists, and an expiry (24 hours by default, 7 days at most).

`grantSession` does three things: it signs a `session.grant` owner authorization over `{ account_id, public_key, scope }` and registers the session (`POST /v1/sessions`), asks the API to prepare the on-chain install (`POST /v1/sessions/{id}/install`), and signs that **owner operation** with the owner key. This first install is the account's setup operation: it deploys the Safe, installs the modules and executes the spend key's permit, after which `account.spend_key_permit` is `executed`.

::: code-group

```ts [TypeScript]
import { generateSessionKey } from "@agentbank/sdk";

const sessionKey = generateSessionKey();
const { session, installOperation } = await principal.grantSession({
  accountId: account.id,
  publicKey: sessionKey.address,
  scope: { max_per_tx: "25.00", max_per_day: "200.00" },
  ttlSeconds: 24 * 60 * 60,
  waitForInstall: true,
});
console.log(session.status, installOperation?.status); // "active", "succeeded"
```

```python [Python]
from datetime import datetime, timedelta, timezone
from agentbank import generate_session_key

session_key = generate_session_key()
session = bank.sessions.create(
    account_id=account.id,
    public_key=session_key.address,
    scope={
        "max_per_tx": "25.00",
        "max_per_day": "200.00",
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=24),
    },
    owner=owner,
)
session = bank.sessions.install(session.id)
if session.install_operation_id is not None:
    bank.owner_operations.sign_and_submit(session.install_operation_id, owner=owner)
```

:::

## 6. The owner operation

An [owner operation](/concepts/owner-operations) is an on-chain action only the owner key can authorize: the API prepares the ERC-4337 user operation (it knows the account, nonce, gas and paymaster) and returns its `user_op_hash`; the owner signs the raw 32 bytes of the hash as an EIP-191 personal message; `POST /v1/owner-operations/{id}/signature` submits it. No co-signer is involved: the owner key alone can always act on its account. Installing a session, configuring auto top-up or the treasury sweep, withdrawing early from a locked vault and payments that policy marks `require_owner` all use this flow.

If you sign elsewhere (a hardware wallet, the console), fetch the operation, sign `user_op_hash` and submit:

```ts
const op = await principal.ownerOperations.retrieve(session.install_operation_id!);
const signed = await principal.signOwnerOperation(op, { wait: true });
console.log(signed.status, signed.tx_hash);
```

## 7. Hand the keys to the agent

The agent needs its account id, its session id, its session key and its spend key, and nothing else: never an API key, never the owner key. The TypeScript SDK writes keys to a file readable only by you (mode 0600) that the examples and the MCP server read:

::: code-group

```ts [TypeScript]
import { FileKeyStore } from "@agentbank/sdk/node";

const store = new FileKeyStore({ path: ".agentbank/agent.keystore.json" });
await store.set(`session:${session.id}`, sessionKey.privateKey);
await store.set("spend", spendKey.privateKey);
console.log(`export AGENTBANK_ACCOUNT_ID=${account.id} AGENTBANK_SESSION_ID=${session.id}`);
```

```python [Python]
from pathlib import Path

Path(".agentbank").mkdir(exist_ok=True)
session_key.save(Path(".agentbank/session.json"))  # mode 0600
spend_key.save(Path(".agentbank/spend.json"))
print(f"export AGENTBANK_ACCOUNT_ID={account.id} AGENTBANK_SESSION_ID={session.id}")
```

:::

The file stores testnet keys in plain text and the store refuses to read it if group or others can access it. In production, load the keys from your secret manager into `AGENTBANK_SESSION_KEY` and `AGENTBANK_SPEND_KEY` instead. The Python SDK saves each key to its own 0600 JSON file (`session_key.save(path)`), a different format; pass Python-generated keys to TypeScript tools through those variables.

## Fund the account

Send test USDC to `account.address`. On Base Sepolia use [Circle's faucet](https://faucet.circle.com). Agents refill their x402 float from the account with a payment to their own spend key (kind `refill`, no fee, still within policy). Set up [auto top-up](/concepts/savings#auto-top-up) to refill the agent itself from the org treasury.

<!-- verify: how test USDC is minted to accounts on the simulated chain in the local sandbox -->

## Next

[Your first payment](/get-started/first-payment).
