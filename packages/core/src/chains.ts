import { AgentBankError } from "./errors";

/**
 * Supported networks. Agent Bank is testnet-only until the Phase 5 gate:
 * mainnet chain ids are listed so that code can refuse them explicitly.
 */

export type ChainName = "base-sepolia" | "anvil" | "simulated";

export interface ChainInfo {
  name: ChainName;
  id: number;
  /** CAIP-2 identifier, used by x402 v2. */
  caip2: `eip155:${number}`;
  /** x402 v1 network name. */
  x402Network: string;
  displayName: string;
  testnet: true;
  /** Seconds per block, used for expiry and reconciliation windows. */
  blockTimeSeconds: number;
  /** Blocks after which a log is considered safe from reorgs for reconciliation matching. */
  reconciliationWindowBlocks: number;
  explorerUrl?: string;
}

export const CHAINS: Record<ChainName, ChainInfo> = {
  "base-sepolia": {
    name: "base-sepolia",
    id: 84532,
    caip2: "eip155:84532",
    x402Network: "base-sepolia",
    displayName: "Base Sepolia",
    testnet: true,
    blockTimeSeconds: 2,
    reconciliationWindowBlocks: 20,
    explorerUrl: "https://sepolia.basescan.org",
  },
  anvil: {
    name: "anvil",
    id: 31337,
    caip2: "eip155:31337",
    x402Network: "anvil",
    displayName: "Local Anvil",
    testnet: true,
    blockTimeSeconds: 1,
    reconciliationWindowBlocks: 20,
  },
  simulated: {
    name: "simulated",
    id: 1337,
    caip2: "eip155:1337",
    x402Network: "simulated",
    displayName: "In-memory simulated chain",
    testnet: true,
    blockTimeSeconds: 2,
    reconciliationWindowBlocks: 20,
  },
};

/**
 * Chain ids the code base refuses outright. Removing an id from this list is a
 * deliberate, reviewed change that may only happen after the Phase 5 gate.
 */
export const LOCKED_MAINNET_CHAIN_IDS: readonly number[] = [1, 8453, 10, 42161, 137];

export function isLockedMainnet(chainId: number): boolean {
  return LOCKED_MAINNET_CHAIN_IDS.includes(chainId);
}

/** Throw unless `chainId` is a supported testnet. */
export function assertTestnet(chainId: number): ChainInfo {
  if (isLockedMainnet(chainId)) {
    throw new AgentBankError(
      "mainnet_locked",
      `Chain ${chainId} is a mainnet. Agent Bank is testnet-only until the Phase 5 gate.`,
    );
  }
  const chain = Object.values(CHAINS).find((c) => c.id === chainId);
  if (!chain) throw new AgentBankError("unsupported_chain", `Chain ${chainId} is not supported`);
  return chain;
}

export function chainByName(name: string): ChainInfo {
  if (!Object.hasOwn(CHAINS, name)) {
    throw new AgentBankError("unsupported_chain", `Unknown chain "${name}"`);
  }
  const chain = CHAINS[name as ChainName];
  assertTestnet(chain.id);
  return chain;
}

export function chainById(chainId: number): ChainInfo {
  return assertTestnet(chainId);
}

export const CHAIN_NAMES = Object.keys(CHAINS) as ChainName[];
