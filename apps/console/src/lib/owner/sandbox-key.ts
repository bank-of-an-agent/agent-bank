import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Sandbox owner key: a locally generated secp256k1 key for testnet orgs,
 * stored in this browser's localStorage and never sent anywhere. It exists
 * so sandbox users can try owner-signed flows without a wallet. Every UI that
 * shows it labels it "testnet only".
 */

const STORAGE_KEY = "agentbank.sandbox-owner-key.v1";

export interface SandboxKey {
  privateKey: Hex;
  address: Address;
  createdAt: string;
  /** Always "testnet-only"; kept in storage so the label travels with the key. */
  label: "testnet-only";
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isHexKey(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** The stored value as-is (cheap; used to detect changes). */
export function sandboxKeyRaw(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function loadSandboxKey(raw: string | null = sandboxKeyRaw()): SandboxKey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SandboxKey>;
    if (!isHexKey(parsed.privateKey)) return null;
    const address = privateKeyToAccount(parsed.privateKey).address;
    return {
      privateKey: parsed.privateKey,
      address,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      label: "testnet-only",
    };
  } catch {
    return null;
  }
}

function save(key: SandboxKey): SandboxKey {
  const store = storage();
  if (!store) throw new Error("This browser blocks local storage, so a sandbox key cannot be kept.");
  store.setItem(STORAGE_KEY, JSON.stringify(key));
  return key;
}

export function createSandboxKey(): SandboxKey {
  const privateKey = generatePrivateKey();
  return save({
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    createdAt: new Date().toISOString(),
    label: "testnet-only",
  });
}

export function importSandboxKey(input: string): SandboxKey {
  const value = input.trim();
  const privateKey = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!isHexKey(privateKey)) throw new Error("A private key is 32 bytes of hex (64 characters).");
  return save({
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    createdAt: new Date().toISOString(),
    label: "testnet-only",
  });
}

export function forgetSandboxKey(): void {
  storage()?.removeItem(STORAGE_KEY);
}
