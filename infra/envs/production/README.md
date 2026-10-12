# Production: intentionally not defined

There is no production root module, and that is deliberate.

Agent Bank runs on **Base Sepolia (chain ID 84532) only** until the **Phase 5 gate** in the
design doc. That gate requires:

- legal sign-off on the non-custodial co-signer model;
- both independent audits closed, with no open high or critical findings;
- the owner exit tool verified against a simulated bank shutdown;
- an on-call rotation staffed.

Under the implementing-agent hard rules, nobody creates, holds or requests mainnet keys, and
mainnet deployment happens only after that gate, with a human present. Defining production
infrastructure now would create a path to mainnet (a production co-signing key, a mainnet
chain ID, live vendor credentials) before any of that is true. So:

- No `envs/production/*` root modules exist.
- Every sandbox root rejects `chain_id = 8453` (Base mainnet), and `tofu test` checks this.
- Nothing under `infra/` may be applied with mainnet configuration, and the sandbox roots must
  not be copied or re-pointed to create one.

## When the gate is passed

Production gets new root modules, one per account, in new AWS accounts, reviewed and applied
by a human, from the same modules with production settings:

- Three AZs, a NAT gateway per AZ, Multi-AZ RDS, and longer backup retention plus
  cross-region backup copies.
- TLS or mTLS on every PrivateLink listener (ACM Private CA), with private DNS.
- A dedicated log-archive account for the audit archive, with Object Lock COMPLIANCE
  retention set with counsel (e.g. 7 years).
- SCPs that deny ECS Exec, restrict `iam:PassRole` on the co-signer task role, and restrict
  key-policy changes to break-glass. No human principal may ever be able to sign.
- A fresh co-signing key, never the sandbox one, registered on-chain through owner-signed
  module installation.
- State in a dedicated, locked-down state account.
- An explicit, human-approved change to the chain-ID validation. That change is the mainnet
  switch and must never be made casually.
