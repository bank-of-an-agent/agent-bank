import { bytesToHex, randomBytes } from "@agentbank/core";
import { encodeAbiParameters, getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { MAX_U64, SNARK_SCALAR_FIELD } from "./schema";

/**
 * Field elements and scopes. Everything the circuit sees is an element of the BN254 scalar
 * field (below r); on the wire those are 32-byte big-endian hex strings ("bytes32").
 */

export const SCOPE_DOMAIN = "agentbank.proofs.scope.v1";
export const MAX_SCOPE_LENGTH = 253;

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]{1,64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

export function isFieldElement(value: bigint): boolean {
  return value >= 0n && value < SNARK_SCALAR_FIELD;
}

/** A value as 0x-prefixed, zero-padded 32-byte big-endian hex (lowercase). */
export function toBytes32(value: bigint): Hex {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("value does not fit in 32 bytes");
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** Parse 0x-prefixed 32-byte hex (either case) into a bigint. */
export function fromBytes32(value: string): bigint {
  if (!BYTES32_RE.test(value)) throw new RangeError("expected 0x-prefixed 32-byte hex");
  return BigInt(value);
}

/**
 * Parse a field element given as a bigint, a 0x hex string (up to 32 bytes) or a base-10
 * string. Throws a RangeError unless the value is below r.
 */
export function toField(value: bigint | string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (HEX_RE.test(value)) parsed = BigInt(value);
  else if (DECIMAL_RE.test(value) && value.length <= 78) parsed = BigInt(value);
  else throw new RangeError("expected a field element as bigint, 0x hex or base-10 string");
  if (!isFieldElement(parsed)) throw new RangeError("value is not below the BN254 scalar field order");
  return parsed;
}

/**
 * An on-chain scope id: `eip155:<chainId>:<consumer>:<context>`, with the chain id in base 10
 * (1 to 32 digits, no leading zero), the consumer as 0x + 40 hex digits and the context as 0x +
 * 64 hex digits (either case). Host names never contain ":", so no HTTP scope looks like one.
 */
const ONCHAIN_SCOPE_ID_RE = /^eip155:([1-9][0-9]{0,31}):(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{64})$/;

/** The parts of an on-chain scope id. */
export interface OnchainScopeRef {
  chainId: bigint;
  /** The consuming contract, checksummed. */
  consumer: Address;
  /** The consumer's 32-byte context, lowercase. */
  context: Hex;
}

/**
 * The scope id of an on-chain consumer (`msg.sender` of `AgentClaimsVerifier.verifyAndConsume`
 * on chain `chainId`, with `context`): `eip155:<chainId>:<consumer>:<context>`, hex in lowercase.
 * Proof requests carry it as `scope`; `scopeField` maps it to `scopeOf(consumer, context)`.
 */
export function onchainScopeId(chainId: number | bigint, consumer: string, context: string): string {
  const chain = typeof chainId === "number" && Number.isSafeInteger(chainId) ? BigInt(chainId) : chainId;
  if (typeof chain !== "bigint" || chain < 1n || chain.toString().length > 32) {
    throw new RangeError("chainId must be a positive integer of at most 32 digits");
  }
  if (typeof consumer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(consumer)) {
    throw new RangeError("consumer must be a 0x-prefixed 20-byte hex address");
  }
  if (typeof context !== "string" || !BYTES32_RE.test(context)) {
    throw new RangeError("context must be 0x-prefixed 32-byte hex");
  }
  return `eip155:${chain}:${consumer.toLowerCase()}:${context.toLowerCase()}`;
}

/** The chain, consumer and context of an on-chain scope id; null for any other scope. */
export function parseOnchainScopeId(scopeId: string): OnchainScopeRef | null {
  const match = typeof scopeId === "string" ? ONCHAIN_SCOPE_ID_RE.exec(scopeId) : null;
  if (match === null) return null;
  const [, chain, consumer, context] = match as unknown as [string, string, string, string];
  return {
    chainId: BigInt(chain),
    consumer: getAddress(consumer.toLowerCase()),
    context: context.toLowerCase() as Hex,
  };
}

/** Whether `scopeId` is an on-chain scope id (`eip155:<chainId>:<consumer>:<context>`). */
export function isOnchainScopeId(scopeId: string): boolean {
  return parseOnchainScopeId(scopeId) !== null;
}

/**
 * The field element of a scope id (1 to 253 characters):
 *
 * - an on-chain scope id `eip155:<chainId>:<consumer>:<context>` maps to
 *   `onchainScope(chainId, consumer, context)`, which equals
 *   `AgentClaimsVerifier.scopeOf(consumer, context)` on that chain;
 * - any other identifier (an HTTP verifier's host name) maps to
 *   keccak256(utf8("agentbank.proofs.scope.v1:" + scopeId)) mod r.
 */
export function scopeField(scopeId: string): bigint {
  if (typeof scopeId !== "string" || scopeId.length === 0 || scopeId.length > MAX_SCOPE_LENGTH) {
    throw new RangeError(`scope must be 1 to ${MAX_SCOPE_LENGTH} characters`);
  }
  const onchain = parseOnchainScopeId(scopeId);
  if (onchain !== null) return onchainScope(onchain.chainId, onchain.consumer, onchain.context);
  return BigInt(keccak256(stringToBytes(`${SCOPE_DOMAIN}:${scopeId}`))) % SNARK_SCALAR_FIELD;
}

/**
 * The scope of an on-chain consumer, equal to `AgentClaimsVerifier.scopeOf(consumer, context)`
 * on chain `chainId`: keccak256(abi.encode("agentbank.proofs.scope.v1", chainId, consumer,
 * context)) mod r. Requests name it with `onchainScopeId(chainId, consumer, context)`.
 */
export function onchainScope(chainId: number | bigint, consumer: Address, context: Hex): bigint {
  if (!BYTES32_RE.test(context)) throw new RangeError("context must be 0x-prefixed 32-byte hex");
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
    [SCOPE_DOMAIN, BigInt(chainId), getAddress(consumer), context],
  );
  return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

/** The 64-bit tag a reservation stores for a scope: scope mod 2^64. */
export function scopeTag(scope: bigint): bigint {
  return scope & MAX_U64;
}

/** `scopeTag(scopeField(scopeId))`. */
export function scopeTagOf(scopeId: string): bigint {
  return scopeTag(scopeField(scopeId));
}

/** A fresh 31-byte nonce as 0x + 62 lowercase hex digits (always below r). */
export function randomNonce(): Hex {
  return bytesToHex(randomBytes(31));
}

/** A request nonce (0x + 62 hex digits) as a field element. */
export function nonceField(nonce: string): bigint {
  if (!/^0x[0-9a-fA-F]{62}$/.test(nonce)) throw new RangeError("nonce must be 31 bytes of 0x-prefixed hex");
  return BigInt(nonce);
}
