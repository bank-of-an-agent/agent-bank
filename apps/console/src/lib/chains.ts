import { CHAINS, LOCKED_MAINNET_CHAIN_IDS, type ChainInfo } from "@agentbank/core";

/** Chain display and block explorer links. Testnets only; mainnet ids are refused. */

export function chainInfo(chain: string | number | null | undefined): ChainInfo | undefined {
  if (chain === null || chain === undefined) return undefined;
  if (typeof chain === "number") {
    if (LOCKED_MAINNET_CHAIN_IDS.includes(chain)) return undefined;
    return Object.values(CHAINS).find((c) => c.id === chain);
  }
  return Object.hasOwn(CHAINS, chain) ? CHAINS[chain as keyof typeof CHAINS] : undefined;
}

export function chainLabel(chain: string | number | null | undefined): string {
  return chainInfo(chain)?.displayName ?? (chain === null || chain === undefined ? "—" : String(chain));
}

export function explorerAddressUrl(
  chain: string | number | null | undefined,
  address: string,
): string | null {
  const base = chainInfo(chain)?.explorerUrl;
  return base ? `${base}/address/${address}` : null;
}

export function explorerTxUrl(chain: string | number | null | undefined, hash: string): string | null {
  const base = chainInfo(chain)?.explorerUrl;
  return base ? `${base}/tx/${hash}` : null;
}
