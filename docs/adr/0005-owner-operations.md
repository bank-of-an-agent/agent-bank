# 0005: Owner operations

- Status: Accepted
- Date: 2026-10-11

## Context

Some on-chain actions must be authorized by the principal's owner key alone: installing a
session (Smart Sessions enable), configuring the top-up or sweep executors, early withdrawal
from a time-locked vault, and payments where policy returns `require_owner`. Agent Bank must
prepare these (it knows the account, nonce, gas and paymaster) but can never sign them.

## Decision

An `owner_operation` is a first-class API resource: the API prepares the user operation and
returns its hash; the owner signs it (EIP-191 personal sign, the format the owner validator
expects) in the console or with the SDK and submits it to
`POST /v1/owner-operations/{id}/signature`. Resources that need one carry its id
(`install_operation_id`, `owner_operation_id`, `pending_operation_id`).

## Consequences

- One flow and one signing UI for every owner-only action.
- Independently of this API, the owner can always act with the exit tool through the Safe's
  native `execTransaction`, which bypasses ERC-7579 modules and hooks.
