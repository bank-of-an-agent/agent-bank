# Incident runbooks

Summaries of the runbooks in [`docs/runbooks/`](https://github.com/bank-of-an-agent/agent-bank/tree/main/docs/runbooks); the originals are authoritative. Every runbook ends with a written incident report within five business days, and in every incident **owners keep full control**: owner operations and the [exit tool](/concepts/exit-tool) need neither the co-signer nor any other Agent Bank service.

| Runbook                                             | Trigger                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Key compromise](#key-compromise)                   | Suspected leak of the co-signer key, a facilitator relayer key, an API key or a session key |
| [Contract pause](#contract-pause)                   | Suspected bug in an Agent Bank contract                                                     |
| [Reconciliation mismatch](#reconciliation-mismatch) | A `reconciliation.mismatch` event, or a suspense balance above zero                         |
| [Mass freeze](#mass-freeze)                         | A platform-wide incident in which no agent payment should be co-signed                      |
| [Owner recovery](#owner-recovery)                   | A principal lost the owner key, or believes it compromised                                  |

## Key compromise

Severity SEV-1 for the co-signer key, SEV-2 otherwise; page the on-call security engineer. [Full runbook](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/runbooks/key-compromise.md).

**Co-signer key (AWS KMS).** The key cannot move funds alone; with a stolen session key it can spend only within that session's on-chain scope.

1. **Freeze** every org in the co-signer, or set `COSIGNER_FAIL_CLOSED=true` and redeploy: the co-signer refuses everything.
2. **Disable** the KMS key (break-glass role, MFA); new co-signatures become impossible.
3. **Create** a new KMS key and deploy the co-signer with it; `GET /healthz` reports the new `cosigner_address`.
4. **Rotate on-chain.** Every active session names the old co-signer in its validator configuration. Sessions are short-lived: let them expire, have agents request new ones, and the owners install them, now naming the new co-signer.
5. **Unfreeze** after review; unfreezing is a loosening (owner signature and the 1-hour delay per org).
6. Review the co-signer's audit chain and the KMS signing logs for the exposure window, and reconcile every co-signed operation against payments.

**Facilitator relayer key (testnet).** It only pays gas and submits payer-signed authorizations: rotate it, fund the new key with testnet ETH, revoke the old one. No customer funds are at risk.

**Org API key.** Revoke it (`DELETE /v1/api-keys/{id}`) and review the audit log. API keys cannot loosen policies or move funds without the owner's and the agent's signatures.

**Agent session key or spend key.** Revoke the session (`DELETE /v1/sessions/{id}`, immediate off-chain), freeze the agent, and have the owner revoke the session on-chain. The spend key's exposure is its float: do not refill it. Rotate both keys in the agent runtime.

## Contract pause

The escrow, stream and vault contracts have a pause guardian that can block only **new** locks and deposits; releases, refunds, withdrawals and exits can never be paused. [Full runbook](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/runbooks/contract-pause.md).

1. Confirm the finding with the security engineer and capture a minimal reproduction.
2. Pause new deposits on the affected contract from the guardian multisig.
3. Turn off the product's feature flag (`FEATURE_ESCROW=false`, …) so the API prepares no new operations.
4. Notify affected principals by email and the status page, with exit-tool instructions.
5. Patch, test (unit, fuzz, invariant), have an auditor review the fix, deploy a new version, and let old positions settle or refund normally.

## Reconciliation mismatch

Triggered by a `reconciliation.mismatch` event, the unmatched-events alarm, or a non-zero `sys:suspense` balance. Already done automatically: the movement was posted to suspense, the agent's sessions were paused in the co-signer, and the event was emitted. [Full runbook](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/runbooks/reconciliation-mismatch.md).

1. Look up the chain event (transaction hash, log index, block) and the account.
2. Classify it:
   - **Late match**, a payment updated after the 20-block window: link the event, reverse the suspense entry and post the real settlement.
   - **The agent bypassed Agent Bank** (a spend key paying without `/v1/x402/pay`) or **the owner exited** with the exit tool: expected for owner exits; for spend-key spending treat it as a policy incident and keep the agent frozen until the principal reviews.
   - **Reorg artefact**: verify the orphaned entries were reversed.
   - **Unknown**: escalate to SEV-2 and consider a mass freeze.
3. Re-run the nightly balance assertion for the account; it must pass before unpausing.
4. Unpause the agent's sessions: a loosening, so owner signature and the 1-hour delay.

## Mass freeze

For a platform-wide issue (a policy evaluation bug, a compromised API, unexplained drift) in which no agent payment should be co-signed. [Full runbook](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/runbooks/mass-freeze.md).

1. Set `COSIGNER_FAIL_CLOSED=true` on the co-signer (it refuses every co-signature immediately), or freeze every org through the internal API.
2. Post a status page update and send `org.frozen` webhooks.
3. Owners keep full control: owner operations and the exit tool do not need the co-signer.
4. Investigate, then unfreeze org by org under the loosening rules once the cause is fixed.

## Owner recovery

The owner key controls every account in the org and Agent Bank never holds it, so recovery happens **on-chain first**, through the guardians the principal configured ([ADR 0013](/operations/adrs)), and only then off-chain. [Full runbook](https://github.com/bank-of-an-agent/agent-bank/blob/main/docs/runbooks/owner-recovery.md).

1. **Guardians propose the new owner** on each account's recovery module. A 72-hour time lock starts; the current owner can cancel it, and the principal is notified.
2. **Freeze the org** while recovery is pending if the old key may be compromised (`POST /v1/orgs/me/freeze`). Freezing only refuses co-signatures: it cannot block the on-chain recovery or the owner's exit.
3. **After the delay** a guardian, or anyone, finalizes the recovery: the Safe's owner becomes the new key.
4. **Rotate off-chain.** The co-signer pins each org's owner key and normally accepts only a rotation signed by the current owner (`POST /v1/orgs/me/owner`, action `owner.rotate`). The old key is gone, so two operators independently verify, for every account in the org, that the Safe's only owner is the new key and that the recovery is final, record both checks in a change ticket, and apply the rotation with the audited two-person break-glass procedure.
5. **Unfreeze** under the loosening rules, signed by the new owner (1-hour delay).

A voluntary rotation, while the principal still holds the old key, needs no operator: see [Rotating the owner key](/concepts/owner-operations#rotating-the-owner-key).
