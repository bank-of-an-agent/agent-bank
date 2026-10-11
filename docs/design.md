# Agent Bank — Design & Implementation Plan

Oct 10, 2026 · @Matthew Mangano

## Executive summary

Agent Bank is a public, crypto-native bank that any AI agent can open an account with, hold USDC in, and use to pay, get paid, escrow and stream money under rules its human owner sets. The core bet: agents need programmable accounts with hard spending limits, not cards borrowed from humans.

The design is **non-custodial by default**. Each agent account is a smart-contract wallet owned by a human or company (the principal). The bank never holds the owner key; it acts as a policy co-signer that can block a payment but cannot move funds alone. This keeps the regulatory surface small enough for a startup to launch.

V1 ships the full bank core in 20 weeks: two weeks of foundations, then five build phases: ledger and accounts, the policy engine, payments (agent-to-agent and x402 pay-per-call), escrow and streams, then the public developer surface (REST API, TypeScript and Python SDKs, and an MCP server). Credit is designed in but gated behind a later phase.

Savings comes in three tiers: vaults with no yield, an owner-directed sweep into tokenized Treasury funds, and later a partner-run savings account. The bank earns from subscriptions and transaction fees, not deposit float. In the model it reaches about $2.9M of monthly revenue and a 56% operating margin at scale, after an estimated $3–4M of runway.

## Product definition and principles

Agent Bank serves three kinds of customer, and every agent account must trace back to a verified principal. There are no ownerless agents in v1.

| Customer | What they are | What they get |
| --- | --- | --- |
| Principal | A verified human or company that deploys agents | Org account, KYC/KYB, a control console, policies, approvals, statements |
| Agent | Software acting for a principal | A smart account, a scoped session key, balances, payment and escrow APIs |
| Counterparty | A merchant, API seller or another agent receiving funds | Payment requests, x402 payee setup, invoices, escrow release |

**Design principles**

1. **Non-custodial.** The bank can block a payment but can never move funds alone.
2. **Limits live in code, not prompts.** Spend limits are enforced by the smart account and the co-signer, so a jailbroken agent still cannot overspend.
3. **Every dollar has an owner.** Each agent maps to a principal, each payment to an agent, each agent action to a signed mandate.
4. **Open standards first.** x402 for HTTP payments, AP2 mandates for authorization proof, ERC-4337/7579 smart accounts, ERC-8004 for agent identity.
5. **The chain holds balances; the ledger holds meaning.** The double-entry ledger records why money moved and reconciles against chain state continuously.
6. **Fail closed.** If the policy engine, co-signer or screening is down, payments stop rather than pass.
7. **Framework-agnostic.** Any agent reaches the bank by REST, SDK or MCP; nothing assumes a single vendor's runtime.

**Where it sits in the market.** [Coinbase Agentic Wallets](https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained) (launched February 2026) give agents MPC wallets with session caps inside Coinbase's custody perimeter. [Catena Labs](https://www.theblock.co/post/402029/catena-labs-lands-30-million-series-a-files-for-national-trust-bank-charter-to-underpin-agentic-finance) raised a $30M Series A in May 2026 and is pursuing an OCC national trust bank charter to hold funds. Agent Bank's wedge is the gap between them: non-custodial and vendor-neutral like a wallet, but with real bank primitives (ledger, escrow, streams, statements, later credit) like an institution.

## Regulatory posture

Agent Bank launches as non-custodial software, not a licensed bank or money transmitter, because the bank never holds a key that can move funds by itself. This is the single most important architecture decision; it must be reviewed by crypto-specialist counsel before mainnet. Nothing here is legal advice.

| Model | What it means | Licensing burden | Verdict |
| --- | --- | --- | --- |
| Custodial | Bank holds keys and moves funds for users | FinCEN MSB registration plus state money transmitter licenses; a charter for true deposits | Not for v1 |
| Policy co-signer (chosen) | Principal holds the owner key; bank holds a co-signing key that can only approve or refuse | Lowest; relies on the bank being unable to move funds unilaterally | v1 |
| Pure software | SDK only, no bank-run signer | Lowest, but no enforceable limits or ledger | Too weak |

**Why the co-signer model holds up.** The pending CLARITY Act's [Section 604](https://forklog.com/en/catholic-groups-urge-changes-to-section-604-of-the-clarity-act/) (the Blockchain Regulatory Certainty Act) would codify that non-custodial developers who do not control user funds are not money transmitters. A Senate cloture vote was [scheduled for September 15, 2026](https://cryptobriefing.com/senate-clarity-act-vote-tuesday/); I could not confirm the outcome, so treat it as not yet law. Today the position rests on existing FinCEN guidance on unhosted and multi-signature wallets, which counsel must confirm applies.

**Lines the design must never cross (or the posture changes):**

- The bank's co-signing key can never be sufficient alone to transfer funds, including through an upgrade path.
- No pooled omnibus wallets; every agent has its own on-chain account.
- No fiat on- or off-ramp run by the bank; integrate licensed third-party ramps instead.
- The bank never pays yield itself and never pools savings; any return comes from a fund the owner selects (see Savings and treasury), and only after counsel signs off.
- Credit only after a separate legal review (lending licenses).

