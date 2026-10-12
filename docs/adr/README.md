# Architecture decision records

Significant choices are recorded here (design rule 5). Each record is short: context, decision,
consequences. Superseded records stay, marked as such.

| #                                          | Decision                                                                                           | Status   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-x402-spend-key-float.md)       | x402 payments are signed by a per-agent spend key holding a small float                            | Accepted |
| [0002](0002-repository-structure.md)       | One platform monorepo plus separate repos for contracts, Python SDK and exit tool                  | Accepted |
| [0003](0003-api-contract-single-source.md) | The Zod route registry is the single source of truth for the API                                   | Accepted |
| [0004](0004-sql-client-pglite.md)          | One `SqlClient` over node-postgres and PGlite                                                      | Accepted |
| [0005](0005-owner-operations.md)           | Owner-only on-chain actions are first-class "owner operations"                                     | Accepted |
| [0006](0006-ap2-mandates.md)               | Mandates use the AP2 v0.2 open Payment Mandate shape with an EIP-712 envelope                      | Accepted |
| [0007](0007-agent-request-signatures.md)   | Agents authenticate with RFC 9421 signatures using `eip191-secp256k1`                              | Accepted |
| [0008](0008-fee-collection.md)             | Fees are batched into the payer's own operation or accrued and swept; Agent Bank never pulls funds | Accepted |
| [0009](0009-keeper-executors.md)           | Top-up and treasury sweep run as owner-installed executor modules                                  | Accepted |
| [0010](0010-rolling-policy-windows.md)     | Policy limits use rolling windows                                                                  | Accepted |
| [0011](0011-indexer-on-chain-gateway.md)   | The indexer polls through `ChainGateway` instead of Ponder                                         | Accepted |
| [0012](0012-approval-attestation.md)       | v1 co-signer trusts API-attested approvals (known limitation)                                      | Accepted |
