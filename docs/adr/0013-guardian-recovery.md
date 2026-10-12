<!-- Canonical copy: bank-of-an-agent/contracts docs/adr/0002-guardian-recovery.md. -->

# ADR 0013: Guardian recovery uses Candide's audited SocialRecoveryModule (72-hour variant)

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Agent Bank core team (Phase 0 / Phase 4 contracts)
- **Evidence:** [`test/fork/CandideSocialRecovery.fork.t.sol`](https://github.com/bank-of-an-agent/contracts/blob/main/test/fork/CandideSocialRecovery.fork.t.sol) (7 tests on a Base Sepolia fork, all passing at block 47,990,000 and at chain head)

## Context

The design ("Identity, accounts and keys → Recovery") requires the following:

1. The principal's chosen guardians can rotate the Safe owner key, but only after a **72-hour time lock**.
2. The **current owner can cancel** during that lock.
3. **Agent Bank may be one guardian but never a majority**. The bank must never be able to take over or move funds alone, through recovery or any other path.

The brief preferred an existing audited Safe recovery module over new custom code, if one is deployed on Base Sepolia.

Candidate: **Candide's SocialRecoveryModule**. Findings, checked on-chain:

- **Deployment.** It is deployed at the same address on every supported chain, Base Sepolia included, in fixed-delay variants:

  | Delay               | Address                                      |
  | ------------------- | -------------------------------------------- |
  | 3 days (72 h)       | `0x38275826E1933303E508433dD5f289315Da2541c` |
  | 7 days              | `0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2` |
  | 14 days             | `0x9BacD92F4687Db306D7ded5d4513a51EA05df25b` |
  | 3 minutes (testing) | `0x949d01d424bE050D09C16025dd007CB59b3A8c66` |

- **On-chain identity.** The deployed contract reports `NAME() = "Social Recovery Module"` and `VERSION() = "0.0.1"`. Its runtime code hash is `0xdbebd594…330ae03` on both Base Sepolia and Ethereum Sepolia.
- **Audits.** Ackee Blockchain audited v0.0.1 (commit `113d3c05`). Certora specs exist in the repository. Nethermind audited the version that Safe vendors under `safe-modules/modules/recovery` and found no issues.
- **How it works.**
  - Guardians are stored per Safe and configured only by the Safe itself (`onlyWhenModuleIsEnabled`, called through the owner's `execTransaction`).
  - Guardians `confirmRecovery`. Once approvals reach the threshold, the recovery starts and `executeAfter = now + recoveryPeriod`.
  - Anyone may `finalizeRecovery` after the period. Finalising swaps the owners via `execTransactionFromModule`.
  - The wallet itself can `cancelRecovery` while a recovery is pending, and `invalidateNonce` to void pending confirmations.
  - A guardian can never become a new owner.

## Decision

1. **Use Candide's SocialRecoveryModule v0.0.1, 72-hour variant** (`0x38275826E1933303E508433dD5f289315Da2541c`), as a plain Safe module. Agent Bank writes **no custom recovery module**.
2. **Configuration policy.** The module does not enforce these rules, so Agent Bank's provisioning flow (SDK and console) enforces them and the indexer monitors them:
   - guardians = the principal's choices plus **at most one** Agent Bank guardian key;
   - **threshold > guardians / 2**, a strict majority, so two disjoint guardian groups can never both recover;
   - **threshold ≥ 2** whenever Agent Bank holds a seat, so the bank alone never reaches the threshold. The default is 3 guardians (two of the principal's, one Agent Bank) with threshold 2.
   - the Agent Bank guardian key is separate from the co-signer key, held in KMS, and never a Safe owner (the module enforces "guardian cannot be owner").
3. **Only the owner configures recovery.** Enabling the module and adding or removing guardians are owner-signed Safe transactions. Agent session scopes must never include the recovery module. `AgentPolicyHook`'s fail-closed target rules already block calls to it from the agent path, because it is not an allowlisted contract.
4. **Operations.**
   - Keepers may call `finalizeRecovery` after the delay.
   - Every `RecoveryExecuted` event alerts the principal on all channels, because the owner has 72 hours to cancel.
   - After a completed recovery, the new owner should revoke existing session keys and re-review modules. The SDK prompts this.

## Consequences

**Positive**

- No new custom contract in the audit scope. The module has been audited (Ackee; Nethermind on the Safe-vendored version), comes with formal-verification specs, and is the same deployment on every chain.
- The fork tests demonstrate every property the design requires:
  - two guardians rotate the owner key **only after exactly 72 hours**;
  - **Agent Bank alone cannot recover**: it cannot reach the threshold, and nothing can be finalised;
  - **the owner can cancel**, even in the last second of the delay, and the spent confirmations cannot be replayed;
  - the owner can invalidate pending confirmations;
  - **Agent Bank can never become an owner** through recovery, even with colluding guardians;
  - Agent Bank plus one independent guardian can start a recovery, which the owner still sees and can cancel.

**Negative / risks**

- The majority and bank-seat policy is **off-chain** (provisioning plus monitoring), not enforced by the module. An owner can later re-configure guardians with their own signature, including into a weaker setup. That is the owner's prerogative and never a bank power. The indexer alerts on any guardian or threshold change that breaks the policy.
- The deployed bytecode is v0.0.1, while the Candide repository HEAD is v0.2.0. The audit phase should **verify the deployed bytecode against the Ackee-audited commit** (recompile and compare). The cross-chain code-hash match only proves it is a single deployment.
- The recovery period is fixed per deployment, so changing the 72 hours means migrating to another variant: disable one module, enable the other, and re-add guardians.
- Recovery replaces Safe owners only. It does not revoke ERC-7579 validators or Smart Sessions. The new owner must do that (see Decision 4).
- `finalizeRecovery` is permissionless after the delay. That is intended for liveness, but it means a recovery the owner did not cancel in time completes without further interaction.

**Follow-ups**

- Phase 2: the provisioning flow enforces the policy; the console shows guardians, the threshold and the countdown; the alerting described above.
- Audit phase: verify the deployed bytecode against Ackee's audited commit `113d3c05`, and review the policy enforcement code.
