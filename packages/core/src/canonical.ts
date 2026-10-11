import { keccak256, sha256, stringToBytes, type Hex } from "viem";

/**
 * Deterministic JSON (RFC 8785 style): object keys sorted by code point, no
 * insignificant whitespace, `undefined` members dropped, bigints rendered as
 * decimal strings, Dates as ISO 8601. Used to hash policies, mandates,
 * idempotent requests and audit records so every service agrees on bytes.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "object": {
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : serialize(v))).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && typeof v !== "function")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** SHA-256 of the canonical JSON encoding, as 0x-prefixed hex. */
export function canonicalSha256(value: unknown): Hex {
  return sha256(stringToBytes(canonicalJson(value)));
}

/** Keccak-256 of the canonical JSON encoding (used inside EIP-712 messages). */
export function canonicalKeccak(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

/** JSON.stringify replacer that renders bigints as strings. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