**Compliance the bank still does as a matter of risk, not license:** KYC/KYB of principals through a vendor, OFAC and wallet-risk screening on every counterparty, and a terms-of-service that makes the principal liable for its agents. USDC is the settlement asset; GENIUS Act implementing rules for stablecoin issuers were [still largely pending as of mid-2026](https://eco.com/support/en/articles/15606775-genius-act-1-year-implementation-tracker-where-things-actually-stand), which affects issuers, not Agent Bank directly.

## System architecture

Seven off-chain services sit between agents and the chain, but the only thing that can move money is the agent's own smart account. Every agent payment flows API → policy and co-signer → bundler → smart account, and the indexer closes the loop by matching what landed on-chain back to the ledger.

&#91;embedded content: system architecture · 3 callers, 7 services, 3 on-chain parts\]

The co-signer and policy engine deploy separately from the API, in their own cloud account, so a compromise of the public API cannot reach signing keys.

## Identity, accounts and keys

Each agent gets its own ERC-7579 modular smart account on Base, controlled by three keys with sharply different powers. The owner key can always exit; the agent can only act within limits and with the bank's co-signature.

**Account hierarchy**

1. **Organization** (the principal): KYC/KYB-verified; owns agents; holds policies and members (admins, approvers, viewers).
2. **Agent**: a named software identity with a DID, an optional ERC-8004 registration, and an agent card listing its endpoints.
3. **Account**: one smart account per agent per chain. Base mainnet first; the address is counterfactual (CREATE2) so it can receive funds before deployment.
4. **Pockets**: ledger-only sub-balances inside an account (operating, reserved for holds, escrow-locked, fees). Pockets never need their own on-chain address.

**Keys and what each can do**

| Key | Held by | Can do alone | Typical form |
| --- | --- | --- | --- |
| Owner | Principal | Everything: withdraw all funds, remove the bank co-signer, rotate keys | Passkey, Ledger or YubiKey-backed signer |
| Co-signer | Agent Bank | Nothing alone; approves or refuses agent-initiated operations | Key in a cloud HSM/KMS, never exportable |
| Session | Agent runtime | Nothing alone; signs operations inside its scope, which the co-signer must also approve | Short-lived key, default 24h expiry, generated client-side by the SDK |

**Validation rule on-chain.** An operation is valid if the owner signs it, or if a live session key and the co-signer both sign it and the policy hook passes. Session-key scope (token, max per transaction, max per day, allowed recipients or contracts, expiry) is enforced by a Smart Sessions module, so limits hold even if the bank's off-chain systems were compromised.

**Authentication to the API.** Agents authenticate with request signatures from their session key (HTTP Message Signatures, RFC 9421), not static API keys. Principals sign in with passkeys and may require hardware keys for approvals.

**Recovery.** A guardian module lets a principal's chosen guardians rotate the owner key after a 72-hour time lock that the current owner can cancel. Agent Bank may be one guardian but never a majority, preserving the non-custodial line.

**Gas.** A bank-run ERC-4337 paymaster sponsors gas; the cost is charged in USDC to the account's fee pocket, so agents never hold ETH.

## Ledger and money movement

An append-only double-entry ledger records the intent and reason behind every movement, and an indexer proves each one against the chain. Because the bank is non-custodial, every movement between accounts settles on-chain; the ledger never invents balances.

**Ledger rules**

- Amounts are integers in the asset's smallest unit (USDC has 6 decimals), stored as 64-bit or wider integers. No floats anywhere.
- Journal entries are immutable. Corrections are new reversing entries, never edits.
- Every entry balances to zero across its lines and carries the payment id, agent id, mandate id and policy decision id that caused it.
- Two-phase movement: a **hold** reserves funds when a payment is authorized, then is **posted** on chain confirmation or **voided** on failure or expiry.
- Every write API takes an idempotency key; retries return the original result.
- Storage: PostgreSQL with serializable transactions, behind a `Ledger` interface so a dedicated engine such as TigerBeetle can replace it later without API changes.

**Ledger accounts**

| Ledger account | Scope | Purpose |
| --- | --- | --- |
| `pocket:operating` | Per account | Spendable balance |
| `pocket:reserved` | Per account | Funds under hold for pending payments |
| `pocket:escrow` | Per account | Funds locked in an escrow contract |
| `pocket:fees` | Per account | Gas and service fees owed |
| `sys:chain:<chain>:<asset>` | System | Mirror of on-chain value entering and leaving |
| `sys:revenue` | System | Agent Bank fee income |
| `sys:suspense` | System | Unmatched chain movements awaiting review |

**Movement types:** inbound deposit (detected by the indexer), agent-to-agent transfer, external payout, x402 payment, escrow lock and release, stream settlement, fee sweep.

**Reconciliation.** The indexer reads USDC transfer events and escrow contract events for every known account. Each on-chain movement must match a ledger entry within a configurable window (default 20 blocks). An unmatched movement posts to suspense, raises an alert, and pauses that agent's session keys until reviewed. A nightly job asserts that on-chain balance equals the sum of pockets for every account.

**Finality.** Payments under a configurable threshold (default $100) post on L2 inclusion; larger ones post only once the block is finalized.

## Policy engine and human controls

Spending rules are enforced twice: hard caps on-chain in the session key's scope, and richer rules in a deterministic off-chain policy engine that drives the co-signer. No language model sits in the decision path; models may flag anomalies, but only rules decide.

**Decision outcomes:** `allow`, `deny`, `require_approval` (a human approver signs), `require_owner` (the owner key must sign the operation itself).

**Rule types in v1**

- Amount caps per transaction, per day, per week and per month, by asset.
- Counterparty allowlists and denylists, by address, ERC-8004 agent id or x402 domain.
- Per-counterparty caps and a cooling period for first-time counterparties.
- Velocity limits (payments per minute, per hour).
- Time windows (for example, business hours only).
- Maximum balance an agent may hold; excess sweeps back to the org treasury account.
- Approval thresholds: above $X needs one approver, above $Y needs two.

**Policy changes are asymmetric.** Tightening takes effect immediately. Loosening requires an owner signature and a 1-hour delay, so a stolen admin session cannot quietly raise limits and drain an agent.

**Mandates.** A principal grants an agent authority with a signed mandate in AP2 format (intent, constraints, expiry). The bank compiles each mandate into a session-key scope plus policy rules, and every payment records the mandate it ran under. That gives counterparties and auditors cryptographic proof that a human authorized the spend.

**Human controls in the console**

- Approve or deny queued payments by passkey; approvals expire after 15 minutes.
- Freeze one agent or the whole org instantly; the co-signer then refuses everything.
- Revoke session keys on-chain (owner-signed) as the hard backstop.
- Notifications by webhook, email and Slack for approvals, denials, unusual activity and low balance.

**Example policy**

```json
{
  "agent": "agt_research_01",
  "asset": "USDC",
  "limits": { "per_tx": "25.00", "per_day": "200.00", "per_month": "2000.00" },
  "counterparties": { "mode": "allowlist", "x402_domains": ["api.example-data.com"], "new_cooldown_minutes": 60 },
  "velocity": { "max_per_minute": 30 },
  "approvals": [ { "above": "100.00", "approvers": 1 }, { "above": "1000.00", "approvers": 2 } ],
  "max_balance": "500.00"
}
```

## Banking products

V1 offers nine products on one core; credit is designed but switched off until a separate legal review. x402 is the anchor product because it is already where agent payments happen: it has [processed over 169 million payments](https://forkast.news/glossary/x402-protocol/), and governance moved to the x402 Foundation under the Linux Foundation in 2026.

| Product | What the agent can do | How it works | Phase |
| --- | --- | --- | --- |
| Accounts and balances | Hold USDC, see available, reserved and escrowed funds | Smart account plus ledger pockets | 1 |
| Org treasury and auto top-up | Get funded by its org on rules (refill to $X when under $Y) | Owner-signed standing allowance from the treasury account | 2 |
| Agent-to-agent transfers | Pay another Agent Bank account or any address, with a memo | Hold, policy, co-sign, on-chain transfer, post | 3 |
| Payment requests | Ask another agent or a human to pay; share a pay link | Request object with amount, expiry and reference | 3 |
| x402 pay | Pay for HTTP APIs and MCP tools automatically on a 402 response | SDK intercepts the 402, builds the payment with session key plus co-signer | 3 |
| x402 receive | Charge per call for its own API or tool | Agent Bank runs an x402 facilitator that verifies and settles payer-signed payments | 3 |
| Escrow | Lock funds for a task; release on approval, refund on timeout, or let an arbiter decide | Audited escrow contract; optional validator via the ERC-8004 validation registry | 4 |
| Streams and recurring payments | Pay per second for ongoing service, or on a schedule | Pre-funded escrow settled on an interval (default hourly) | 4 |
| Statements and exports | Monthly statements, CSV, accounting webhooks | Generated from the ledger | 5 |
| Credit lines (gated) | Spend beyond balance, backed by the principal's guarantee | Underwriting on payment history and reputation | Later |

Savings products are in Savings and treasury below; pricing for every product, and the profit model, are in Business model.

## Savings and treasury

Savings comes in three tiers. In every tier the money stays in the customer's own smart account or in a fund the owner picked; Agent Bank never pools deposits and never pays interest itself. By default savings lives in the org treasury account, so agents stay lean and draw only what they need through auto top-up.

| Tier | What it does | Who earns the return | Agent Bank revenue | Regulatory load | Phase |
| --- | --- | --- | --- | --- | --- |
| Vaults (no yield) | Goal vaults and time-locked vaults; agents can deposit but cannot withdraw early | No return | Included in paid plans | Low | 2 |
| Treasury sweep (owner-directed yield) | Owner signs a standing rule: keep a liquid floor, sweep the excess into a tokenized Treasury fund they choose, redeem automatically below the floor | The owner, from the fund | 0.15% a year on swept balances | Medium; counsel gate on broker and adviser status | 4 |
| Partner savings account | A licensed partner (trust company or bank) offers an interest-bearing account; Agent Bank is the interface | The customer, paid by the partner | Revenue share, modeled at 0.5% a year | Partner holds the license | After v1 |

**Vaults.** Goal vaults are ledger pockets with a policy rule that agents cannot spend from them; they cost nothing on-chain. Locked vaults are a small audited `TimeLockVault` contract owned by the account: deposits any time, withdrawals only back to the parent account, and only after the unlock date or with the owner's signature.

**Auto-save rules** (all owner-signed policy, enforced by the co-signer):

- **Income split:** save a percentage of every inbound payment. This suits agents that earn through x402 or escrow.
- **Excess sweep:** move anything above the agent's maximum balance to the treasury or a vault.
- **Round-up:** round each outbound payment up and save the difference.
- **Scheduled:** move a fixed amount on a schedule.

**Treasury sweep mechanics**

1. The owner picks a fund from an eligibility list: regulated funds that subscribe and redeem in USDC on Base and accept the owner's investor status. Examples as of 2026: Franklin's BENJI (SEC-registered, low minimum, US investors), Ondo's USDY (non-US only), and institutional funds such as BUIDL, OUSG or USTB ($100K-class minimums, qualified purchasers). See [this comparison](https://eco.com/support/en/articles/15254006-ousg-vs-buidl-vs-usdy-yield-2026-tokenized-t-bills-compared).
2. The owner completes the fund's own KYC. Fund shares sit in the owner's treasury account, never in a bank-held wallet.
3. The owner installs a sweep executor module. It can only subscribe and redeem between that account and the allowlisted fund contract; session keys and the co-signer cannot touch fund shares.
4. The rule sets a liquid floor (default: two days of trailing seven-day spend), a sweep threshold, and a cap on the share of funds in savings. Redemptions start when the floor is breached, sized for the fund's settlement time (same-day or next-day).
5. The ledger holds shares in `pocket:savings`, marked to the fund's published price daily; gains belong to the owner. The platform fee accrues daily and is collected monthly from the fee pocket.

**Why this needs a legal gate.** The GENIUS Act bars stablecoin issuers from paying yield, and the OCC's proposed rule would [presume a violation](https://perkinscoie.com/insights/update/stablecoin-interest-yield-and-rewards-occ-proposes-sweeping-regulations-under) when an issuer's affiliates or "related third parties" pay it. Agent Bank is not tied to Circle, and the return comes from a Treasury fund rather than USDC, so that ban likely does not reach it. Routing customers into securities and charging a fee on balances does raise broker-dealer and investment-adviser questions, though. The mitigations are a neutral eligibility list with no recommendations, owner-only selection, and a fallback that prices the sweep as a flat plan feature instead of a fee on balances.

## Business model

Agent Bank makes money from fees on money movement and from subscriptions, not from interest on deposits. Being non-custodial means it has no float to lend. In the model below it loses about $163K a month in beta, comes within $46K a month of break-even at the Growth stage, and earns about $1.6M a month (a 56% operating margin) at Scale. Every figure is a planning assumption, not a forecast.

**Pricing**

| Revenue stream | Price | Paid by | Notes |
| --- | --- | --- | --- |
| Free plan | $0 | Developers | Sandbox, up to 3 agents, small monthly volume cap |
| Pro plan | $99 a month | Small teams | Up to 25 agents, approvals, vaults, auto-save |
| Business plan | $499 a month | Companies | Unlimited agents, multi-approver, treasury sweep, audit exports |
| Enterprise plan | About $4,000 a month on average | Large companies | SSO, custom policy, SLA, dedicated co-signer region |
| Outbound payments | 0.20% of amount, capped per payment | Payer | Agent-to-agent and external transfers |
| x402 receive | 0.5% of settled amount | Seller | Buyers pay nothing, to win distribution |
| Escrow | 1% of escrowed amount, $1 minimum | Payer, payee or split | Highest value per transaction |
| Streams and recurring | 0.5% of streamed amount | Payer |  |
| Treasury sweep | 0.15% a year on swept balances | Owner | Or a flat plan feature if counsel requires |
| Partner savings | About 0.5% a year revenue share | Partner | After v1 |
| Gas | At cost | Account | Pass-through, no margin |

**Model drivers (monthly)**

| Driver | Beta | Growth | Scale |
| --- | --- | --- | --- |
| Paying orgs (Pro / Business / Enterprise) | 50 / 5 / 0 | 600 / 120 / 10 | 3,000 / 600 / 60 |
| Outbound payment volume | $2M | $40M | $300M |
| x402 volume received | $0.5M | $15M | $120M |
| Escrowed volume | $0.2M | $8M | $60M |
| Streamed volume | $0.1M | $3M | $25M |
| Treasury sweep balances | $0 | $20M | $250M |
| Partner savings balances | $0 | $0 | $150M |
| Team size (at $18K a person a month, fully loaded) | 6 | 14 | 30 |

**Monthly P&L**

| Line | Beta | Growth | Scale |
| --- | --- | --- | --- |
| Subscriptions | $7.4K | $159.3K | $836.4K |
| Outbound payment fees | $4.0K | $80.0K | $600.0K |
| x402 receive fees | $2.5K | $75.0K | $600.0K |
| Escrow fees | $2.0K | $80.0K | $600.0K |
| Stream fees | $0.5K | $15.0K | $125.0K |
| Treasury sweep fees | $0 | $2.5K | $31.3K |
| Partner savings share | $0 | $0 | $62.5K |
| **Revenue** | **$16.4K** | **$411.8K** | **$2,855.2K** |
| Variable costs (KYB, screening, gas) | $1.2K | $30.4K | $232.0K |
| Fixed costs (team, infra, security, legal, go-to-market) | $178.0K | $427.0K | $1,010.0K |
| **Operating profit** | **−$162.8K** | **−$45.6K** | **$1,613.2K** |
| Operating margin | n/m | −11% | 56% |

Variable costs assume $3 per org per month for KYB and monitoring, wallet screening at 0.02% of volume, and $0.002 gas per x402 settlement averaging $2. Fixed costs beyond the team are infrastructure ($15K, $40K, $120K), security including amortized audits and bug bounty ($25K, $40K, $80K), legal and compliance ($20K, $35K, $70K), and go-to-market ($10K, $60K, $200K).

**What drives profit**

- Gross margin is about 92% at every stage, so profit depends almost entirely on volume per org against a fixed cost base. On the Growth cost base, break-even needs about $460K of monthly revenue, roughly 12% above the Growth case.
- Escrow and subscriptions are the most defensible streams: competitors cannot easily undercut them, and they don't depend on per-payment pricing.
- Fee compression is the main risk. Large x402 facilitators may settle for free. If the x402 receive fee went to zero, Scale operating profit falls to about $1.0M a month (45% margin). If the payment fee were halved to 0.10%, it falls by another $300K.
- Upside not in the model: a spread on asset swaps (USDC to EURC or other assets), credit interest after the legal review, a paid reputation and verification API built on ERC-8004, and private enterprise deployments.

**Funding need.** The build phase (about five months at beta-level cost), roughly six months of beta, and the climb to Growth add up to an estimated $3–4M of runway before break-even. That figure is illustrative and should be rebuilt in a proper model once pricing is validated with design partners.

## Developer surface

Any agent reaches Agent Bank through one REST API, wrapped by TypeScript and Python SDKs and an MCP server. Agents get money tools only; nothing an agent can call loosens its own limits or withdraws to the owner.

**REST API (v1, OpenAPI 3.1 is the source of truth)**

| Area | Endpoints | Caller |
| --- | --- | --- |
| Orgs and agents | `POST /v1/orgs`, `POST /v1/agents`, `GET /v1/agents/{id}`, `POST /v1/agents/{id}/freeze` | Principal |
| Accounts | `POST /v1/agents/{id}/accounts`, `GET /v1/accounts/{id}/balances` | Principal, agent (read) |
| Sessions | `POST /v1/sessions` (register a session public key and scope; owner signs the install), `DELETE /v1/sessions/{id}` | Principal |
| Mandates and policies | `POST /v1/mandates`, `PUT /v1/agents/{id}/policy`, `POST /v1/policy/check` (dry run) | Principal; agent may dry-run |
| Payments | `POST /v1/payments`, `GET /v1/payments/{id}`, `POST /v1/payment-requests` | Agent |
| x402 | `POST /v1/x402/pay` (answer a 402 challenge), `POST /v1/x402/verify`, `POST /v1/x402/settle` (facilitator) | Agent, seller |
| Escrow and streams | `POST /v1/escrows`, `POST /v1/escrows/{id}/release`, `/refund`, `/dispute`, `POST /v1/streams` | Agent |
| Approvals | `GET /v1/approvals`, `POST /v1/approvals/{id}/decide` | Approver |
| Ledger | `GET /v1/accounts/{id}/entries`, `GET /v1/statements` | Principal, agent (read) |

Conventions: every write takes an `Idempotency-Key` header; money is a decimal string plus an asset code; ids are prefixed (`org_`, `agt_`, `acct_`, `pay_`, `esc_`); errors follow RFC 9457 problem details.

**Webhooks:** `payment.created`, `payment.settled`, `payment.failed`, `approval.requested`, `escrow.released`, `reconciliation.mismatch`, `agent.frozen`. Signed with HMAC and retried with backoff for 72 hours.

**MCP server tools for agents:** `get_balance`, `check_spend` (dry run), `pay`, `fetch_paid_resource` (x402), `request_payment`, `create_escrow`, `release_escrow`, `list_transactions`. Available over stdio for local agents and streamable HTTP for hosted ones.

**SDKs:** `@agentbank/sdk` (TypeScript) and `agentbank` (Python) handle session key generation and storage, request signing, and an x402-aware HTTP client that pays 402 responses inside policy. A sandbox on Base Sepolia with test USDC mirrors production exactly.

## Security, risk and compliance controls

The security model assumes every agent will eventually be prompt-injected and every single key will eventually leak; no single failure may move funds beyond a session's on-chain scope.

| Threat | Primary control | Backstop |
| --- | --- | --- |
| Prompt-injected agent tries to overspend or pay an attacker | Policy engine plus on-chain session scope (caps, allowlist) | Approvals above threshold; velocity freeze |
| Stolen session key | 24h expiry, narrow scope, co-signature still required | Anomaly freeze; owner revokes on-chain |
| Compromised co-signer key | Useless alone; held in a non-exportable HSM; rotation runbook | Even co-signer plus session is bounded by on-chain scope |
| Agent Bank outage, insider or shutdown | Cannot move funds by design | Open-source exit tool lets the owner withdraw directly on-chain with no bank involvement |
| Malicious x402 seller or overcharge | Challenge amount checked against policy and per-domain caps | Facilitator enforces nonce, expiry and replay checks |
| Smart contract bug | Audited account and session modules; minimal custom contracts (escrow, policy hook) | Two independent audits, a bug bounty, and a $1,000 per-account cap during beta |
| Sanctioned or illicit funds | Wallet-risk screening on every counterparty and deposit | Co-signer refuses; principal account review |
| Phished principal admin | Passkeys; hardware keys for owner actions | Loosening needs owner signature plus 1-hour delay |
| Ledger and chain drift | Continuous reconciliation | Suspense account; agent sessions paused |

A 2026 [security analysis of x402](https://arxiv.org/pdf/2605.30998) traces several bug classes to the protocol's split between verifying a payment and settling it, plus front-running trade-offs in the EIP-3009 transfer method the exact scheme uses. The facilitator therefore defaults to settle-before-serve for amounts over $1 and treats every authorization as single-use.

**Operational controls**

- Hash-chained audit log of every policy decision, approval, co-signature and admin action.
- Co-signer service objective: p99 decision latency under 300 ms, 99.9% monthly availability; it fails closed.
- Separate cloud accounts for co-signer, API and indexer; no human holds production signing material.
- Incident runbooks for key compromise, contract pause, reconciliation mismatch and mass freeze.
- SOC 2 Type I readiness targeted for 6 months after public launch.

## Data model

Fifteen core tables in PostgreSQL carry the whole bank; the journal tables are append-only and enforced so by database permissions, not just code.

| Entity | Key fields | Belongs to |
| --- | --- | --- |
| `org` | id, legal\_name, kyc\_status, tier, created\_at | — |
| `member` | id, org\_id, user\_id, role (admin, approver, viewer), passkey\_ids | org |
| `agent` | id, org\_id, name, did, erc8004\_id, status (active, frozen), agent\_card\_url | org |
| `account` | id, agent\_id, chain\_id, address, deployed, module\_versions | agent |
| `session_key` | id, account\_id, public\_key, scope\_json, expires\_at, revoked\_at, onchain\_tx | account |
| `mandate` | id, agent\_id, signed\_payload, signer, constraints\_json, expires\_at | agent |
| `policy` | id, agent\_id, version, rules\_json, effective\_at, signed\_by | agent |
| `payment` | id, account\_id, kind, counterparty, amount, asset, status, mandate\_id, decision\_id, tx\_hash, idempotency\_key | account |
| `policy_decision` | id, payment\_id, outcome, rule\_hits\_json, evaluated\_at | payment |
| `approval` | id, payment\_id, approver\_id, decision, signed\_at, expires\_at | payment |
| `escrow` | id, payer\_account\_id, payee, amount, conditions\_json, arbiter, status, contract\_address | account |
| `ledger_account` | id, owner\_ref, code (pocket or system), asset | account or system |
| `journal_entry` / `journal_line` | entry: id, ref\_type, ref\_id, created\_at; line: entry\_id, ledger\_account\_id, amount (signed integer) | — |
| `chain_event` | id, chain\_id, block, tx\_hash, log\_index, type, matched\_entry\_id | — |

Invariants checked in CI and nightly: lines in each entry sum to zero; each `chain_event` matches at most one entry; no `payment` reaches `settled` without a `policy_decision` of `allow` or a recorded approval; balances are derived from the journal (a cached projection is allowed but never authoritative).

Added for savings and billing: `vault` (id, account\_id, kind, unlock\_at, contract\_address), `sweep_rule` (id, account\_id, fund\_id, floor, threshold, max\_share, signed\_by), `fund` (id, name, token\_address, eligibility\_json), `fund_position` (id, account\_id, fund\_id, shares, last\_price, priced\_at), `plan` and `subscription` (org billing tier), and `fee_charge` (id, account\_id, source\_ref, amount, ledger\_entry\_id). Fees are ledger entries into `sys:revenue`, so revenue reconciles like every other movement.

## Implementation plan

Six phases over 20 weeks take Agent Bank from an empty repo to a capped mainnet beta; each phase ends at a gate the next phase depends on. The roadmap drawing below shows the sequence; the tasks under each phase are the work to hand off.

&#91;embedded content: build roadmap · 6 phases, 20 weeks\]

The two security-heavy phases (2 and 4) gate everything after them: nothing reaches mainnet until a red team and two audits have failed to break the limits.

**Stack**

| Layer | Choice | Why |
| --- | --- | --- |
| Monorepo | TypeScript, pnpm workspaces, Turborepo; Nix flake dev shell | One language for API, co-signer, indexer, SDK and MCP server |
| API | Node 22, Fastify, Zod, OpenAPI 3.1 generated from schemas | Typed contracts shared with the SDK |
| Database and jobs | PostgreSQL 16; pg-boss for queues | One stateful system to operate |
| Chain access | viem; Base Sepolia then Base mainnet | USDC-native, where x402 volume is |
| Smart accounts | Safe with the ERC-7579 adapter, Rhinestone Smart Sessions module | Most deployed and audited account stack |
| Bundler and paymaster | Pimlico (hosted) first; self-hosted Alto later | Ship fast, remove the dependency later |
| Co-signer keys | AWS KMS secp256k1 keys, non-exportable | Hardware-backed, audited access logs |
| Contracts | Solidity, Foundry, fuzz and invariant tests | Escrow, stream and policy-hook contracts |
| Indexer | Ponder | Typed, reorg-aware event indexing |
| Console | Next.js, passkeys via WebAuthn | Principal dashboard and approvals |
| Vendors | KYB/KYC provider; wallet screening provider (Chainalysis or TRM) | Bought, not built |

**Repository layout**

```
agent-bank/
  apps/api          REST API and webhooks
  apps/cosigner     policy engine + KMS co-signer (separate deploy)
  apps/indexer      chain indexer + reconciliation
  apps/facilitator  x402 verify/settle
  apps/console      principal dashboard
  packages/ledger   double-entry ledger library
  packages/policy   policy schema + deterministic evaluator
  packages/sdk-ts   TypeScript SDK + x402 client
  packages/mcp      MCP server
  sdk-py/           Python SDK
  contracts/        Foundry: escrow, streams, policy hook
  tools/exit        open-source owner exit tool
  infra/            Terraform
```

**Phase 0 · Foundations (weeks 1–2)**

- [ ] Scaffold the monorepo, CI (lint, typecheck, test, contract tests), preview environments.
- [ ] Write the threat model and the invariants list as tests that fail until implemented.
- [ ] Spike: prove an x402 exact-scheme payment signed by a Safe smart account (ERC-1271) settles on Base Sepolia USDC. If it does not, design the fallback: a per-agent spend key holding a small float, refilled under policy.
- [ ] Engage crypto counsel on the co-signer model.

* Gate: spike result documented and a decision recorded.

**Phase 1 · Ledger and accounts (weeks 3–6)**

- [ ] `packages/ledger`: journals, holds, post, void, idempotency; property-based tests for zero-sum.
- [ ] Org, member, agent and account APIs; counterfactual Safe deployment with modules on Base Sepolia.
- [ ] Indexer for USDC transfers; deposit detection; reconciliation job and suspense flow.

* Gate: 10,000 simulated deposits and transfers reconcile with zero drift, including injected reorgs.

**Phase 2 · Keys, policy and co-signer (weeks 7–10)**

- [ ] Session key lifecycle in the SDK and API; Smart Sessions scope install via owner signature.
- [ ] `packages/policy` evaluator and the `apps/cosigner` service on KMS, failing closed.
- [ ] Mandates (AP2 format) compiled into scope plus rules; asymmetric policy changes.
- [ ] Console: sign-in with passkeys, approvals, freeze, policy editor, treasury auto top-up.
- [ ] KYB/KYC vendor integration.

* Gate: a red-team agent with a prompt-injection harness cannot exceed any limit or pay a non-allowlisted address in 1,000 attempts.

**Phase 3 · Payments and x402 (weeks 11–14)**

- [ ] Transfers and payment requests end to end, with webhooks.
- [ ] x402 client in the SDK; `apps/facilitator` with replay, nonce and expiry checks.
- [ ] Paymaster with gas billed to the fee pocket; wallet screening on every counterparty.

* Gate: end-to-end suite on Base Sepolia passes; external audit firms booked.

**Phase 4 · Escrow and streams (weeks 15–17)**

- [ ] Escrow and stream contracts with fuzz and invariant tests; arbiter hook.
- [ ] Ledger integration for lock, release, refund and stream settlement.
- [ ] Two independent audits of all custom contracts and the module configuration.

* Gate: no open high or critical findings.

**Phase 5 · Developer surface and beta (weeks 18–20)**

- [ ] Python SDK, MCP server (stdio and streamable HTTP), docs site, quickstarts for common agent frameworks.
- [ ] Statements and exports; sandbox parity checks.
- [ ] Owner exit tool published and tested against a simulated bank shutdown.
- [ ] Closed mainnet beta with a $1,000 per-account cap; bug bounty live.

* Gate: legal sign-off, audits closed, exit tool verified, on-call rotation staffed.

**Savings and revenue tasks (slot into the phases above)**

- [ ] Phase 2: goal vaults as ledger pockets; auto-save rules (income split, excess sweep, round-up, scheduled) in the policy engine.
- [ ] Phase 3: fee engine posting every fee to `sys:revenue`; plans and subscriptions billed monthly in USDC from the org treasury.
- [ ] Phase 4: `TimeLockVault` contract, included in the audit scope.
- [ ] Phase 4: treasury sweep executor module, fund eligibility list, daily pricing, redemption on floor breach. Ships only after a counsel memo on broker and adviser status; otherwise it ships as a flat plan feature.
- [ ] Phase 5: revenue dashboard (revenue by stream, gross margin, volume per org) checked against the business model drivers.

**After v1:** partner savings account, credit lines (after legal review), Solana and other chains, ERC-8004 reputation publishing, raised caps.

## Instructions for the implementing agent

The implementing agent works one phase at a time on testnet only, stops at every gate for human sign-off, and treats the non-custodial lines in the regulatory section as hard constraints it may never trade away.

**Hard rules**

1. Base Sepolia only. Never create, hold or request mainnet keys, and never deploy to mainnet; that happens only after the Phase 5 gate with a human present.
2. No code path, upgrade path or admin function may let the co-signer, or any bank-held key, move funds alone.
3. Money is integer minor units end to end. Every write is idempotent. Every invariant in the data model section has a test.
4. Secrets never enter the repo, logs or prompts; use the secret manager.
5. Record each significant choice as an ADR in `docs/adr/`.
6. Coverage of at least 90% on `packages/ledger` and `packages/policy`; fuzz and invariant tests on every contract.

**Stop and ask a human when**

- A requirement seems to need custody, pooled funds or a bank-run ramp.
- The Phase 0 x402 spike fails or forces the fallback design.
- A vendor account, contract or payment is needed.
- An audit or red-team finding is high or critical.
- Any legal or compliance question comes up.

**At each gate, deliver:** merged pull requests with green CI, a one-page gate report (built, tested, open issues, decisions taken), and a demo script a human can run.

**Kickoff prompt to paste**

```
You are implementing Agent Bank from the attached design doc. Read the whole doc first.
Work only on Phase 0. Target Base Sepolia only; never touch mainnet keys or deploy to mainnet.
The non-custodial rules in "Regulatory posture" and "Instructions for the implementing agent" are hard constraints.
Scaffold the monorepo exactly as laid out in "Implementation plan", set up CI, write the invariants as failing tests,
and run the x402 + Safe (ERC-1271) spike. Then stop and write the Phase 0 gate report:
what you built, test results, the spike outcome, open questions and decisions needing my sign-off.
```

## Open decisions and risks

Seven decisions need your call before or during Phase 0; the biggest risk is legal, not technical.

| Decision | Options | Recommendation |
| --- | --- | --- |
| Legal entity | Under your AI consulting firm, or a new company | New entity, to ring-fence liability |
| Product name | "Agent Bank" is generic and "bank" is a regulated word in many states | Pick a brand that avoids "bank" in the legal name |
| x402 facilitator | Run our own from day one, or use an existing facilitator first | Our own: it is where the policy check and receive-side fees live |
| Account stack | Safe plus ERC-7579 adapter, or ZeroDev Kernel | Safe, for audit history; revisit if gas costs bite |
| Ownerless agents | Allow agents with no human principal | No in v1 |
| Bitcoin | Add Lightning (L402) payments | After v1; USDC on Base first |
| Next chain | Solana, Arbitrum or other | Decide on beta demand data |

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Co-signer model is ruled to be money transmission | Licensing need or redesign | Counsel memo in Phase 0; fallback to partnering with a licensed trust company for custody |
| x402 exact scheme does not work cleanly with smart-account signatures | Phase 3 redesign | Phase 0 spike; spend-key fallback |
| Contract or module exploit | Loss of customer funds | Audits, per-account beta cap, bug bounty, pause on custom contracts only |
| USDC issuer freezes an address | Funds stuck in one account | Screening to avoid tainted flows; disclose in terms |
| Larger players (Coinbase, Stripe, Catena) ship the same features | Weaker wedge | Lead on non-custodial, vendor-neutral and escrow/streams |

## Sources

- [x402 protocol overview and adoption figures](https://forkast.news/glossary/x402-protocol/) (Forkast)
- [Free-Riding the Agentic Web: security analysis of x402](https://arxiv.org/pdf/2605.30998) (arXiv)
- [AP2 specification v0.2](https://ap2-protocol.org/ap2/specification/)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-8004 reference contracts](https://github.com/erc-8004/erc-8004-contracts)
- [Agentic wallet security: session keys and spending caps](https://www.quillaudits.com/blog/web3-security/Agentic-Wallet-Security) (QuillAudits)
- [Coinbase Agentic Wallets explained](https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained) (Eco)
- [Catena Labs Series A and trust charter filing](https://www.theblock.co/post/402029/catena-labs-lands-30-million-series-a-files-for-national-trust-bank-charter-to-underpin-agentic-finance) (The Block)
- [CLARITY Act Section 604 debate](https://forklog.com/en/catholic-groups-urge-changes-to-section-604-of-the-clarity-act/) (ForkLog)
- [Senate CLARITY Act vote scheduled](https://cryptobriefing.com/senate-clarity-act-vote-tuesday/) (Crypto Briefing)
- [GENIUS Act implementation tracker](https://eco.com/support/en/articles/15606775-genius-act-1-year-implementation-tracker-where-things-actually-stand) (Eco)
