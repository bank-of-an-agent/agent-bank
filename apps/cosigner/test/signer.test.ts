import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  hashMessage,
  hexToBigInt,
  hexToBytes,
  keccak256,
  parseSignature,
  recoverMessageAddress,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  createSigner,
  DerError,
  derSignatureToEthereum,
  KmsSigner,
  LocalSigner,
  normalizeLowS,
  parseDerSignature,
  parseSecp256k1Spki,
  SECP256K1_N,
  type KmsClientLike,
} from "../src/signer";
import { ANVIL_KEYS } from "./keys";

const HALF_N = SECP256K1_N / 2n;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** SubjectPublicKeyInfo DER produced by OpenSSL (node:crypto), independent of the parser under test. */
function opensslSpki(privateKey: Hex): Uint8Array {
  const point = secp256k1.getPublicKey(hexToBytes(privateKey), false);
  const jwk = { kty: "EC", crv: "secp256k1", x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)) };
  return new Uint8Array(createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "der" }));
}

type SMode = "as-is" | "high" | "low" | "alternate";

/**
 * A KMS stand-in backed by a local secp256k1 key. Like KMS with
 * `MessageType: DIGEST`, it signs the 32 bytes it is given without hashing
 * and returns a DER `ECDSA-Sig-Value` whose `s` may be in either half.
 */
class MockKms {
  readonly signed: Uint8Array[] = [];
  #count = 0;

  constructor(
    private readonly privateKey: Hex,
    private readonly options: {
      sMode?: SMode;
      keySpec?: string;
      keyUsage?: string;
      publicKey?: Uint8Array;
    } = {},
  ) {}

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetPublicKeyCommand) {
      return {
        KeyId: command.input.KeyId,
        PublicKey: this.options.publicKey ?? opensslSpki(this.privateKey),
        KeySpec: this.options.keySpec ?? "ECC_SECG_P256K1",
        KeyUsage: this.options.keyUsage ?? "SIGN_VERIFY",
        SigningAlgorithms: ["ECDSA_SHA_256"],
      };
    }
    if (command instanceof SignCommand) {
      const { Message, MessageType, SigningAlgorithm } = command.input;
      if (MessageType !== "DIGEST" || SigningAlgorithm !== "ECDSA_SHA_256" || Message?.length !== 32) {
        throw new Error("mock KMS: unexpected Sign parameters");
      }
      this.signed.push(Message);
      const sig = secp256k1.sign(Message, hexToBytes(this.privateKey), { lowS: false });
      const mode = this.options.sMode ?? "as-is";
      const flipToHigh = mode === "high" || (mode === "alternate" && this.#count % 2 === 0);
      this.#count += 1;
      let s = sig.s;
      if (flipToHigh && s <= HALF_N) s = SECP256K1_N - s;
      if (mode === "low" && s > HALF_N) s = SECP256K1_N - s;
      return {
        KeyId: command.input.KeyId,
        Signature: new secp256k1.Signature(sig.r, s).toDERRawBytes(),
        SigningAlgorithm,
      };
    }
    throw new Error("mock KMS: unexpected command");
  }
}

function kms(privateKey: Hex, options?: ConstructorParameters<typeof MockKms>[1]): MockKms & KmsClientLike {
  return new MockKms(privateKey, options) as MockKms & KmsClientLike;
}

function derInt(value: Uint8Array): Uint8Array {
  return Uint8Array.from([0x02, value.length, ...value]);
}

function derSeq(...parts: Uint8Array[]): Uint8Array {
  const body = parts.flatMap((p) => [...p]);
  return Uint8Array.from([0x30, body.length, ...body]);
}

function bigBytes(value: bigint): Uint8Array {
  return hexToBytes(toHex(value));
}

