# Threat model

Assumption from the design: **every agent will eventually be prompt-injected and every single
key will eventually leak.** No single failure may move funds beyond a session's on-chain scope,
and no Agent Bank failure (outage, insider, shutdown) may stop an owner from exiting.

## Assets

| Asset                | Where it lives                                                  | Worst case if lost                                     |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| Customer USDC        | Smart accounts, spend-key floats, escrow/stream/vault contracts | Theft or freeze of funds                               |
| Owner key            | Principal's passkey / hardware wallet                           | Full control of that org's accounts (by design)        |
| Co-signer key        | AWS KMS, co-signer account                                      | Nothing alone; with a session key, spend within scope  |
| Session keys         | Agent runtime (client-side)                                     | Nothing alone; with the co-signer, spend within scope  |
| Spend keys           | Agent runtime                                                   | The float (ADR 0001)                                   |
| Ledger and audit log | PostgreSQL, S3 Object Lock export                               | Loss of meaning and evidence; chain is still the truth |
| Policies, mandates   | Co-signer store (authoritative), API (display)                  | Loosened limits                                        |
| Attester key         | KMS (testnet: secret manager), API account                      | False attestations; no funds at risk                   |
| Proof secrets        | Agent runtime (client-side)                                     | Someone else proves the agent's facts                  |
| Proving keys         | `contracts/circuits` (testnet single-party setup)               | Forged proofs (testnet only until a public ceremony)   |

## Actors

Prompt-injected or malicious agent; external attacker with a stolen session or spend key;
phished principal admin; malicious x402 seller; compromised API host; compromised co-signer
host or KMS credentials; malicious insider; sanctioned counterparties; chain reorgs; Agent Bank
going out of business; a curious or colluding proof verifier.

## Trust boundaries

1. Agent runtime ↔ API (RFC 9421 signatures, per-session scope).
2. API account ↔ co-signer account (PrivateLink, HMAC-authenticated internal API, the co-signer
   re-derives everything from raw user operations).
3. Off-chain ↔ on-chain (session scope and hook enforce limits even if every off-chain system
   is compromised).
4. Principal ↔ Agent Bank (owner key never leaves the principal; owner operations; exit tool).
5. Agent ↔ proof verifier (zero-knowledge presentations; the verifier learns statements, not
   identities; see [private proofs](private-proofs.md)).

## Threats and controls

