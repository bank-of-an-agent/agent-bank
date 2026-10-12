import {
  GetPublicKeyCommand,
  SignCommand,
  type GetPublicKeyCommandOutput,
  type SignCommandOutput,
} from "@aws-sdk/client-kms";
import {
  bytesToHex,
  hashMessage,
  hexToBytes,
  isAddressEqual,
  numberToHex,
  recoverAddress,
  serializeSignature,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { normalizeLowS, parseDerSignature, parseSecp256k1Spki } from "./der";
import { assertBytes32, type CosignerSigner } from "./types";

/**
 * The two KMS operations the co-signer uses. `KMSClient` from
 * `@aws-sdk/client-kms` satisfies it; tests pass a mock backed by a local key.
 */
export interface KmsClientLike {
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>;
  send(command: SignCommand): Promise<SignCommandOutput>;
}

export interface KmsSignerOptions {
  client: KmsClientLike;
  /** Key id, ARN or alias of an `ECC_SECG_P256K1` / `SIGN_VERIFY` key. */
  keyId: string;
}

/**
 * Co-signer key in AWS KMS (`ECC_SECG_P256K1`, non-exportable). The address
 * is derived from the key's DER SubjectPublicKeyInfo; signing sends the
 * EIP-191 digest of the user operation hash with `MessageType: DIGEST` and
 * `ECDSA_SHA_256` (KMS signs the 32 bytes as given), then converts KMS's DER
 * signature to Ethereum's `r || s || v`: `s` normalized to the lower half
 * order and `v` found by recovering against the key's address.
 */
export class KmsSigner implements CosignerSigner {
  readonly kind = "kms" as const;
  readonly address: Address;
  readonly #client: KmsClientLike;
  readonly #keyId: string;

  private constructor(address: Address, client: KmsClientLike, keyId: string) {
    this.address = address;
    this.#client = client;
    this.#keyId = keyId;
  }

  static async create(options: KmsSignerOptions): Promise<KmsSigner> {
    if (options.keyId.trim() === "") throw new Error("KmsSigner needs a KMS key id");
    const out = await options.client.send(new GetPublicKeyCommand({ KeyId: options.keyId }));
    if (out.KeySpec !== undefined && out.KeySpec !== "ECC_SECG_P256K1") {
      throw new Error(`KMS key ${options.keyId} has key spec ${out.KeySpec}; ECC_SECG_P256K1 is required`);
    }
    if (out.KeyUsage !== undefined && out.KeyUsage !== "SIGN_VERIFY") {
      throw new Error(`KMS key ${options.keyId} has key usage ${out.KeyUsage}; SIGN_VERIFY is required`);
    }
    if (out.SigningAlgorithms !== undefined && !out.SigningAlgorithms.includes("ECDSA_SHA_256")) {
      throw new Error(`KMS key ${options.keyId} does not support ECDSA_SHA_256`);
    }
    if (!out.PublicKey) throw new Error(`KMS returned no public key for ${options.keyId}`);
    const point = parseSecp256k1Spki(out.PublicKey);
    return new KmsSigner(publicKeyToAddress(bytesToHex(point)), options.client, options.keyId);
  }

  async signHash(hash: Hex): Promise<Hex> {
    assertBytes32(hash);
    const digest = hashMessage({ raw: hash });
    const out = await this.#client.send(
      new SignCommand({
        KeyId: this.#keyId,
        Message: hexToBytes(digest),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!out.Signature) throw new Error("KMS returned no signature");
    return derSignatureToEthereum(out.Signature, digest, this.address);
  }
}

/**
 * Convert a DER ECDSA signature over `digest` into a 65-byte Ethereum
 * signature for `address`: low-s normalization, then the recovery bit that
 * recovers `address`. Throws if neither parity does (wrong key or digest).
 */
export async function derSignatureToEthereum(der: Uint8Array, digest: Hex, address: Address): Promise<Hex> {
  const { r, s } = parseDerSignature(der);
  const rHex = numberToHex(r, { size: 32 });
  const sHex = numberToHex(normalizeLowS(s), { size: 32 });
  for (const yParity of [0, 1] as const) {
    const signature = serializeSignature({ r: rHex, s: sHex, yParity });
    const recovered = await recoverAddress({ hash: digest, signature });
    if (isAddressEqual(recovered, address)) return signature;
  }
  throw new Error("KMS signature does not recover to the co-signer address");
}
