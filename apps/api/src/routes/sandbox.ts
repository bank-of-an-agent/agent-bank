import { AgentBankError, toPositiveMinor } from "@agentbank/core";
import { createWalletClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadAccount } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { onChain, usdcAddress } from "../domain/chain";
import type { AppDeps } from "../deps";
import { requirePrincipal } from "../http/auth";
import type { Handlers } from "../http/registry";
import { usdc } from "../serializers";

/**
 * `POST /v1/sandbox/faucet`: test USDC for local quickstarts. On the simulated chain it mints
 * in-process (the block is mined at once; the reconciler posts the deposit when the development
 * indexer reports it). On Anvil it calls MockUSDC's open `mint` from `SANDBOX_FAUCET_KEY`. On
 * Base Sepolia it is refused: test USDC comes from Circle's faucet there. An `account_id` must
 * be one of the caller's accounts; an `address` may be any address. Idempotency-Key replays
 * return the original transfer, so a retry never mints twice.
 */

/** Largest single faucet request. */
export const SANDBOX_FAUCET_MAX_MINOR = 10_000_000_000n; // 10,000 USDC

const mockUsdcMintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

async function mintOnAnvil(deps: AppDeps, to: Address, amount: bigint): Promise<Hex> {
  const key = deps.config.sandboxFaucetKey;
  if (!key) {
    throw new AgentBankError(
      "feature_gated",
      "Set SANDBOX_FAUCET_KEY (a funded Anvil key) to use the faucet",
    );
  }
  const wallet = createWalletClient({
    account: privateKeyToAccount(key),
    transport: http(deps.config.rpcUrl),
  });
  return onChain("faucet", () =>
    wallet.writeContract({
      address: usdcAddress(deps),
      abi: mockUsdcMintAbi,
      functionName: "mint",
      args: [to, amount],
      chain: null,
    }),
  );
}

export const sandboxHandlers: Pick<Handlers, "sandboxFaucet"> = {
  async sandboxFaucet({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const chain = deps.config.chain.name;
    if (chain !== "simulated" && chain !== "anvil") {
      throw new AgentBankError(
        "feature_gated",
        "The sandbox faucet runs on the simulated chain and Anvil only; on Base Sepolia use Circle's faucet",
      );
    }
    const amount = toPositiveMinor(body.amount);
    if (amount > SANDBOX_FAUCET_MAX_MINOR) {
      throw new AgentBankError("invalid_amount", "The faucet sends at most 10,000.00 USDC per request");
    }
    const to = body.account_id
      ? getAddress((await loadAccount(deps.db, principal, body.account_id)).address)
      : getAddress(body.address as string);
    let txHash: Hex | null;
    if (chain === "simulated") {
      if (!deps.simulator) throw new AgentBankError("feature_gated", "No in-process simulated chain");
      txHash = deps.simulator.faucet(to, amount);
    } else {
      txHash = await mintOnAnvil(deps, to, amount);
    }
    await audit(deps.db, now, {
      actor: actorOf(auth),
      action: "sandbox.faucet",
      subject: to,
      payload: { amount: amount.toString(), tx_hash: txHash, chain },
    });
    return { object: "faucet_transfer" as const, address: to, amount: usdc(amount), tx_hash: txHash };
  },
};
