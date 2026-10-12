import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import { InvalidRequestError } from "../errors";
import { isPrivateKey } from "../signers";

/**
 * Key storage for session and spend keys.
 *
 * Keys are named (e.g. `"session"`, `"session:ses_…"`, `"spend"`). Store
 * only testnet keys: Agent Bank is testnet-only, and these stores are meant
 * for agent runtimes and development, not for owner keys (use a hardware
 * wallet or passkey for those).
 *
 * @packageDocumentation
 */

/** A named store of secp256k1 private keys. */
export interface KeyStore {
  /** The private key stored under `name`, or `undefined`. */
  get(name: string): Promise<Hex | undefined>;
  /** Store (or replace) a private key under `name`. */
  set(name: string, privateKey: Hex): Promise<void>;
  /** Remove a key; resolves `true` if it existed. */
  delete(name: string): Promise<boolean>;
  /** Names of the stored keys. */
  list(): Promise<string[]>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** Validate a key name (letters, digits, `:._-`, at most 128 characters). */
export function assertKeyName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new InvalidRequestError(
      "invalid_request",
      "Key names use letters, digits and :._- (max 128 characters)",
    );
  }
}

/** Validate a private key without echoing it. */
export function assertPrivateKey(value: unknown): asserts value is Hex {
  if (!isPrivateKey(value)) {
    throw new InvalidRequestError("invalid_request", "Private key must be 0x-prefixed 32-byte hex");
  }
}

/** In-memory key store: keys live only as long as the process. Handy for tests and ephemeral agents. */
export class MemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, Hex>();

  /** The private key stored under `name`, or `undefined`. */
  async get(name: string): Promise<Hex | undefined> {
    assertKeyName(name);
    return this.#keys.get(name);
  }

  /** Store (or replace) a key under `name`. */
  async set(name: string, privateKey: Hex): Promise<void> {
    assertKeyName(name);
    assertPrivateKey(privateKey);
    this.#keys.set(name, privateKey);
  }

  /** Remove a key; resolves `true` if it existed. */
  async delete(name: string): Promise<boolean> {
    assertKeyName(name);
    return this.#keys.delete(name);
  }

  /** Names of the stored keys, sorted. */
  async list(): Promise<string[]> {
    return [...this.#keys.keys()].sort();
  }

  /** Never serialize keys. */
  toJSON(): { keys: string[] } {
    return { keys: [...this.#keys.keys()].sort() };
  }
}

/**
 * Load the key stored under `name`, generating and storing a new one if
 * there is none. Returns a viem account usable as a session or spend signer.
 */
export async function loadOrCreateKey(store: KeyStore, name: string): Promise<PrivateKeyAccount> {
  const existing = await store.get(name);
  if (existing) return privateKeyToAccount(existing);
  const created = generatePrivateKey();
  await store.set(name, created);
  return privateKeyToAccount(created);
}

/** Load the key stored under `name` as a viem account, or `undefined`. */
export async function loadKey(store: KeyStore, name: string): Promise<PrivateKeyAccount | undefined> {
  const existing = await store.get(name);
  return existing ? privateKeyToAccount(existing) : undefined;
}
