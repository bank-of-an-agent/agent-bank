import { signOperationHash } from "@agentbank/chain";
import { assertTestnet } from "@agentbank/core";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { assertBytes32, type CosignerSigner } from "./types";

export interface LocalSignerOptions {
  /** 32-byte hex private key (testnet / development only). */
  privateKey: string;
  /** Chain the co-signer serves; must be a supported testnet. */
  chainId: number;
  /** `process.env.NODE_ENV`; `production` is refused. */
  nodeEnv: string | undefined;
}

/**
 * A co-signer key held in process memory. For tests, local development and
 * the testnet sandbox only: it refuses to exist when `NODE_ENV=production`
 * or when the chain is not a testnet. Production uses {@link KmsSigner}, so
 * no human or process ever holds the signing material.
 */
export class LocalSigner implements CosignerSigner {
  readonly kind = "local" as const;
  readonly address: Address;
  readonly #account: PrivateKeyAccount;

  private constructor(account: PrivateKeyAccount) {
    this.#account = account;
    this.address = account.address;
  }

  static create(options: LocalSignerOptions): LocalSigner {
    if (options.nodeEnv === "production") {
      throw new Error("LocalSigner refuses to start with NODE_ENV=production; use COSIGNER_SIGNER=kms");
    }
    const chain = assertTestnet(options.chainId);
    if (chain.testnet !== true) {
      throw new Error(`LocalSigner refuses to start on chain ${options.chainId}: not a testnet`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey)) {
      throw new Error("LocalSigner needs a 0x-prefixed 32-byte hex private key");
    }
    return new LocalSigner(privateKeyToAccount(options.privateKey as Hex));
  }

  async signHash(hash: Hex): Promise<Hex> {
    assertBytes32(hash);
    // EIP-191 over the raw 32 bytes (core OPERATION_HASH_SIGNING), exactly as session keys sign.
    return signOperationHash(this.#account, hash);
  }
}
