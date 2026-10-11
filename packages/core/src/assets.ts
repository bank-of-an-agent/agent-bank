import { getAddress, type Address } from "viem";
import { AgentBankError } from "./errors";
import { assertTestnet, CHAINS } from "./chains";
import { formatAmount, parseAmount, parsePositiveAmount, type Money } from "./money";

export const ASSET_CODES = ["USDC"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

export interface AssetInfo {
  code: AssetCode;
  chainId: number;
  address: Address;
  decimals: number;
  /** EIP-712 domain used by EIP-3009 transferWithAuthorization. */
  eip712: { name: string; version: string };
}

/** Decimals are a property of the asset, identical on every supported chain. */
export const ASSET_DECIMALS: Record<AssetCode, number> = { USDC: 6 };

const registry = new Map<string, AssetInfo>();

function key(chainId: number, code: AssetCode): string {
  return `${chainId}:${code}`;
}

/** Register (or override) an asset deployment, e.g. a MockUSDC deployed on Anvil. */
export function registerAsset(info: AssetInfo): void {
  assertTestnet(info.chainId);
  registry.set(key(info.chainId, info.code), { ...info, address: getAddress(info.address) });
}

registerAsset({
  code: "USDC",
  chainId: CHAINS["base-sepolia"].id,
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
  eip712: { name: "USDC", version: "2" },
});

registerAsset({
  code: "USDC",
  chainId: CHAINS.simulated.id,
  address: "0x5dc0000000000000000000000000000000005dc0",
  decimals: 6,
  eip712: { name: "USDC", version: "2" },
});

export function isAssetCode(value: unknown): value is AssetCode {
  return typeof value === "string" && (ASSET_CODES as readonly string[]).includes(value);
}

export function assertAssetCode(value: string): AssetCode {
  if (!isAssetCode(value)) throw new AgentBankError("unsupported_asset", `Asset "${value}" is not supported`);
  return value;
}

export function getAsset(chainId: number, code: string): AssetInfo {
  const asset = registry.get(key(chainId, assertAssetCode(code)));
  if (!asset) {
    throw new AgentBankError("unsupported_asset", `Asset ${code} is not configured on chain ${chainId}`);
  }
  return asset;
}

export function findAssetByAddress(chainId: number, address: string): AssetInfo | undefined {
  const normalized = address.toLowerCase();
  for (const asset of registry.values()) {
    if (asset.chainId === chainId && asset.address.toLowerCase() === normalized) return asset;
  }
  return undefined;
}

export function decimalsOf(code: string): number {
  return ASSET_DECIMALS[assertAssetCode(code)];
}

/** Convert wire money to minor units for its asset. */
export function toMinor(money: Money): bigint {
  return parseAmount(money.amount, decimalsOf(money.asset));
}

/** Convert wire money that must be positive to minor units. */
export function toPositiveMinor(money: Money): bigint {
  return parsePositiveAmount(money.amount, decimalsOf(money.asset));
}

/** Build wire money from minor units. */
export function money(minor: bigint, asset: AssetCode = "USDC"): Money {
  return { amount: formatAmount(minor, ASSET_DECIMALS[asset]), asset };
}

/** Minor units for a whole-dollar figure (handy in tests and defaults). */
export function usdc(amount: string): bigint {
  return parseAmount(amount, ASSET_DECIMALS.USDC);
}
