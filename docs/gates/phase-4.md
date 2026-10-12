# Phase 4 gate report · Escrow and streams

**Gate criterion:** no open high or critical findings (two independent audits).
**Status: code complete; gate needs humans.** The audits have not happened.

## Built

| Deliverable                                                                                                                                                                                  | Where                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `AgentEscrow` (lock, release, ERC-8004 validator release, refund, dispute/resolve, dispute timeout), `PaymentStreams`, `TimeLockVaults`, `AgentPolicyHook`, `TopUpExecutor`, `SweepExecutor` | `contracts/src`                       |
| Ledger integration for lock, release, refund, dispute, stream settlement, vaults, top-ups                                                                                                    | `packages/reconciliation`, `apps/api` |
| Treasury sweep executor, neutral fund list, pricing and redemption on floor breach — **gated** behind `FEATURE_TREASURY_SWEEP` pending a counsel memo                                        | `SweepExecutor`, `apps/api`           |
| Guardian recovery with Candide's audited SocialRecoveryModule (72 hours; Agent Bank never a majority)                                                                                        | ADR 0013, fork tests                  |

## Tests and audit readiness

- 254 contract tests (unit, fuzz, invariant): **100% line, statement, branch and function
  coverage**; CI runs 10,000 fuzz runs and 1,000 × 200 invariant runs per suite; Slither findings
  triaged in `AUDIT_SCOPE.md`; fuzzing found and fixed an ERC-4626 donation/inflation issue in
  `SweepExecutor`.
- `AUDIT_SCOPE.md` lists in-scope files (1,526 nSLOC), trust assumptions, invariants and how
  each contract upholds "Agent Bank can never move user funds".

## What a human must do

Book and run two independent audits of `contracts/` and the module configuration (Safe7579,
Smart Sessions V1, OwnableValidator, AgentPolicyHook); verify Candide's deployed v0.0.1 bytecode
against the audited commit; close every high and critical finding.
