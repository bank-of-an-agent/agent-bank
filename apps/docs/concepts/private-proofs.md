# Private proofs

An agent can prove facts about itself, such as "a verified company backs me", "I can pay $5 a call" or "$500 is reserved for you until 3 pm", **without revealing which agent it is, which company backs it, or the underlying numbers.** Agent Bank attests the facts, the agent proves them with a zero-knowledge proof, and the verifier learns only that the statement is true.

::: warning Testnet only
The proving keys come from a single-party, testnet-only trusted setup, and the circuit has not been audited. Mainnet needs a public multi-party ceremony and an audit.
:::

## Three products, one proof

| Product                                 | The agent proves                                                                                                                           | Typical verifier                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Agent credentials** (Know Your Agent) | A verified business or person backs it; its per-transaction and daily limits are within a range                                            | Paid APIs, MCP tool providers, marketplaces deciding whom to serve     |
| **Private reputation**                  | At least N settled payments, M completed escrows and C distinct counterparties; no more than K lost disputes; an account older than D days | Task marketplaces and agents choosing whom to hire                     |
| **Proof of funds**                      | At least $X available at the last snapshot, or **$X reserved for this verifier** until time T                                              | Sellers taking bids, agents negotiating before committing to an escrow |

They are the same proof over different facts, so one request can combine them: "a verified company, $500 reserved for me for an hour, and no lost disputes".

## How it works

1. **The owner opts in.** Per agent, the owner enables proofs and chooses which classes of facts may be disclosed: `principal`, `limits`, `balance`, `reservations`, `account_age`, `reputation`. Widening needs an [owner signature](/concepts/owner-operations); narrowing is immediate.
2. **The agent enrolls.** It generates a secret and registers only a commitment to it. Agent Bank never sees the secret, so it cannot prove anything on the agent's behalf.
3. **Agent Bank attests.** At every snapshot (hourly, and at once after changes) Agent Bank computes 13 facts per enrolled agent, hashes them into a Merkle tree and publishes the tree's root to the `AgentAttestationRegistry` contract on Base. The root is public and permanent; the facts are not.
4. **A verifier asks.** A seller answers a request with HTTP `401` and an `AGENT-PROOF-REQUIRED` header: who it is (its scope), a fresh nonce, and the bounds it needs.
5. **The agent proves.** The SDK fetches the agent's witness (its leaf and Merkle path) from Agent Bank, proves locally in about a second, and retries with an `AGENT-PROOF` header.
6. **The verifier checks.** It rebuilds the statement from its own request, checks the root in the registry (published, not revoked, fresh, enough agents in the tree) and verifies the proof: in about 15 ms off-chain, or on-chain with `AgentClaimsVerifier` for roughly a cent of gas.

A resource can require a proof and a payment: the proof comes first (`401`), then [x402](/guides/x402-buyer) (`402`). The SDKs handle both in one call.

## The facts

| Fact                     | Meaning                                                         | Class          |
| ------------------------ | --------------------------------------------------------------- | -------------- |
| `principal_verification` | 0 none, 1 verified individual, 2 verified company               | `principal`    |
| `per_tx_limit`           | Policy cap per transaction (uncapped is the maximum value)      | `limits`       |
| `per_day_limit`          | Policy cap per rolling 24 hours                                 | `limits`       |
| `balance`                | Available USDC at the snapshot, rounded down to whole dollars   | `balance`      |
| `reserved_amount`        | USDC reserved for one verifier                                  | `reservations` |
| `reserved_until`         | When that reservation ends                                      | `reservations` |
| `reserved_for`           | Which verifier it is for (a 64-bit tag of the verifier's scope) | `reservations` |
| `account_created_on`     | Account creation day                                            | `account_age`  |
| `payments_settled`       | Settled outgoing payments                                       | `reputation`   |
| `volume_settled`         | Their total, in whole dollars                                   | `reputation`   |
| `escrows_completed`      | Escrows released to the agent as payee                          | `reputation`   |
| `disputes_lost`          | Disputes resolved with the agent receiving less than half       | `reputation`   |
| `counterparties`         | Distinct counterparties paid or paid by                         | `reputation`   |

The circuit itself enforces the owner's choices: a verifier cannot place any bound, not even a trivial one, on a fact whose class the owner did not disclose.

## Reservations: funds held for one verifier

A balance proof is a snapshot; the agent could spend the money a minute later and show the same proof to everyone. A **reservation** is a commitment:

- The agent reserves an amount for one verifier's scope, for up to 7 days. Agent Bank holds the funds in the agent's `reserved` pocket, so the agent cannot spend them through Agent Bank.
- At the next snapshot the reservation becomes provable, but only to that verifier: the proof compares the reservation's tag with the verifier's own scope, so the same funds cannot be pledged twice.
- The agent cannot cancel early. The owner can, with an owner signature, which also revokes the snapshots that contained it. At expiry the funds return to `operating`.

Agent Bank is [non-custodial](/concepts/regulatory-posture): the owner can still withdraw on-chain at any time. A reservation guarantees that the agent cannot spend the funds through Agent Bank before it ends.

## What stays private

| Who                           | Learns                                                                        | Never learns                                                     |
| ----------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The verifier                  | That the statement is true; a pseudonym that is stable for this verifier only | Which agent, account, organization or address; the actual values |
| Two verifiers comparing notes | Nothing more: pseudonyms differ per verifier                                  | Whether two proofs came from the same agent                      |
| Agent Bank                    | Who enrolled, the facts it attested, which verifier a reservation is for      | Which verifier an agent proved to otherwise, or the pseudonyms   |
| Anyone reading Base           | Roots, snapshot times, how many agents each tree contains                     | Any agent or fact                                                |

Limits worth knowing:

- **Payments are not private.** If the agent pays the verifier afterwards, the payment is on-chain and linked to its account. Proofs keep the facts private; they do not anonymize payments.
- **Verifiers trust Agent Bank as the attester.** A proof shows Agent Bank attested the facts. The attester key can move no funds, every root is public, and the registry's owner can rotate the key and revoke roots.
- **The crowd is the tree.** A proof hides the agent among the agents in that snapshot. Verifiers require a minimum (16 by default).

See the full design in [`docs/private-proofs.md`](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/private-proofs.md) and the decision in [ADR 0014](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/adr/0014-private-proofs.md).
