# Python SDK

`agentbank` is the Python client for Agent Bank, in its own repository: [`bank-of-an-agent/sdk-python`](https://github.com/bank-of-an-agent/sdk-python). It is generated from the same OpenAPI document as these pages and shares the cross-language test vectors with the TypeScript SDK, so its request signatures and owner authorizations are byte-for-byte identical. It needs Python 3.10 or later and depends on `httpx`, `pydantic` v2 and `eth-account`.

```bash
pip install agentbank        # or: uv add agentbank
```

::: tip Not on PyPI yet
Until `agentbank` is published, install it from GitHub: `uv add "agentbank @ git+https://github.com/bank-of-an-agent/sdk-python"` (or the same with `pip install`).
:::

## Clients

`AgentBank` is synchronous and `AsyncAgentBank` asynchronous, with the same methods. One client holds whichever credentials you give it, and each operation uses the credentials it accepts:

| Argument          | Environment variable        | Used for                                                                   |
| ----------------- | --------------------------- | -------------------------------------------------------------------------- |
| `api_key`         | `AGENTBANK_API_KEY`         | Principal operations (`abk_test_…`)                                        |
| `session_id`      | `AGENTBANK_SESSION_ID`      | Agent operations (`ses_…`)                                                 |
| `session_key`     | `AGENTBANK_SESSION_KEY`     | Signing agent requests and operations                                      |
| `spend_key`       | `AGENTBANK_SPEND_KEY`       | Signing x402 payments                                                      |
| `account_id`      | `AGENTBANK_ACCOUNT_ID`      | Default account for agent operations                                       |
| `base_url`        | `AGENTBANK_BASE_URL`        | API base URL (default `http://localhost:8080`)                             |
| `facilitator_url` | `AGENTBANK_FACILITATOR_URL` | x402 facilitator (default: `base_url`)                                     |
| `chain_id`        |                             | EIP-712 chain id for owner authorizations (default 84532; mainnet refused) |

Also `timeout` (seconds, default 30), `max_retries` (default 2), `signature_lifetime_seconds`, `default_headers` and your own `http_client`. Use the clients as context managers to close their connections.

```python
from agentbank import AgentBank, SessionKey

# Principal
with AgentBank(api_key="abk_test_…") as bank:
    agent = bank.agents.create(name="research-bot")

# Agent: session id, key and account from the environment
with AgentBank(session_key=SessionKey.load(".agentbank/session.json")) as agent:
    payment = agent.pay(to="0x2222222222222222222222222222222222222222", amount="2.50", memo="dataset")
```

## Resources

Every API operation has a method on a resource namespace: `orgs`, `api_keys`, `members`, `agents`, `accounts`, `sessions`, `owner_operations`, `mandates`, `policies`, `payments`, `payment_requests`, `x402`, `escrows`, `streams`, `approvals`, `ledger`, `vaults`, `treasury`, `webhooks`, `billing`, `proofs`, plus `health()`. Responses are Pydantic models generated from the OpenAPI document (`agentbank.models`). Lists return a page (`data`, `next_cursor`) and have a `list_all()` iterator that follows the cursor.

High-level helpers do the multi-step flows:

| Method                                                       | Does                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `client.pay(to=…, amount=…, wait_for_settlement=True)`       | Create, sign with the session key, submit, wait (also `payments.pay`) |
| `escrows.lock(…)`, `streams.start(…)`                        | Create and sign an escrow or a stream                                 |
| `escrows.release / refund / dispute`, `streams.cancel`       | Escrow and stream actions                                             |
| `approvals.approve(id)`, `approvals.deny(id)`                | Decide an approval                                                    |
| `owner_operations.sign_and_submit(id, owner=…)`              | Sign an owner operation's `user_op_hash` and submit it                |
| `client.call("operationId", path_params=…, query=…, body=…)` | Any operation by its OpenAPI id                                       |

Amounts are decimal strings (or `Decimal`); `agentbank.money("2.50")` builds a `Money`. Money is never a float.

## Owner-signed changes

Methods that need the owner accept `owner=` (a key, used for testnet development) or `owner_authorization=` (a signature made elsewhere):

```python
owner = SessionKey.from_env("AGENTBANK_OWNER_KEY")  # testnet development only
bank.policies.put(agent.id, policy={"limits": {"per_day": "300.00"}}, owner=owner)
```

For a hardware wallet, build the EIP-712 message with `owner_authorization_typed_data(...)`, sign it on the device and pass the result as `owner_authorization=`; `owner_authorize(...)` and `verify_owner_authorization(...)` are the lower-level helpers.

## Keys

```python
from agentbank import generate_session_key, generate_spend_key

session_key = generate_session_key()          # SessionKey(private_key hidden from repr, address)
session_key.save(".agentbank/session.json")   # mode 0600; refuses to overwrite unless overwrite=True
same = SessionKey.load(".agentbank/session.json")
```

`SessionKey.from_env("AGENTBANK_SESSION_KEY")` loads a key populated by your secret manager. Anything implementing `EthSigner` (an `eth_account` account, a KMS or hardware adapter) can sign instead of a raw key.

## x402

```python
from agentbank import X402Error, x402_receipt

with agent.x402.client(max_amount="0.10", allowed_domains={"api.example-data.com"}) as http:
    response = http.get("https://api.example-data.com/v1/report?ticker=ACME")
    receipt = x402_receipt(response)  # what was paid, if anything
```

`agent.x402.client()` is an `httpx.Client` whose transport pays 402 challenges; `agent.x402.transport()` gives you the transport for your own client, and `agent.x402.fetch(url, max_amount=…)` fetches one URL. It parses x402 v2 headers and v1 bodies, refuses prices above `max_amount` and domains outside `allowed_domains`, checks the authorization Agent Bank returns against the challenge, and signs it with the spend key. See [x402: pay for APIs](/guides/x402-buyer).

## Private proofs

An agent proves facts Agent Bank attests about it without revealing which agent it is. Python verifies proofs in pure Python and proves through the `agentbank-prove` CLI of the TypeScript monorepo, which needs Node.js:

```python
# AGENTBANK_PROOF_SECRET=<generate_proof_secret(), kept secret>
# AGENTBANK_PROVER="node /path/to/agent-bank/packages/proofs/bin/agentbank-prove.mjs"
agent.proofs.enroll()  # once: registers Poseidon(secret), never the secret
with agent.x402.client(max_amount="0.10") as http:
    response = http.get("https://api.seller.example/v1/report")  # answers the 401, then the 402
```

Owners enable proofs with `bank.proofs.update_settings(agent_id, enabled=True, disclose=[...], owner=owner)`; sellers gate routes with `bank.proofs.gate(...)` (`agentbank.proofs.ProofGate`). See [Prove facts as an agent](/guides/proofs-agent) and [Require proofs as a seller](/guides/proofs-verifier).

## Errors

API errors map to exceptions by code, all subclasses of `AgentBankError` with `.code`, `.status` and `.detail`:

| Exception                                                                    | Codes                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `BadRequestError`                                                            | `invalid_request`, `invalid_amount`, `unsupported_*`                       |
| `AuthenticationError`, `SignatureVerificationError`                          | `unauthorized`, `signature_invalid`, `session_*`                           |
| `PermissionDeniedError`, `OwnerSignatureRequiredError`, `MainnetLockedError` | `forbidden`, `owner_signature_required`, `feature_gated`, `mainnet_locked` |
| `NotFoundError`                                                              | `not_found`                                                                |
| `ConflictError`, `IdempotencyConflictError`                                  | `conflict`, `idempotency_conflict`, `invalid_state`, `approval_expired`    |
| `InsufficientFundsError`, `PolicyDeniedError`                                | `insufficient_funds`, `policy_denied` (422)                                |
| `FrozenError`                                                                | `agent_frozen`, `org_frozen`                                               |
| `RateLimitError`                                                             | `rate_limited`                                                             |
| `InternalServerError`, `ServiceUnavailableError`                             | `internal`, `chain_error`, `cosigner_unavailable`, `screening_unavailable` |
| `APIConnectionError`, `APITimeoutError`                                      | No response arrived                                                        |
| `PaymentError` (`PaymentDeniedError`, `PaymentFailedError`)                  | A payment that ended `denied` or `failed` while waiting                    |
| `X402Error`                                                                  | An x402 payment could not be made                                          |
| `ProofError` (`ProofRefusedError`, `ProverError`, `ProofRequestError`)       | A private proof was not made or was refused (`.reason`)                    |

## Webhooks

```python
from agentbank import SignatureVerificationError, construct_event

event = construct_event(secret, raw_body, request.headers.get("agentbank-signature"))
```

See [Webhooks](/guides/webhooks) for a complete receiver.

## Async

```python
import asyncio
from agentbank import AsyncAgentBank

async def main() -> None:
    async with AsyncAgentBank() as agent:
        balances, page = await asyncio.gather(
            agent.accounts.balances(),
            agent.payments.list(account_id=agent.account_id, limit=5),
        )
        async for entry in agent.ledger.list_entries_all(limit=50):
            print(entry.id, entry.ref_type)

asyncio.run(main())
```

The repository's `examples/` folder has runnable scripts: `principal_setup.py`, `agent_pay.py`, `x402_fetch.py`, `async_usage.py`, `webhook_receiver.py` and `langchain_tool.py`.
