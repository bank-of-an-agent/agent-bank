# Runbook: key compromise

Severity: SEV-1 for the co-signer key, SEV-2 otherwise. Page the on-call security engineer.

## Co-signer key (AWS KMS)

The key cannot move funds alone; with a stolen session key it can spend only within that
session's on-chain scope.

1. **Freeze** all orgs in the co-signer (`POST /internal/v1/freeze` scope `org` for every org, or
   set `COSIGNER_FAIL_CLOSED=true` and redeploy): the co-signer refuses everything.
2. **Disable** the KMS key (break-glass role, MFA). New co-signatures become impossible.
3. **Create** a new KMS key; deploy the co-signer with its id; read its address
   (`GET /healthz` returns `cosigner_address`).
4. **Rotate on-chain**: every active session names the old co-signer in its OwnableValidator
   config. Sessions are short-lived (≤ 24 h by default): expire them and have agents request new
   sessions; the owner installs them (owner operation), now naming the new co-signer.
5. **Unfreeze** after review; loosening rules apply (owner signature + 1 h delay per org).
6. Review the co-signer audit chain (`GET /internal/v1/audit`) and CloudTrail `kms:Sign` events
   for the window of exposure; reconcile every co-signed operation against payments.

## Facilitator relayer key (testnet)

It only pays gas and submits payer-signed authorizations. Rotate the secret, fund the new key
with testnet ETH, revoke the old one. No customer funds are at risk.

## Org API key

Revoke it (`DELETE /v1/api-keys/{id}`), review `last_used_at` and the audit log. API keys cannot
loosen policies or move funds without owner signatures and agent session keys.

## Agent session key or spend key

Revoke the session (`DELETE /v1/sessions/{id}`; immediate off-chain), freeze the agent, and
have the owner revoke the session on-chain (owner operation). The spend key's exposure is its
float; do not refill it. Rotate both keys in the agent runtime.
