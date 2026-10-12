/**
 * Strict DER readers for the two structures AWS KMS returns for an
 * `ECC_SECG_P256K1` key: the public key as a SubjectPublicKeyInfo (RFC 5480)
 * and signatures as `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }`
 * (RFC 3279). Anything that is not exactly that shape is rejected: the
 * co-signer would rather fail to start (or fail to sign) than sign with a key
 * it misread.
 */

/** Order of the secp256k1 group. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Ethereum requires `s <= n / 2` (EIP-2); larger values are malleable twins. */
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;
/** Field prime of secp256k1. */
export const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;

/** 1.2.840.10045.2.1 (id-ecPublicKey). */
const OID_EC_PUBLIC_KEY = Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
/** 1.3.132.0.10 (secp256k1). */
const OID_SECP256K1 = Uint8Array.from([0x2b, 0x81, 0x04, 0x00, 0x0a]);

export class DerError extends Error {
  constructor(message: string) {
    super(`DER: ${message}`);
    this.name = "DerError";
  }
}

interface Tlv {
  tag: number;
  value: Uint8Array;
  /** Offset just past this element in the buffer it was read from. */
  end: number;
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (offset + 2 > bytes.length) throw new DerError("truncated element");
  const tag = bytes[offset] as number;
  const first = bytes[offset + 1] as number;
  let pos = offset + 2;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    // Indefinite (0x80) and absurdly long lengths are not DER for these structures.
    if (count === 0 || count > 2) throw new DerError("unsupported length encoding");
    if (pos + count > bytes.length) throw new DerError("truncated length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[pos + i] as number);
    if (length < 0x80 || bytes[pos] === 0) throw new DerError("non-minimal length encoding");
    pos += count;
  }
  const end = pos + length;
  if (end > bytes.length) throw new DerError("element overruns its container");
  return { tag, value: bytes.subarray(pos, end), end };
}

function expectTag(tlv: Tlv, tag: number, what: string): Tlv {
  if (tlv.tag !== tag) {
    throw new DerError(`expected ${what} (tag 0x${tag.toString(16)}), got tag 0x${tlv.tag.toString(16)}`);
  }
  return tlv;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

/** A DER INTEGER that must be positive and minimally encoded. */
function readPositiveInteger(value: Uint8Array, what: string): bigint {
  if (value.length === 0) throw new DerError(`${what} is empty`);
  const first = value[0] as number;
  if (first & 0x80) throw new DerError(`${what} is negative`);
  if (first === 0 && value.length > 1 && ((value[1] as number) & 0x80) === 0) {
    throw new DerError(`${what} has a superfluous leading zero`);
  }
  return toBigInt(value);
}

/** Parse a DER `ECDSA-Sig-Value` into `r` and `s` (both in `[1, n-1]`). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const seq = expectTag(readTlv(der, 0), TAG_SEQUENCE, "SEQUENCE");
  if (seq.end !== der.length) throw new DerError("trailing bytes after signature");
  const rTlv = expectTag(readTlv(seq.value, 0), TAG_INTEGER, "INTEGER r");
  const sTlv = expectTag(readTlv(seq.value, rTlv.end), TAG_INTEGER, "INTEGER s");
  if (sTlv.end !== seq.value.length) throw new DerError("trailing bytes inside signature");
  const r = readPositiveInteger(rTlv.value, "r");
  const s = readPositiveInteger(sTlv.value, "s");
  if (r === 0n || r >= SECP256K1_N) throw new DerError("r is out of range");
  if (s === 0n || s >= SECP256K1_N) throw new DerError("s is out of range");
  return { r, s };
}

/** Normalize `s` to the lower half of the group order (EIP-2). */
export function normalizeLowS(s: bigint): bigint {
  return s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
}

/** Whether `(x, y)` is a point on secp256k1 (`y² = x³ + 7 mod p`). */
export function isOnSecp256k1(x: bigint, y: bigint): boolean {
  if (x <= 0n || x >= SECP256K1_P || y <= 0n || y >= SECP256K1_P) return false;
  const p = SECP256K1_P;
  return (y * y - (x * x * x + 7n)) % p === 0n;
}

/**
 * Parse a DER SubjectPublicKeyInfo holding an uncompressed secp256k1 public
 * key and return the 65-byte SEC1 point (`0x04 || X || Y`).
 */
export function parseSecp256k1Spki(der: Uint8Array): Uint8Array {
  const spki = expectTag(readTlv(der, 0), TAG_SEQUENCE, "SubjectPublicKeyInfo SEQUENCE");
  if (spki.end !== der.length) throw new DerError("trailing bytes after SubjectPublicKeyInfo");
  const algorithm = expectTag(readTlv(spki.value, 0), TAG_SEQUENCE, "AlgorithmIdentifier SEQUENCE");
  const keyType = expectTag(readTlv(algorithm.value, 0), TAG_OID, "algorithm OID");
  const curve = expectTag(readTlv(algorithm.value, keyType.end), TAG_OID, "curve OID");
  if (curve.end !== algorithm.value.length) throw new DerError("unexpected AlgorithmIdentifier parameters");
  if (!equalBytes(keyType.value, OID_EC_PUBLIC_KEY)) throw new DerError("key is not an EC public key");
  if (!equalBytes(curve.value, OID_SECP256K1)) throw new DerError("key is not on secp256k1");
  const bits = expectTag(readTlv(spki.value, algorithm.end), TAG_BIT_STRING, "subjectPublicKey BIT STRING");
  if (bits.end !== spki.value.length) throw new DerError("trailing bytes inside SubjectPublicKeyInfo");
  if (bits.value.length !== 66 || bits.value[0] !== 0x00) {
    throw new DerError("public key must be a 65-byte uncompressed point");
  }
  const point = bits.value.subarray(1);
  if (point[0] !== 0x04) throw new DerError("public key must be uncompressed (0x04 prefix)");
  const x = toBigInt(point.subarray(1, 33));
  const y = toBigInt(point.subarray(33, 65));
  if (!isOnSecp256k1(x, y)) throw new DerError("public key is not a point on secp256k1");
  return Uint8Array.from(point);
}
