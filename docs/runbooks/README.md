# Incident runbooks

| Runbook                                               | Trigger                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Key compromise](key-compromise.md)                   | Suspected leak of the co-signer key, a facilitator relayer key, an API key or a session key |
| [Contract pause](contract-pause.md)                   | Suspected bug in an Agent Bank contract                                                     |
| [Reconciliation mismatch](reconciliation-mismatch.md) | `reconciliation.mismatch` event, suspense balance > 0                                       |
| [Mass freeze](mass-freeze.md)                         | Platform-wide incident requiring every agent to stop                                        |
| [Owner recovery](owner-recovery.md)                   | A principal lost or leaked the owner key                                                    |

Every runbook ends with a written incident report within 5 business days. Owners can always
exit with the [exit tool](https://github.com/bank-of-an-agent/exit-tool), whatever state
Agent Bank is in.
