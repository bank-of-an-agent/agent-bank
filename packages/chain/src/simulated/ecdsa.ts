import { secp256k1 } from "@noble/curves/secp256k1";
import {
  getAddress,
  hashMessage,
  hexToBytes,
  keccak256,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
} from "viem";

const N = secp256k1.CURVE.n;
const HALF_N = N / 2n;

/** Recoveries are pure; operations are validated several times (estimate, submit, inclusion, reorgs). */
const recoveryCache = new Map<string, Address | null>();
const RECOVERY_CACHE_LIMIT = 50_000;

/** The EVM `ecrecover` precompile: the signer, or `null` where the precompile returns address(0). */
export function ecrecover(hash: Hex, v: number, r: bigint, s: bigint): Address | null {
  if (v !== 27 && v !== 28) return null;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
  const cacheKey = `${hash}:${v}:${r}:${s}`;
  const cached = recoveryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let signer: Address | null;
  try {
    const point = new secp256k1.Signature(r, s)
      .addRecoveryBit(v - 27)
      .recoverPublicKey(hexToBytes(hash).slice());
    const pub = point.toRawBytes(false);
    signer = getAddress(`0x${keccak256(pub.slice(1)).slice(-40)}`);
  } catch {
    signer = null;
  }
  if (recoveryCache.size >= RECOVERY_CACHE_LIMIT) recoveryCache.clear();
  recoveryCache.set(cacheKey, signer);
  return signer;
}

/** Split a 65-byte `r ‖ s ‖ v` signature; `null` if it is not 65 bytes. */
export function splitSignature(signature: Hex): { r: bigint; s: bigint; v: number } | null {
  if (size(signature) !== 65) return null;
  return {
    r: BigInt(slice(signature, 0, 32)),
    s: BigInt(slice(signature, 32, 64)),
    v: Number(BigInt(slice(signature, 64, 65))),
  };
}

/** OpenZeppelin `ECDSA.recover` semantics (v 27/28, low s): the signer or `null`. */
export function recoverStrict(hash: Hex, signature: Hex): Address | null {
  const parts = splitSignature(signature);
  if (!parts || parts.s > HALF_N) return null;
  return ecrecover(hash, parts.v, parts.r, parts.s);
}

/** `"\x19Ethereum Signed Message:\n32" ‖ hash`, hashed. */
export function ethSignedMessageHash(hash: Hex): Hex {
  return hashMessage({ raw: hash });
}

/** Pack `r, s, v` into a 65-byte signature. */
export function packSignature(r: Hex, s: Hex, v: number): Hex {
  return `${r}${s.slice(2)}${toHex(v, { size: 1 }).slice(2)}` as Hex;
}
