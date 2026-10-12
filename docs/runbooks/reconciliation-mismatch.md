# Runbook: reconciliation mismatch

Trigger: `reconciliation.mismatch` event, `AgentBank/Reconciliation UnmatchedEvents > 0` alarm,
or a non-zero `sys:suspense` balance.

What already happened automatically: the movement was posted to `sys:suspense`, the agent's
sessions were paused in the co-signer, and an event was emitted.

1. Look up the `chain_event` (tx hash, log index, block) and the account involved.
2. Classify:
   - **Late match** (payment row updated after the 20-block window): link the event to the
     payment, post the reversal of the suspense entry and the real settlement.
   - **Agent bypassed Agent Bank** (spend key paid without `/x402/pay`, or owner moved funds
     with the exit tool): expected for owner exits; for spend-key spend, treat as a policy
     incident (T1/T2) and keep the agent frozen until the principal reviews.
   - **Reorg artefact**: verify the indexer reversed the orphaned entries.
   - **Unknown**: escalate to SEV-2; consider a mass freeze.
3. Re-run the nightly balance assertion for the account; it must pass before unpausing.
4. Unpause the agent's sessions (loosening: owner signature + 1 h delay).
