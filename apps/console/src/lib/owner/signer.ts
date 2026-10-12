import { assertTestnet } from "@agentbank/core";
import {
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";

/**
 * The principal's owner key, as the console uses it: sign EIP-712 typed data
 * (`OwnerAuthorization`, and TimeLockVaults' `EarlyWithdrawal`) and EIP-191
 * personal signatures over owner-operation `user_op_hash`es. The key never
 * leaves the wallet (or, for the sandbox key, the browser); the console only
 * ever sees signatures. Typed data must name a testnet chain id.
 */
export interface OwnerSigner {
  kind: "injected" | "sandbox";
  address: Address;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
  /** EIP-191 personal signature over raw 32 bytes (the owner validator's format). */
  signHash(hash: Hex): Promise<Hex>;
}

export class OwnerKeyError extends Error {
  constructor(
    readonly code: "no_wallet" | "rejected" | "wrong_chain" | "no_account" | "invalid_key",
    message: string,
  ) {
    super(message);
    this.name = "OwnerKeyError";
  }
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && typeof window.ethereum?.request === "function";
}

function rejected(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === 4001 || causeCode === 4001;
}

const KNOWN_CHAINS = { [baseSepolia.id]: baseSepolia, [anvil.id]: anvil } as const;

/** Ask the wallet to switch to the domain chain; wallets refuse typed data for another chain. */
async function ensureChain(client: ReturnType<typeof createWalletClient>, chainId: number): Promise<void> {
  assertTestnet(chainId);
  const current = await client.getChainId();
  if (current === chainId) return;
  try {
    await client.switchChain({ id: chainId });
  } catch (error) {
    const known = KNOWN_CHAINS[chainId as keyof typeof KNOWN_CHAINS];
    const unknownChain = (error as { code?: unknown } | null)?.code === 4902;
    if (unknownChain && known) {
      await client.addChain({ chain: known });
      return;
    }
    if (rejected(error)) throw new OwnerKeyError("rejected", "The wallet declined to switch networks.");
    throw new OwnerKeyError(
      "wrong_chain",
      `Switch your wallet to chain ${chainId} to sign. Testnet only: Agent Bank never asks for a mainnet signature.`,
    );
  }
}

export async function connectInjected(options: { prompt: boolean }): Promise<OwnerSigner | null> {
  if (!hasInjectedWallet() || !window.ethereum) {
    throw new OwnerKeyError(
      "no_wallet",
      "No browser wallet found. Install one or use the sandbox owner key.",
    );
  }
  const client = createWalletClient({ transport: custom(window.ethereum) });
  let addresses: readonly Address[];
  try {
    addresses = options.prompt ? await client.requestAddresses() : await client.getAddresses();
  } catch (error) {
    if (rejected(error)) throw new OwnerKeyError("rejected", "The wallet connection was declined.");
    throw error;
  }
  const address = addresses[0];
  if (!address) {
    if (!options.prompt) return null;
    throw new OwnerKeyError("no_account", "The wallet did not share an account.");
  }
  return {
    kind: "injected",
    address,
    async signTypedData(typedData) {
      await ensureChain(client, Number(typedData.domain?.chainId));
      try {
        return await client.signTypedData({ account: address, ...typedData });
      } catch (error) {
        if (rejected(error))
          throw new OwnerKeyError("rejected", "The signature request was declined in the wallet.");
        throw error;
      }
    },
    async signHash(hash) {
      try {
        return await client.signMessage({ account: address, message: { raw: hash } });
      } catch (error) {
        if (rejected(error))
          throw new OwnerKeyError("rejected", "The signature request was declined in the wallet.");
        throw error;
      }
    },
  };
}

/** A testnet-only owner key kept in this browser (sandbox mode). */
export function sandboxSigner(privateKey: Hex): OwnerSigner {
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    throw new OwnerKeyError("invalid_key", "The stored sandbox owner key is not a valid private key.");
  }
  return {
    kind: "sandbox",
    address: account.address,
    async signTypedData(typedData) {
      assertTestnet(Number(typedData.domain?.chainId));
      return account.signTypedData(typedData);
    },
    async signHash(hash) {
      return account.signMessage({ message: { raw: hash } });
    },
  };
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
