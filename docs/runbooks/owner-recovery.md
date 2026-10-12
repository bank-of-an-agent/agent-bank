# Runbook: owner key recovery

Trigger: a principal has lost (or believes compromised) the owner key of their org.

The owner key controls every smart account in the org, and Agent Bank never holds it. Recovery
therefore happens **on-chain first**, through the guardians the principal configured, and only
then off-chain.

## 1. On-chain recovery (principal and guardians)

1. The principal's guardians (chosen by the principal; Agent Bank may be one guardian but never a
   majority) propose the new owner on the account's recovery module.
2. A 72-hour time lock starts. The current owner can cancel during the delay; the principal is
   notified by email and webhook (`org.frozen` is raised if they ask us to freeze in the
   meantime).
3. After the delay, a guardian executes the recovery: the Safe's owner becomes the new key.

Freeze the org while recovery is pending if the old key may be compromised (`POST
/v1/orgs/me/freeze`, or ask support): freezing only refuses co-signatures; it cannot block the
on-chain recovery or the owner's exit.

## 2. Off-chain rotation (Agent Bank operators)

The co-signer pins each org's owner key and only accepts a rotation signed by the current
owner (`POST /v1/orgs/me/owner`, action `owner.rotate`). After a guardian recovery the old key is
gone, so an operator rotation is needed:

1. Two operators independently verify on-chain, for **every** account in the org, that
   `getOwners()` returns only the new owner and that the recovery module's execution event is
   final (`finalized` block tag).
2. Open a change ticket with the transaction hashes and both verifications.
3. Apply the rotation with the break-glass procedure for the co-signer database (two-person
   rule, audited); the action is appended to the co-signer's hash-chained audit log.
4. Unfreeze the org through the normal loosening rules, now signed by the new owner (1-hour
   delay).

A follow-up will let the co-signer verify recovery events itself (read-only chain access) so
step 2 needs no operator.