describe("KmsSigner", () => {
  const key = ANVIL_KEYS.cosigner;
  const expected = privateKeyToAccount(key).address;

  it("derives the address from KMS's DER SubjectPublicKeyInfo", async () => {
    const signer = await KmsSigner.create({ client: kms(key), keyId: "alias/cosigner" });
    expect(signer.address).toBe(expected);
    expect(signer.kind).toBe("kms");
  });

  it("signs the EIP-191 digest with MessageType DIGEST and returns a canonical Ethereum signature", async () => {
    const client = kms(key, { sMode: "high" });
    const signer = await KmsSigner.create({ client, keyId: "k" });
    const hash = keccak256(toHex("user operation"));
    const signature = await signer.signHash(hash);
    expect(bytesToHex(client.signed[0] as Uint8Array)).toBe(hashMessage({ raw: hash }));
    expect(await recoverMessageAddress({ message: { raw: hash }, signature })).toBe(expected);
    const { s, v } = parseSignature(signature);
    expect(hexToBigInt(s) <= HALF_N).toBe(true);
    expect([27n, 28n]).toContain(v);
    expect(hexToBytes(signature)).toHaveLength(65);
  });

  it("matches the local signer byte for byte, whichever half KMS's s falls in", async () => {
    const local = LocalSigner.create({ privateKey: key, chainId: 1337, nodeEnv: "test" });
    for (const sMode of ["high", "low", "alternate"] as const) {
      const signer = await KmsSigner.create({ client: kms(key, { sMode }), keyId: "k" });
      for (let i = 0; i < 24; i++) {
        const hash = keccak256(toHex(`op-${sMode}-${i}`));
        expect(await signer.signHash(hash)).toBe(await local.signHash(hash));
      }
    }
  });

  it("handles DER integers that are shorter than 32 bytes or carry a sign byte", async () => {
    const signer = await KmsSigner.create({ client: kms(key), keyId: "k" });
    const local = LocalSigner.create({ privateKey: key, chainId: 1337, nodeEnv: "test" });
    let shortR = false;
    let paddedR = false;
    for (let i = 0; i < 4000 && !(shortR && paddedR); i++) {
      const hash = keccak256(toHex(`short-${i}`));
      const digest = hashMessage({ raw: hash });
      const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(key), { lowS: false });
      const der = sig.toDERRawBytes();
      const rLength = der[3] as number;
      if (rLength < 32 && !shortR) {
        shortR = true;
        expect(await derSignatureToEthereum(der, digest, signer.address)).toBe(await local.signHash(hash));
      }
      if (rLength === 33 && !paddedR) {
        paddedR = true;
        expect(der[4]).toBe(0);
        expect(await derSignatureToEthereum(der, digest, signer.address)).toBe(await local.signHash(hash));
      }
    }
    expect(shortR && paddedR).toBe(true);
  });

  it("refuses keys that are not secp256k1 signing keys", async () => {
    await expect(
      KmsSigner.create({ client: kms(key, { keySpec: "ECC_NIST_P256" }), keyId: "k" }),
    ).rejects.toThrow(/ECC_SECG_P256K1/);
    await expect(
      KmsSigner.create({ client: kms(key, { keyUsage: "ENCRYPT_DECRYPT" }), keyId: "k" }),
    ).rejects.toThrow(/SIGN_VERIFY/);
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
      type: "spki",
      format: "der",
    });
    await expect(
      KmsSigner.create({ client: kms(key, { publicKey: new Uint8Array(p256) }), keyId: "k" }),
    ).rejects.toThrow(/secp256k1/);
    await expect(KmsSigner.create({ client: kms(key), keyId: " " })).rejects.toThrow(/key id/);
  });

  it("refuses a signature that does not recover to its own address", async () => {
    // KMS reports the co-signer's public key but answers Sign with another key
    // (misrouted key id, tampering): the signature must never be returned.
    const client = kms(ANVIL_KEYS.attacker, { publicKey: opensslSpki(key) });
    const signer = await KmsSigner.create({ client, keyId: "k" });
    expect(signer.address).toBe(expected);
    await expect(signer.signHash(keccak256(toHex("x")))).rejects.toThrow(/does not recover/);
    const digest = hashMessage({ raw: keccak256(toHex("y")) });
    const foreign = secp256k1.sign(hexToBytes(digest), hexToBytes(ANVIL_KEYS.attacker)).toDERRawBytes();
    await expect(derSignatureToEthereum(foreign, digest, expected)).rejects.toThrow(/does not recover/);
  });

  it("only signs 32-byte hashes", async () => {
    const signer = await KmsSigner.create({ client: kms(key), keyId: "k" });
    await expect(signer.signHash("0x1234")).rejects.toThrow(/32-byte/);
  });
});

