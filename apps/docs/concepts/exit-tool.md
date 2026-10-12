# Exit tool

Agent Bank must never stand between an owner and their money. If Agent Bank is down, compromised, insolvent or simply gone, the owner can still withdraw everything directly on-chain with the open-source **exit tool**: [`bank-of-an-agent/exit-tool`](https://github.com/bank-of-an-agent/exit-tool).

## How it works

- It needs only **an RPC URL and the owner key**. It depends on nothing in the Agent Bank monorepo, calls no Agent Bank service and needs no Agent Bank credentials; that independence is the point, so it lives in its own repository.
- It signs with the owner key and calls the Safe's native **`execTransaction`**, which accepts the owner's signature directly and **bypasses the ERC-7579 modules and the policy hook**. Session keys, the co-signer and the bundler are not involved.
- It can move the account's USDC to any address the owner chooses, and use the escrow, stream and vault contracts' exit paths: refunds after an escrow expires are open to anyone, canceling a stream refunds what has not accrued, and withdrawals from vaults go back to the parent account after the unlock date (or earlier with the owner's signature).
- It pulls agent **spend-key floats** back into the account with the [float-recovery permit](/concepts/accounts-and-keys#float-recovery-permit) each spend key granted at provisioning, and it can remove every module, which revokes every agent and bank power over the account.

Because the Agent Bank contracts' pause guardian can only stop **new** deposits and locks, every exit path stays open even while a contract is paused.

## Using it

The CLI is `agentbank-exit` from the package `@agentbank/exit` (Node.js 22.12 or later). Every command is a **dry run** until you add `--execute`, which asks for confirmation before broadcasting:

```bash
agentbank-exit inspect --account 0xYourSafe
agentbank-exit exit --account 0xYourSafe --to 0xYourColdWallet --deployments agentbank.json
OWNER_PRIVATE_KEY=… agentbank-exit exit --account 0xYourSafe --to 0xYourColdWallet --execute
```

<!-- verify: install command for @agentbank/exit (npx / npm) once the package is published -->

| Command            | Does                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`          | Shows owners, modules, fallback handler, guard, balances, escrows, streams, vaults and spend-key floats, and what can be recovered now                                       |
| `withdraw`         | Sends USDC, ETH or another ERC-20 from the account (`--to`, `--token`, `--amount`)                                                                                           |
| `disable-modules`  | Removes every Safe module (the Safe7579 adapter included), resets the fallback handler and removes the guard; keeps the guardian recovery module unless `--include-recovery` |
| `refund-escrows`   | Refunds expired escrows the account paid into                                                                                                                                |
| `cancel-streams`   | Cancels streams the account pays; the payee keeps what it has earned                                                                                                         |
| `withdraw-vaults`  | Returns time-locked vaults to the account; locked ones with the owner's EIP-712 signature                                                                                    |
| `sweep-spend-keys` | Pulls agent spend-key floats back with their permit allowance                                                                                                                |
| `exit`             | All of the above in a safe order, then withdraws every token and all ETH to `--to`                                                                                           |
| `submit`           | Executes a plan written by `--signer-only`, with its signatures                                                                                                              |

You will need:

1. An RPC endpoint for the chain (`--rpc-url`; the chain's public RPC by default). Mainnet chain ids are refused.
2. The owner key: `OWNER_PRIVATE_KEY`, an encrypted keystore (`--keystore`), or a hardware wallet with `--signer-only`, which writes the plan and the EIP-712 payloads to sign for `submit`.
3. The smart account address (in the console, or from `GET /v1/accounts/{id}`; it is also the counterfactual address you funded).
4. A destination address, and Agent Bank's contract addresses (`--deployments <file>`, or `--escrow`, `--streams`, `--vaults`) if the account used escrows, streams or vaults. Spend keys are found from their permit events, or passed with `--spend-key`.

The repository's README is the full reference.

## What Agent Bank sees

An owner exit is an outflow that matches no payment, so reconciliation posts it to `sys:suspense`, raises a `reconciliation.mismatch` event and pauses the agent's sessions. That is expected; operators classify it as an owner exit and the balances stay true to the chain ([Reconciliation](/concepts/reconciliation)).

## Assurance

The design requires the exit tool to be published and **tested against a simulated bank shutdown** before mainnet; it is one of the Phase 5 gate criteria ([phase gates](/operations/gates)). The repository's [shutdown drill](https://github.com/bank-of-an-agent/exit-tool/blob/main/docs/shutdown-drill.md) is that test: on a local Anvil chain it builds an account with escrows, streams, vaults and spend keys, shuts the bank down, and checks that the owner recovers everything the account can recover, with only an RPC URL and the owner key. It is also the backstop in the [security model](/concepts/security-model) for an Agent Bank outage, insider or shutdown, and every [incident runbook](/operations/runbooks) ends by reminding owners that they can exit.
