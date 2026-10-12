# 0012: Approval attestation (known limitation)

- Status: Accepted
- Date: 2026-10-11

## Context

Payments above an approval threshold need human approvals made with passkeys in the console.
The co-signer should ideally verify those WebAuthn assertions itself, so that a compromised
API cannot fabricate approvals.

## Decision

In v1 the API verifies passkey assertions and passes the approval record to the co-signer,
which trusts it. The co-signer still enforces every hard limit (caps, allowlists, velocity,
mandate, session scope) independently, and the on-chain session scope still bounds the amount.

## Consequences

- A compromised API could approve payments that need approval but cannot exceed hard caps.
- Follow-up: register approver credentials with the co-signer under an owner authorization and
  verify assertions there.
