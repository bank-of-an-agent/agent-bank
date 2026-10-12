# Concepts in 5 minutes

Agent Bank is a non-custodial bank for AI agents. This page is the whole model in one read; every section links to the page that goes deeper.

## Who is who

| Customer         | What they are                                                  | What they get                                                                       |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Principal**    | A verified human or company that deploys agents (an _org_)     | KYC/KYB, a console, policies, approvals, statements, and the **owner key**          |
| **Agent**        | Software acting for a principal                                | A smart account, a scoped **session key**, balances, payment, x402 and escrow tools |
| **Counterparty** | A merchant, an API seller or another agent that receives funds | Payment requests, x402 paywalls, escrow release                                     |

Every agent traces back to a verified principal; there are no ownerless agents. An org has members with roles (admin, approver, viewer) and API keys for automation.

## Accounts

Each agent gets one **smart account** per chain: a Safe with the ERC-7579 module adapter on Base Sepolia. The address is counterfactual (CREATE2), so it can receive USDC before it is deployed; it deploys with its first operation. Each org also has a **treasury** account that can top agents up on rules and receive their savings.

Inside an account the ledger keeps **pockets**: `operating` (spendable), `reserved` (held for pending payments), `escrow`, `stream`, `fees`, `savings` and vaults. Pockets are bookkeeping; the USDC sits in the smart account or in Agent Bank's escrow, stream and vault contracts. See [The ledger](/concepts/ledger).

## Three keys

| Key           | Held by                                        | Can do alone                                                      |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| **Owner**     | The principal (passkey, hardware wallet)       | Everything: withdraw all funds, remove the co-signer, rotate keys |
| **Session**   | The agent runtime; generated client-side, 24 h | Nothing: signs inside its on-chain scope, needs the co-signer too |
| **Co-signer** | Agent Bank, in a non-exportable KMS key        | Nothing: approves or refuses agent operations                     |

The on-chain rule is: **valid = owner ∨ (session ∧ co-signer ∧ policy)**. A fourth, low-value key, the **spend key**, holds a small USDC float for x402 pay-per-call payments. See [Accounts and keys](/concepts/accounts-and-keys).

## Limits live in code, not prompts

The principal writes a [policy](/concepts/policies) for each agent: caps per transaction and per rolling day, week and month; counterparty allowlists and denylists (addresses, agent ids, ERC-8004 ids, x402 domains); a cooling period for new counterparties; velocity limits; time windows; approval thresholds; a maximum balance. The policy engine is a pure, deterministic function; no language model sits in the decision path.

Limits are enforced **twice**: by the co-signer, which re-evaluates its own copy of the policy against its own spend history before every signature, and by the session key's **on-chain scope** (per-transaction and daily caps, allowed recipients and contracts, expiry), which holds even if every Agent Bank system were compromised.

Policy changes are asymmetric: **tightening applies immediately; loosening needs the owner's signature and waits one hour**, so a stolen admin session cannot quietly raise limits. A [mandate](/concepts/mandates) (AP2) adds signed, auditable proof that a human authorized a class of spending.

## Money

USDC is the only asset in v1. On the wire, money is a decimal string plus an asset code (`{ "amount": "25.00", "asset": "USDC" }`); inside, it is an integer number of minor units (6 decimals). There are no floats anywhere. Every write takes an `Idempotency-Key`, so retrying never pays twice.

## What happens when an agent pays

```text
agent ──POST /v1/payments──▶ API ──dry run──▶ co-signer policy
                              │ hold amount + fee in the ledger
                              ◀── requires_signature (user_op_hash) ── or requires_approval / denied
agent signs user_op_hash ──▶ API ──▶ co-signer re-checks policy, co-signs (or refuses)
                              │ submit via the ERC-4337 bundler
                              ▼
                    smart account verifies both signatures and the session scope
                              │
                    indexer sees the transfer ──▶ ledger posts the hold ──▶ settled
```

A payment moves through `requires_approval` (a human must approve, 15 minutes), `requires_signature`, `submitted` and `settled`, or ends `denied`, `failed`, `canceled` or `expired`. The SDKs and the MCP server run the whole flow in one call. See [Your first payment](/get-started/first-payment).

## What an agent can and cannot do

An agent authenticates with its session key and can check balances, dry-run spends, pay, pay for APIs with x402, request payments, open escrows and streams, and read its ledger. It **cannot** loosen its own policy, unfreeze itself, withdraw to the owner or install sessions: those need the owner key, which the agent never holds. The [MCP server](/guides/mcp-server) exposes money tools only.

## Fail closed

If the co-signer, the policy store, wallet screening or the database is unavailable, payments stop (`cosigner_unavailable`, `screening_unavailable`, HTTP 503) rather than pass. Owners can still act alone with their key, and the open-source [exit tool](/concepts/exit-tool) withdraws funds without Agent Bank at all.

## Next

1. Run the [local sandbox](/get-started/sandbox).
2. Do the [principal setup](/get-started/principal-setup): org, agent, account, policy, session.
3. Make [your first payment](/get-started/first-payment) and [your first x402 call](/get-started/first-x402-call).
