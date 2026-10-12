# 0007: Agent request signatures

- Status: Accepted
- Date: 2026-10-11

## Context

The design requires agents to authenticate with request signatures from their session key
(RFC 9421), not static API keys. Session keys are secp256k1 (they also sign user operations),
and RFC 9421's algorithm registry has no secp256k1 entry.

## Decision

Agents sign RFC 9421 signature bases with algorithm `eip191-secp256k1`: the base is signed as
an EIP-191 personal message, so viem, eth-account, hardware wallets and KMS signers all work.
`keyid` is the session id; covered components are `@method`, `@target-uri`, `content-digest`
(RFC 9530, required with a body) and `idempotency-key` (required when sent). Signatures live at
most 300 seconds and carry a single-use nonce.

## Consequences

- One key per agent session for both HTTP and on-chain authority.
- Shared test vectors keep the TypeScript and Python implementations byte-identical.
