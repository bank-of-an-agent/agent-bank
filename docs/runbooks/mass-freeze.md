# Runbook: mass freeze

Use when a platform-wide issue (bug in policy evaluation, compromised API, unknown drift) means
no agent payment should be co-signed.

1. Set `COSIGNER_FAIL_CLOSED=true` on the co-signer (refuses every co-signature immediately) or
   freeze every org through the internal API.
2. Post a status page update; send `org.frozen` webhooks.
3. Owners keep full control: owner operations and the exit tool do not need the co-signer.
4. Investigate; unfreeze per org following the loosening rules once the cause is fixed.