describe("DER parsing", () => {
  it("parses r and s and normalizes s to the lower half", () => {
    const der = derSeq(derInt(Uint8Array.from([0x01])), derInt(Uint8Array.from([0x00, 0xff])));
    expect(parseDerSignature(der)).toEqual({ r: 1n, s: 255n });
    expect(normalizeLowS(SECP256K1_N - 5n)).toBe(5n);
    expect(normalizeLowS(5n)).toBe(5n);
    expect(normalizeLowS(HALF_N)).toBe(HALF_N);
    expect(normalizeLowS(HALF_N + 1n)).toBe(SECP256K1_N - HALF_N - 1n);
  });

  it("rejects malformed and non-DER signatures", () => {
    const one = derInt(Uint8Array.from([0x01]));
    const cases: [string, Uint8Array][] = [
      ["empty", new Uint8Array()],
      ["not a sequence", Uint8Array.from([0x31, 0x06, ...one, ...one])],
      ["trailing bytes", Uint8Array.from([...derSeq(one, one), 0x00])],
      ["truncated", derSeq(one, one).slice(0, 7)],
      ["negative r", derSeq(derInt(Uint8Array.from([0x80])), one)],
      ["non-minimal r", derSeq(derInt(Uint8Array.from([0x00, 0x01])), one)],
      ["zero r", derSeq(derInt(Uint8Array.from([0x00])), one)],
      ["s >= n", derSeq(one, derInt(Uint8Array.from([0x00, ...bigBytes(SECP256K1_N)])))],
      ["indefinite length", Uint8Array.from([0x30, 0x80, ...one, ...one, 0x00, 0x00])],
      ["three integers", derSeq(one, one, one)],
    ];
    for (const [name, der] of cases) {
      expect(() => parseDerSignature(der), name).toThrow(DerError);
    }
  });

  it("parses an OpenSSL secp256k1 SubjectPublicKeyInfo and rejects anything else", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const point = parseSecp256k1Spki(der);
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(0x04);
    expect(() => parseSecp256k1Spki(Uint8Array.from([...der, 0]))).toThrow(DerError);
    const offCurve = Uint8Array.from(der);
    offCurve[der.length - 1] = (offCurve[der.length - 1] as number) ^ 0x01;
    expect(() => parseSecp256k1Spki(offCurve)).toThrow(/not a point/);
    const compressedHeader = Uint8Array.from(der);
    compressedHeader[der.length - 65] = 0x02;
    expect(() => parseSecp256k1Spki(compressedHeader)).toThrow(/uncompressed/);
    const p256 = new Uint8Array(
      generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }),
    );
    expect(() => parseSecp256k1Spki(p256)).toThrow(/secp256k1/);
    const rsa = new Uint8Array(
      generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }),
    );
    expect(() => parseSecp256k1Spki(rsa)).toThrow(DerError);
  });
});

describe("createSigner", () => {
  it("builds the local signer from configuration and refuses incomplete configurations", async () => {
    const signer = await createSigner({
      kind: "local",
      chainId: 1337,
      nodeEnv: "development",
      privateKey: ANVIL_KEYS.cosigner,
    });
    expect(signer.kind).toBe("local");
    expect(signer.address).toBe(privateKeyToAccount(ANVIL_KEYS.cosigner).address);
    await expect(createSigner({ kind: "local", chainId: 1337, nodeEnv: "development" })).rejects.toThrow(
      /COSIGNER_PRIVATE_KEY/,
    );
    await expect(
      createSigner({ kind: "local", chainId: 1337, nodeEnv: "production", privateKey: ANVIL_KEYS.cosigner }),
    ).rejects.toThrow(/production/);
    await expect(createSigner({ kind: "kms", chainId: 84532, nodeEnv: "production" })).rejects.toThrow(
      /COSIGNER_KMS_KEY_ID/,
    );
  });
});

describe("LocalSigner", () => {
  it("refuses production and non-testnet chains", () => {
    expect(() =>
      LocalSigner.create({ privateKey: ANVIL_KEYS.cosigner, chainId: 1337, nodeEnv: "production" }),
    ).toThrow(/production/);
    expect(() =>
      LocalSigner.create({ privateKey: ANVIL_KEYS.cosigner, chainId: 8453, nodeEnv: "test" }),
    ).toThrow(/mainnet/i);
    expect(() =>
      LocalSigner.create({ privateKey: ANVIL_KEYS.cosigner, chainId: 1, nodeEnv: "development" }),
    ).toThrow(/mainnet/i);
    expect(() =>
      LocalSigner.create({ privateKey: ANVIL_KEYS.cosigner, chainId: 999_999, nodeEnv: "test" }),
    ).toThrow(/not supported/);
    expect(() => LocalSigner.create({ privateKey: "0x1234", chainId: 84532, nodeEnv: "test" })).toThrow(
      /32-byte/,
    );
  });

  it("signs EIP-191 over the raw hash on testnets", async () => {
    for (const chainId of [1337, 31337, 84532]) {
      const signer = LocalSigner.create({ privateKey: ANVIL_KEYS.cosigner, chainId, nodeEnv: "development" });
      const hash = keccak256(toHex(chainId));
      expect(
        await recoverMessageAddress({ message: { raw: hash }, signature: await signer.signHash(hash) }),
      ).toBe(signer.address);
    }
  });
});
