# Security model

The security model starts from one assumption: **every agent will eventually be prompt-injected, and every single key will eventually leak.** No single failure may move funds beyond a session's on-chain scope, and no Agent Bank failure (an outage, an insider, a shutdown) may stop an owner from exiting.

## Non-negotiables

Code review rejects any change that weakens these:

1. **Non-custodial.** No code path, upgrade path or admin function lets the co-signer, or any bank-held key, move funds alone. Bank keys can only _refuse_ (the co-signer) or _trigger_ moves between a principal's own accounts that the owner configured (the top-up and sweep executors).
2. **Testnet only** until the Phase 5 gate. `assertTestnet()` refuses mainnet chain ids in every SDK and service, the database refuses mainnet accounts, and the deploy scripts revert on Base mainnet.
3. **Money is integer minor units** end to end. Linting bans floating point in the money packages.
4. **Every write is idempotent.**
5. **Fail closed.** If the co-signer, the policy store, screening or the database is unavailable, payments stop (`cosigner_unavailable`, `screening_unavailable`).
6. **No LLM in the decision path.** Policy evaluation is a pure, deterministic function.
7. **Secrets never enter the repository, logs or prompts.** Configuration comes from environment variables populated by the secret manager, and logs redact keys, signatures and API keys.

## Trust boundaries

| Boundary                        | Control                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent runtime ↔ API             | [RFC 9421 signatures](/guides/request-signing) by the session key (300-second lifetime, single-use nonce), per-session scope |
| API account ↔ co-signer account | Private networking and an HMAC-authenticated internal API; the co-signer re-derives everything from the raw user operation   |
| Off-chain ↔ on-chain            | The session scope and the policy hook enforce limits even if every off-chain system is compromised                           |
| Principal ↔ Agent Bank          | The owner key never leaves the principal; owner operations; the [exit tool](/concepts/exit-tool)                             |

The co-signer and policy engine run in a **separate cloud account** from the API, and the indexer in a third, so a compromise of the public API cannot reach signing keys. A compromised API can ask the co-signer to sign, but the co-signer recomputes the operation hash from the raw user operation, decodes what it actually does, verifies the agent's session signature, and evaluates its **own copy** of the policy against its **own spend history**. It refuses anything that does not match the stated intent.

## Threats and controls

| Threat                                                      | Primary control                                                                                                                 | Backstop                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A prompt-injected agent overspends or pays an attacker      | Policy engine (caps, allowlists, velocity, cooling period, mandate) and the on-chain session scope                              | Approvals above thresholds; velocity limits; freeze                                        |
| A stolen session key                                        | 24-hour expiry, narrow scope, the co-signature is still required                                                                | Anomaly freeze; the owner revokes the session on-chain                                     |
| A compromised co-signer key                                 | Useless alone; non-exportable KMS key; rotation runbook                                                                         | Session plus co-signer is still bounded by the on-chain scope                              |
| A compromised API asks the co-signer to sign something else | The co-signer decodes the raw operation and re-evaluates its own policy and history                                             | Hash-chained audit log; anomaly alerts                                                     |
| A stolen admin session loosens limits                       | Loosening needs the owner's signature and a 1-hour delay                                                                        | Notifications on every policy change; freeze                                               |
| Agent Bank outage, insider or shutdown                      | Agent Bank cannot move funds by design                                                                                          | The exit tool withdraws with the owner key alone                                           |
| A malicious x402 seller or overcharge                       | The challenge is checked against policy and per-domain caps; client-side `maxAmountPerRequest`                                  | Facilitator nonce, expiry and replay checks; settle-before-serve above $1                  |
| x402 verify/settle split bugs, EIP-3009 front-running       | Single-use authorization table plus on-chain `authorizationState`; settle before serving above $1                               | Short validity windows                                                                     |
| A smart contract bug                                        | Audited Safe, ERC-7579 and Smart Sessions; minimal custom contracts with fuzz and invariant tests                               | Two audits, a bug bounty, a $1,000 per-account cap in the beta, pause of new deposits only |
| Sanctioned or illicit funds                                 | Wallet-risk screening of every counterparty and deposit, failing closed                                                         | The co-signer refuses; account review                                                      |
| A phished principal admin                                   | Passkeys; hardware keys for owner actions                                                                                       | Loosening delay; notifications                                                             |
| A lost or stolen owner key                                  | [Guardian recovery](/concepts/accounts-and-keys#recovery) after a 72-hour time lock; Agent Bank never holds a guardian majority | The owner cancels a recovery they did not start; freeze; the owner recovery runbook        |
| Ledger and chain drift                                      | Continuous reconciliation within 20 blocks                                                                                      | Suspense account; sessions paused; nightly balance check                                   |
| Replayed agent requests                                     | Signatures live at most 300 seconds with a single-use nonce                                                                     | Idempotency keys on every write                                                            |
| An idempotency key reused with a different request          | The request hash is stored with the key; a mismatch returns 409                                                                 | —                                                                                          |
| A reorg double-credits a deposit                            | Large deposits post only at finality; reorgs reverse entries                                                                    | Suspense and alert                                                                         |
| A mainnet deployment by mistake                             | `assertTestnet`, a database constraint, deploy-script guards, Terraform validation                                              | The human gate at Phase 5                                                                  |

## Operational controls

- A **hash-chained audit log** of every policy decision, approval, co-signature and admin action, exported to write-once storage.
- The co-signer targets p99 decision latency under 300 ms and 99.9% monthly availability, and fails closed.
- Separate cloud accounts for the co-signer, the API and the indexer; no human holds production signing material.
- [Incident runbooks](/operations/runbooks) for key compromise, contract pause, reconciliation mismatch, mass freeze and owner recovery.
- SOC 2 Type I readiness is targeted for six months after public launch.

## Residual risks, accepted for the beta

- Approvals are attested by the API, not verified by the co-signer ([ADR 0012](/operations/adrs)); hard caps still hold.
- A fully compromised agent can spend its x402 spend-key float ([ADR 0001](/operations/adrs)).
- The guardian rules (a strict majority, at most one Agent Bank seat) are enforced by provisioning and monitoring, not by the recovery module; an owner can weaken them with their own signature ([ADR 0013](/operations/adrs)).
- USDC's issuer can freeze an address; that is outside Agent Bank's control and disclosed in the terms.
- Counsel has not yet confirmed that the co-signer model is not money transmission ([Regulatory posture](/concepts/regulatory-posture)).

The full threat model, with the tests and evidence behind each control, is [`docs/threat-model.md`](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/threat-model.md). Report vulnerabilities privately as described in the organization's [security policy](https://github.com/bank-of-an-agent/.github/blob/main/SECURITY.md).
