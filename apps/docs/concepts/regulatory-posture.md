# Regulatory posture

::: danger Not legal advice
This page describes how Agent Bank is designed and why. It is not legal advice, the posture it describes has **not yet been confirmed by counsel**, and it may change. Agent Bank is pre-release software on a testnet.
:::

## What Agent Bank is, and is not

Agent Bank is designed to launch as **non-custodial software**, not as a licensed bank or a money transmitter, because it never holds a key that can move customers' funds by itself. The principal holds the owner key; Agent Bank holds a co-signing key that can only approve or refuse an agent's operation, inside limits the owner installed on-chain. Despite the name, Agent Bank is **not a bank**: it takes no deposits, holds no customer funds and pays no interest.

This is the single most important architecture decision in the project, and it must be reviewed by crypto-specialist counsel before mainnet. Until then the platform runs only on the Base Sepolia testnet, with test USDC.

| Model                | What it means                                                                               | Licensing burden                                                         | Choice     |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| Custodial            | The provider holds keys and moves funds for users                                           | Money-transmitter registration and licences; a charter for true deposits | Not for v1 |
| **Policy co-signer** | The principal holds the owner key; the provider holds a key that can only approve or refuse | Lowest, relying on the provider being unable to move funds unilaterally  | **v1**     |
| Pure software        | An SDK only, no provider-run signer                                                         | Lowest, but no enforceable limits or ledger                              | Too weak   |

Why the co-signer model is expected to hold up: pending US legislation (the CLARITY Act's Section 604, the Blockchain Regulatory Certainty Act) would codify that non-custodial developers who do not control user funds are not money transmitters, but it was not law when the design was written; today the position rests on existing guidance on unhosted and multi-signature wallets, which counsel must confirm applies.

## Lines the design never crosses

If any of these changed, the posture would change with it, so they are hard constraints in the code and in review:

- **No bank key can move funds alone**, including through an upgrade path or an admin function. Bank keys can only refuse (the co-signer) or trigger owner-configured moves between a principal's own accounts (the executors).
- **No pooled or omnibus wallets.** Every agent has its own on-chain account.
- **No fiat on- or off-ramp run by Agent Bank.** Licensed third-party ramps can be integrated instead.
- **No yield paid by Agent Bank and no pooled savings.** Any return comes from a fund the owner selects, and only after counsel signs off ([Savings and treasury](/concepts/savings#treasury-sweep)).
- **No credit** until a separate legal review of lending licences.
- **No mainnet** until the Phase 5 gate: legal sign-off, closed audits, a verified exit tool and an on-call rotation.

## Compliance done as a matter of risk

Even as software, Agent Bank does the following as risk management rather than to meet a licence:

- **KYC/KYB of principals** through a vendor; every agent traces back to a verified principal, and there are no ownerless agents.
- **Sanctions and wallet-risk screening** of every counterparty and deposit; when screening is unavailable, payments stop.
- **Terms of service** that make the principal liable for its agents.

USDC is the settlement asset. Rules under the GENIUS Act for stablecoin issuers were still largely pending in 2026; they bind issuers rather than Agent Bank directly. The issuer can freeze an address, which is outside Agent Bank's control.

## Open questions for counsel

- Whether the co-signer model is money transmission.
- Broker-dealer and investment-adviser questions raised by an owner-directed sweep into tokenized Treasury funds; mitigations are a neutral eligibility list with no recommendations, owner-only selection, and a flat plan fee instead of a fee on balances if required.
- The legal entity and the product name: "bank" is a regulated word in many places, so the legal name should avoid it.

These are tracked as open decisions in the [design document](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/design.md#open-decisions-and-risks).
