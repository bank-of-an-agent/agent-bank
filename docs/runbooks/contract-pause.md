# Runbook: contract pause

Agent Bank contracts (escrow, streams, vaults) have a pause guardian that can only block **new**
locks/deposits. Releases, refunds, withdrawals and exits are never pausable (see the
`contracts` repo `AUDIT_SCOPE.md`).

1. Confirm the finding with the security engineer; capture a minimal reproduction.
2. Pause new deposits on the affected contract from the guardian multisig.
3. Set the API feature flag for the affected product (`FEATURE_ESCROW=false`, …) so no new
   operations are prepared.
4. Notify affected principals by email and the status page, with the exit-tool instructions.
5. Patch, test (unit, fuzz, invariant), get the fix reviewed by an auditor, deploy a new
   version, migrate by letting old positions settle or refund normally.
