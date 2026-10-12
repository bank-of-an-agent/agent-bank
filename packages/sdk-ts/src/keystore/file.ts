import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { assertTestnet } from "@agentbank/core";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { InvalidRequestError, PermissionDeniedError } from "../errors";
import { assertKeyName, assertPrivateKey, type KeyStore } from "./memory";

/** Options of {@link FileKeyStore}. */
export interface FileKeyStoreOptions {
  /** Path of the key file, e.g. `~/.agentbank/agent.keystore.json`. Created with mode 0600. */
  path: string;
  /** Chain the keys are for (default 84532, Base Sepolia). Mainnet chain ids are refused. */
  chainId?: number;
}

interface KeyFileEntry {
  private_key: Hex;
  address: string;
  created_at: string;
}

interface KeyFile {
  version: 1;
  warning: string;
  chain_id: number;
  keys: Record<string, KeyFileEntry>;
}

const WARNING =
  "TESTNET KEYS ONLY. Plaintext secp256k1 private keys for Agent Bank session/spend keys. Never commit, share or reuse on mainnet.";

/**
 * File-backed key store for agent runtimes (Node only:
 * `import { FileKeyStore } from "@agentbank/sdk/node"`).
 *
 * Security properties:
 * - The file is created with mode `0600` inside a directory created with
 *   `0700`, and rewritten atomically (temp file + rename).
 * - It **refuses to read** a key file that is readable or writable by group
 *   or others, or owned by another user (like OpenSSH does for private
 *   keys). Fix with `chmod 600 <file>`.
 * - Keys are stored in plaintext: **testnet keys only**. The file records its
 *   chain id and mainnet chain ids are refused.
 *
 * POSIX permission checks are skipped on Windows, where modes are not enforced.
 */
export class FileKeyStore implements KeyStore {
  readonly path: string;
  readonly chainId: number;

  constructor(options: FileKeyStoreOptions) {
    if (!options.path) throw new InvalidRequestError("invalid_request", "FileKeyStore needs a path");
    this.path = options.path;
    this.chainId = options.chainId ?? 84532;
    assertTestnet(this.chainId);
  }

  /** The private key stored under `name`, or `undefined` (refuses unsafe files). */
  async get(name: string): Promise<Hex | undefined> {
    assertKeyName(name);
    const file = await this.#read();
    return file?.keys[name]?.private_key;
  }

  /** Store a key under `name` (atomic rewrite, mode 0600). */
  async set(name: string, privateKey: Hex): Promise<void> {
    assertKeyName(name);
    assertPrivateKey(privateKey);
    const file = (await this.#read()) ?? this.#empty();
    file.keys[name] = {
      private_key: privateKey,
      address: privateKeyToAccount(privateKey).address,
      created_at: new Date().toISOString(),
    };
    await this.#write(file);
  }

  /** Remove a key; resolves `true` if it existed. */
  async delete(name: string): Promise<boolean> {
    assertKeyName(name);
    const file = await this.#read();
    if (!file?.keys[name]) return false;
    delete file.keys[name];
    await this.#write(file);
    return true;
  }

  /** Names of the stored keys. */
  async list(): Promise<string[]> {
    const file = await this.#read();
    return Object.keys(file?.keys ?? {}).sort();
  }

  /** Addresses of the stored keys (public information), by name. */
  async addresses(): Promise<Record<string, string>> {
    const file = await this.#read();
    return Object.fromEntries(Object.entries(file?.keys ?? {}).map(([name, entry]) => [name, entry.address]));
  }

  /** Never serialize keys. */
  toJSON(): { path: string; chainId: number } {
    return { path: this.path, chainId: this.chainId };
  }

  #empty(): KeyFile {
    return { version: 1, warning: WARNING, chain_id: this.chainId, keys: {} };
  }

  async #read(): Promise<KeyFile | undefined> {
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!info.isFile()) {
      throw new InvalidRequestError("invalid_request", `Key store ${this.path} is not a regular file`);
    }
    if (process.platform !== "win32") {
      if ((info.mode & 0o077) !== 0) {
        throw new PermissionDeniedError(
          "forbidden",
          `Refusing to use key store ${this.path}: it is accessible by group or others (mode ${(info.mode & 0o777).toString(8)}). Run: chmod 600 ${this.path}`,
        );
      }
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid) {
        throw new PermissionDeniedError(
          "forbidden",
          `Refusing to use key store ${this.path}: it is owned by another user`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      throw new InvalidRequestError("invalid_request", `Key store ${this.path} is not valid JSON`);
    }
    const file = parsed as Partial<KeyFile>;
    if (file.version !== 1 || typeof file.keys !== "object" || file.keys === null) {
      throw new InvalidRequestError("invalid_request", `Key store ${this.path} has an unknown format`);
    }
    const chainId = typeof file.chain_id === "number" ? file.chain_id : this.chainId;
    assertTestnet(chainId);
    if (chainId !== this.chainId) {
      throw new InvalidRequestError(
        "invalid_request",
        `Key store ${this.path} holds keys for chain ${chainId}, not ${this.chainId}`,
      );
    }
    for (const entry of Object.values(file.keys)) assertPrivateKey(entry?.private_key);
    return { version: 1, warning: WARNING, chain_id: chainId, keys: { ...file.keys } };
  }

  async #write(file: KeyFile): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temp, 0o600);
      await rename(temp, this.path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
