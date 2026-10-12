# Phase 0 gate report · Foundations

**Gate criterion:** spike result documented and a decision recorded.
**Status:** criterion met on testnet. **Needs human sign-off:** the spike forced the fallback
design (the design says to stop and ask), and crypto counsel has not been engaged.

## Built

| Deliverable                                                                                                                                             | Where                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Monorepo: pnpm workspaces, Turborepo, TypeScript 6, ESLint (floats banned in money code), Prettier, Nix flake dev shell                                 | [`agent-bank`](../..)                                                                                                 |
| CI: format, lint, typecheck, OpenAPI drift, tests on PostgreSQL 16, coverage gates, container builds                                                    | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)                                                          |
| Contracts CI: fmt, build with sizes, lint, ABI drift, unit + fuzz + invariant (10k fuzz runs, 1k×200 invariant runs), coverage, Base Sepolia fork tests | `contracts/.github/workflows/ci.yml`                                                                                  |
| Preview environments                                                                                                                                    | Infrastructure as code for a sandbox per account (`infra/envs/sandbox`); no AWS account is connected yet              |
| Threat model and invariants                                                                                                                             | [`docs/threat-model.md`](../threat-model.md); invariants are enforced as database constraints and tests (see Phase 1) |
| x402 + Safe (ERC-1271) spike                                                                                                                            | `contracts/test/spike/X402SafeErc1271.fork.t.sol`, report in `contracts/docs/spike-x402-erc1271.md`                   |

## Spike outcome

The spike forked Base Sepolia (USDC is FiatToken v2.2 with the `bytes signature` EIP-3009
overload) and ran 14 fork tests, all passing at a pinned block and at chain head.

- **A deployed Safe can pay an x402 `exact` payment** through ERC-1271, via both the `bytes` and
  the `(v,r,s)` overloads (131k gas; a plain EOA payment is 106k). Replay, expiry, wrong-signer
  and tampered amount/recipient all revert.
- **An undeployed (counterfactual) Safe cannot pay**: USDC has no ERC-6492 support.
- **On-chain caps do not hold on the ERC-1271 path.** USDC asks the account only to approve a
  digest in a static call, so session spending limits and the policy hook never see the amount.
  A local test reproduces a session key draining the whole balance through EIP-3009 or `permit`
  while the hook records zero spend.

## Decision taken

[ADR 0001](../adr/0001-x402-spend-key-float.md): agents pay x402 with a **per-agent spend key
(EOA) holding a small float**, refilled from the smart account under the full session +
co-signer + hook policy stack. Agent sessions never get ERC-1271 signing rights (verified on the
fork against real USDC in `packages/chain/test/fork/spendkey.fork.test.ts`). At provisioning the
spend key signs an EIP-2612 permit to its account so the owner can always sweep the float back.
Worst-case loss for a fully compromised agent: one float.

## Open questions and decisions needing your sign-off

1. **Accept ADR 0001** (the spike forced the fallback design).
2. **Engage crypto counsel** on the co-signer model (Regulatory posture) and on spend keys if
   Agent Bank ever hosts agent runtimes.
3. Open decisions from the design still open: legal entity, product name (the org is named
   "Bank of an Agent"; the word "bank" is regulated), next chain, Lightning.

## Demo script

```bash
# In the contracts repository (Foundry; on NixOS: nix shell nixpkgs#foundry)
forge test --match-path 'test/spike/Erc1271SpendCapBypass.t.sol' -vv   # local reproduction of the cap bypass
forge test --match-path 'test/spike/SpendKeyFloat.t.sol' -vv           # the chosen design, end to end
FOUNDRY_PROFILE=fork forge test -vv                                     # Base Sepolia fork (pinned block 47,990,000)
```