| #   | Threat                                                       | Primary control                                                                                                                            | Backstop                                                                        | Test / evidence                                                                           |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| T1  | Injected agent overspends or pays an attacker                | Policy engine (caps, allowlists, velocity, cooldown, mandate) + on-chain session scope                                                     | Approvals above thresholds; velocity freeze                                     | `packages/policy/test/redteam.test.ts` (≥ 1,000 adversarial intents); e2e red-team suite  |
| T2  | Stolen session key                                           | 24 h expiry, narrow scope, co-signature required                                                                                           | Anomaly freeze; owner revokes on-chain                                          | Session tests in API/co-signer; chain simulator "session alone fails"                     |
| T3  | Compromised co-signer key                                    | Useless alone; non-exportable KMS key; rotation runbook                                                                                    | Session + co-signer still bounded by on-chain scope                             | Chain simulator "co-signer alone fails"; `docs/runbooks/key-compromise.md`                |
| T4  | Compromised API asks co-signer to sign a different operation | Co-signer decodes the raw user op, recomputes its hash, verifies the session signature and evaluates its own policy copy and spend history | Audit hash chain; anomaly alerts                                                | Co-signer tests: mismatched intent refused                                                |
| T5  | Stolen admin session loosens limits                          | Loosening needs owner signature + 1 h delay                                                                                                | Notifications on every policy change; freeze                                    | Policy diff tests; API tests                                                              |
| T6  | Agent Bank outage, insider or shutdown                       | Bank cannot move funds by design                                                                                                           | Exit tool withdraws directly with the owner key                                 | `exit-tool` tests against a simulated shutdown                                            |
| T7  | Malicious x402 seller / overcharge                           | Challenge checked against policy and per-domain caps; client max-per-request                                                               | Facilitator nonce/expiry/replay checks; settle-before-serve > $1                | SDK x402 tests; facilitator tests                                                         |
| T8  | x402 verify/settle split bugs, front-running of EIP-3009     | Single-use authorization table + on-chain `authorizationState`; settle before serve above $1                                               | Short validity windows                                                          | Facilitator replay tests                                                                  |
| T9  | Smart contract bug                                           | Audited Safe/7579/Smart Sessions; minimal custom contracts with fuzz + invariant tests                                                     | Two audits, bug bounty, $1,000 per-account beta cap, pause of new deposits only | `contracts` repo test suite, `AUDIT_SCOPE.md`                                             |
| T10 | Sanctioned or illicit funds                                  | Wallet-risk screening on every counterparty and deposit (fail closed)                                                                      | Co-signer refuses; account review                                               | Screening provider interface tests                                                        |
| T11 | Phished principal admin                                      | Passkeys; hardware keys for owner actions                                                                                                  | Loosening delay; notifications                                                  | Console auth tests                                                                        |
| T12 | Ledger/chain drift                                           | Continuous reconciliation, 20-block matching window                                                                                        | Suspense account; sessions paused; nightly balance assertion                    | Indexer property tests incl. injected reorgs (Phase 1 gate: 10,000 movements, zero drift) |
| T13 | Replay of agent HTTP requests                                | Signature lifetime ≤ 300 s; single-use nonce                                                                                               | Idempotency keys on every write                                                 | `core` signature tests                                                                    |
| T14 | Idempotency key reuse with different request                 | Request hash stored with the key; mismatch → 409                                                                                           | —                                                                               | API idempotency tests                                                                     |
| T15 | Secrets in logs                                              | Structured logging with redaction of keys, signatures, API keys                                                                            | Log review in CI (grep for key patterns)                                        | API logger tests                                                                          |
| T16 | Reorg double-credits a deposit                               | Large deposits post only at finality; reorgs reverse entries                                                                               | Suspense + alert                                                                | Indexer reorg tests                                                                       |
| T17 | Mainnet deployment by mistake                                | `assertTestnet`, DB check constraint, deploy-script guard, Terraform validation                                                            | Human gate at Phase 5                                                           | Tests in `core`, `db`, contracts                                                          |
| T18 | Attester key leaks: false facts attested                     | Separate key that can move nothing; KMS outside testnet; roots public and permanent on Base                                                | Registry owner rotates the attester and revokes roots                           | Registry tests (`contracts`); `docs/runbooks/key-compromise.md`                           |
| T19 | Forged proof                                                 | Groth16 soundness; circuit range checks on every bound; disclosure mask enforced in-circuit                                                | Public multi-party ceremony and circuit audit before mainnet                    | `contracts/circuits/test` soundness suite; `@agentbank/proofs` tests                      |
| T20 | Proof replayed to another verifier or later                  | Scope and nonce are public inputs; gates issue HMAC nonces and remember them until expiry; on-chain consumers burn nonces                  | Root validity window                                                            | Gate and `AgentClaimsVerifier` replay tests                                               |
| T21 | Verifier deanonymizes the agent                              | Nullifiers per scope; coarse attribute values; minimum anonymity set per request                                                           | SDK refuses probing patterns; owner disclosure classes                          | Privacy scenarios in `tests/e2e`                                                          |
| T22 | Funds pledged to several verifiers                           | Reservations are ledger holds bound to one scope tag; the circuit compares the tag                                                         | Reservations cannot be released early except by the owner, which revokes roots  | e2e reservation scenarios                                                                 |
| T23 | Narrowed disclosure or frozen agent keeps proving            | Narrowing rebuilds the tree and revokes older valid roots                                                                                  | Short root validity (2 h)                                                       | API proofs tests                                                                          |
| T24 | Stolen session key enrolls an attacker's proof identity      | Enrollment needs a live agent session; owner controls whether proofs are enabled at all                                                    | Owner disables proofs (immediate, revokes roots); session revocation            | API proofs tests                                                                          |

## Residual risks (accepted for beta)

- Approvals are attested by the API (ADR 0012).
- x402 spend-key float can be spent by a fully compromised agent up to the float (ADR 0001).
- USDC issuer freezes are outside Agent Bank's control (disclosed in terms).
- Counsel has not yet confirmed the co-signer model is not money transmission (open decision).
- Private proofs: verifiers trust Agent Bank as attester, the testnet proving keys come from a
  single-party ceremony, and payments made after a proof remain linkable on-chain (ADR 0014).
