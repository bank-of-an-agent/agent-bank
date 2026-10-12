<!-- Canonical copy: bank-of-an-agent/contracts docs/adr/0001-x402-spend-key-float.md (evidence links point into that repository). -->

# ADR 0001: x402 payments use a per-agent spend key with a small USDC float

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Agent Bank core team (Phase 0 gate)
- **Evidence:** [Spike report](https://github.com/bank-of-an-agent/contracts/blob/main/docs/spike-x402-erc1271.md), [`test/spike/X402SafeErc1271.fork.t.sol`](https://github.com/bank-of-an-agent/contracts/blob/main/test/spike/X402SafeErc1271.fork.t.sol) (Base Sepolia fork), [`test/spike/Erc1271SpendCapBypass.t.sol`](https://github.com/bank-of-an-agent/contracts/blob/main/test/spike/Erc1271SpendCapBypass.t.sol) (the bypass, reproduced against `AgentPolicyHook`), [`test/spike/SpendKeyFloat.t.sol`](https://github.com/bank-of-an-agent/contracts/blob/main/test/spike/SpendKeyFloat.t.sol) (this decision, end to end)

## Context

The x402 `exact` scheme on Base pays with an EIP-3009 `transferWithAuthorization` on USDC. The payer signs the authorization off-chain and a facilitator settles it on-chain. Each agent account is a Safe with ERC-7579 modules. Its spending limits are meant to hold on-chain, through Smart Sessions scope and `AgentPolicyHook`, even if Agent Bank's off-chain systems were compromised.

The Phase 0 spike forked Base Sepolia (USDC = FiatToken v2.2) and found:

1. **A deployed Safe can pay.** The Safe signature is validated through ERC-1271 and settles via both the `bytes` overload and the `(v,r,s)` overload. Replay, expiry and binding protections hold. That works with every facilitator.
2. **An undeployed (counterfactual) Safe cannot pay.** USDC treats a code-less `from` as an EOA and has no ERC-6492 support.
3. **On-chain caps do not apply on this path.** The account sees only an opaque `bytes32` digest, through a STATICCALL that cannot write state. The spike measured zero storage writes to the Safe during settlement. The transfer itself runs inside USDC, so it never touches the account's execution path, its hooks, or Smart Sessions action policies such as `ERC20SpendingLimitPolicy`. Smart Sessions' `I1271Policy` is a `view` that receives only the hash. Any key that can obtain an ERC-1271 approval from the account can therefore authorize the **entire balance**, through EIP-3009 or EIP-2612 `permit`. The only remaining bound would be the off-chain co-signer. The design forbids relying on that alone.

The design doc anticipated this outcome: "If it does not, design the fallback: a per-agent spend key holding a small float, refilled under policy."

## Decision

1. **Agents pay x402 with a dedicated EOA spend key, one per agent, never with the smart account's ERC-1271 signature.** The SDK generates the spend key client-side, next to the session key, and stores it on the principal's side. Agent Bank never holds it. It signs standard EIP-3009 authorizations, so every x402 facilitator accepts them as-is.
2. **The spend key holds only a small float.** The default is about one day of expected x402 spend; during beta, at most 25 USDC is suggested. The worst-case loss if the spend key leaks is the float.
3. **The smart account refills the float under the full policy stack.** A refill is an ordinary ERC-7579 execution (a USDC `transfer` to the spend key). It requires the session key, the co-signer, and the Smart Sessions spending limits. `AgentPolicyHook` also applies: the spend key is on the recipient allowlist, with per-transaction and daily caps. The on-chain hard cap therefore bounds cumulative x402 spend at the refill.
4. **Agent sessions never get ERC-1271 signing rights.** Agent session configurations have no Smart Sessions `erc1271Policies` and no ERC-7739 contents. This closes the bypass through `transferWithAuthorization` and `permit`. It becomes a Phase 2 acceptance test.
5. **Floats are recoverable without the agent.** At provisioning, the spend key signs an EIP-2612 `permit` that grants the parent account an allowance. The owner's exit tool, or the account itself, can sweep the float back with `transferFrom`. `AgentPolicyHook` treats a `transferFrom` into the account as an inflow.

## Consequences

**Positive**

- Works today with every x402 facilitator and with unmodified USDC. It is the cheapest settlement path measured: 106k gas, against 131k for the Safe ERC-1271 path.
- The design's security property survives. The on-chain limits bound cumulative agent spend even if the co-signer and a session key are both compromised. Exposure on top of those limits is at most one float.
- The facilitator code path is simple: always 65-byte ECDSA, so it never needs ERC-6492 or counterfactual-deployment handling.
- Account deployment is decoupled from first payment. A counterfactual account can still receive funds and be funded before it is deployed.

**Negative / costs**

- One more address per agent to index and reconcile. The ledger needs a float pocket (for example `pocket:x402-float`), and refills are internal movements.
- A periodic refill user operation costs gas, sponsored by the paymaster and charged to the fee pocket. It also adds a small latency when the float runs dry.
- The float sits outside the smart account. The owner's native Safe exit path cannot move it directly; recovery depends on the provisioning-time `permit` allowance. If the agent runtime revokes that allowance, it can at most spend the float, which is already the accepted bound.
- The custody posture depends on where the spend key lives. If Agent Bank ever runs agent runtimes, for example hosted remote MCP agents, it would hold keys that can move funds alone. **That needs a counsel review before any hosted offering.**

**Follow-ups**

- Phase 2: a session-scope test that agent sessions cannot produce ERC-1271 signatures; spend-key lifecycle (generate, provision with permit, refill, rotate, sweep) in the SDKs.
- Phase 3: facilitator and SDK x402 client use the spend key; float-low events trigger refills; reconciliation covers spend-key transfers.
- Agent accounts are deployed at creation. This is not required by this ADR, but it avoids the counterfactual limitation for any future smart-account-signed flow.
- Revisit this ADR if USDC or the x402 scheme adds a payment primitive that executes through the account (for example ERC-7579 or ERC-4337 native pulls), or if a stateful, value-aware ERC-1271 policy standard emerges.
