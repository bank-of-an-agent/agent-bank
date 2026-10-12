import { anvilForkContracts, EvmChainGateway, type ChainGateway } from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";
import { assertTestnet, getAsset, registerAsset, systemClock, type AssetInfo } from "@agentbank/core";
import { isAddressEqual, type Address, type LocalAccount } from "viem";
import type { FacilitatorConfig } from "./config";
import { erc1271ViaCall, type ContractSignatureVerifier } from "./erc1271";
import { evmReceipts, simulatedReceipts, type ReceiptSource } from "./receipts";

/** The chain side of the facilitator: gateway, receipts and the settlement asset. */
export interface ChainRuntime {
  gateway: ChainGateway;
  receipts: ReceiptSource;
  /** ERC-1271 with FiatToken's rule, for payers with code. */
  contractSignatures: ContractSignatureVerifier;
  asset: AssetInfo;
  /** Chain id the RPC node reports (EVM gateways only); checked at startup. */
  rpcChainId?: () => Promise<number>;
  /** Native (gas) balance of the configured relayer, in wei (EVM gateways with a relayer only). */
  relayerBalance?: () => Promise<bigint>;
  /** The in-memory chain when serving `simulated` (development only). */
  simulated?: SimulatedChain;
}

/**
 * USDC on the served chain from the core registry. Anvil has no registered deployment (it is a
 * fork of Base Sepolia, or runs a MockUSDC), so the gateway's USDC is registered for it.
 */
export function settlementAsset(chainId: number, usdc: Address): AssetInfo {
  assertTestnet(chainId);
  let registered: AssetInfo | undefined;
  try {
    registered = getAsset(chainId, "USDC");
  } catch {
    registered = undefined;
  }
  if (registered && isAddressEqual(registered.address, usdc)) return registered;
  if (registered && chainId !== 31337) {
    throw new Error(`USDC on chain ${chainId} is ${registered.address}, not ${usdc}`);
  }
  registerAsset({
    code: "USDC",
    chainId,
    address: usdc,
    decimals: 6,
    eip712: { name: "USDC", version: "2" },
  });
  return getAsset(chainId, "USDC");
}

/** Build the gateway for the configured chain (EVM JSON-RPC, or the simulator in development). */
export function createChainRuntime(config: FacilitatorConfig): ChainRuntime {
  if (config.chain.name === "simulated") {
    const chain = new SimulatedChain({ chainId: config.chain.id, clock: systemClock });
    return {
      gateway: chain.gateway,
      receipts: simulatedReceipts(chain),
      contractSignatures: (input) => chain.gateway.verifySignature(input),
      asset: settlementAsset(chain.chainId, chain.contracts.usdc),
      simulated: chain,
    };
  }
  if (!config.rpcUrl) throw new Error(`No RPC URL for ${config.chain.name}`);
  const contracts =
    config.chain.name === "anvil" && config.usdcAddress
      ? { ...anvilForkContracts(), usdc: config.usdcAddress }
      : undefined;
  const gateway = new EvmChainGateway({
    chainId: config.chain.id,
    rpcUrl: config.rpcUrl,
    ...(contracts ? { contracts } : {}),
    ...(config.relayer ? { relayer: config.relayer } : {}),
  });
  return {
    gateway,
    receipts: evmReceipts(gateway),
    contractSignatures: erc1271ViaCall(gateway.publicClient),
    asset: settlementAsset(config.chain.id, gateway.contracts.usdc),
    rpcChainId: () => gateway.publicClient.getChainId(),
    ...(config.relayer
      ? {
          relayerBalance: () =>
            gateway.publicClient.getBalance({ address: (config.relayer as LocalAccount).address }),
        }
      : {}),
  };
}
