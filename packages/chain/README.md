# @agentbank/chain

Everything Agent Bank does on-chain goes through one `ChainGateway` interface with two
implementations:

- `SimulatedChain` (`@agentbank/chain/simulated`): an in-memory chain that applies the same
  validation rules as production (owner signature, or session key + co-signer within the session
  scope; the policy hook; USDC with EIP-3009/EIP-2612/ERC-1271; escrow, streams, vaults and
  executors), with blocks, finality tags and injectable reorgs. It runs the whole stack in tests
  and the local sandbox without a network.
- `EvmChainGateway`: Base Sepolia or Anvil through viem and an ERC-4337 bundler (Pimlico or a
  local Alto). Safe v1.4.1 accounts with the Safe7579 adapter, Rhinestone Smart Sessions V1 with a
  2-of-2 OwnableValidator (session key + co-signer), and Agent Bank's AgentPolicyHook. Every entry
  point calls `assertTestnet`.

Internal workspace package.

## Usage

```ts
import { accountSetupCalls, transferCall, signOperationHash, encodeSessionSignature } from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";

const sim = new SimulatedChain();
const gateway = sim.gateway;
const address = await gateway.predictAccountAddress({ owner, cosigner, salt: 0n });
const op = await gateway.prepareOperation({
  account,
  session: { permissionId },
  calls: [transferCall(usdc, to, amount)],
});
// The session key and the co-signer sign the raw 32-byte user operation hash (EIP-191).
```

Helpers build every call Agent Bank makes (transfers, escrow, streams, vaults, session install
and revoke, the policy hook, top-up executor, spend-key permit and float sweep, owner rotation)
and decode operations back into calls, which is how the co-signer checks what it signs.

## Tests

```bash
pnpm --filter @agentbank/chain test                       # unit + simulator
RUN_LIVE_TESTS=1 pnpm --filter @agentbank/chain test      # read-only checks against Base Sepolia
RUN_FORK_TESTS=1 pnpm --filter @agentbank/chain test      # Anvil fork of Base Sepolia + local Alto bundler
pnpm --filter @agentbank/chain sync-abis                  # copy ABIs from ../contracts
```

The fork suite proves on the real Safe, Smart Sessions and USDC contracts that a session key and
the co-signer can pay within scope, that neither can pay alone, that over-limit payments revert,
that agent sessions cannot produce ERC-1271 signatures for `transferWithAuthorization` or
`permit`, and that the owner can always withdraw.
