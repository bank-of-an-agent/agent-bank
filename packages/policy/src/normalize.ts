import { AddressSchema, DomainSchema, Erc8004IdSchema, isId } from "@agentbank/core";

/**
 * Identifier normalization.
 *
 * Every identifier the engine compares is reduced to one canonical ASCII form
 * first; anything that cannot be canonicalized is rejected (`null`), and the
 * evaluator then denies with `counterparty.invalid`.
 *
 * Acceptance is delegated to the schemas of `@agentbank/core`
 * (`AddressSchema`, `isId("agent")`, `Erc8004IdSchema`, `DomainSchema`), so an
 * intent can only name a counterparty that a policy document could also name:
 * nothing is payable that an owner could not put on a denylist.
 *
 * Validation runs on the raw string *before* any case folding, so Unicode
 * characters that lowercase to ASCII (the Kelvin sign U+212A lowercases to
 * "k") cannot smuggle a lookalike into a match, and homoglyphs, zero-width
 * characters, whitespace, ports, userinfo, wildcards and IP-literal hosts
 * never match an entry.
 */

/** Kind of identifier a counterparty or a list entry is matched by. */
export type IdentifierType = "address" | "agent_id" | "erc8004_id" | "x402_domain";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const HOST_CHARS_RE = /^[A-Za-z0-9.-]+$/;

/**
 * Canonical form of an EVM address: `0x` + 40 lowercase hex digits.
 * Mixed-case (EIP-55) input is accepted; an uppercase `0X` prefix, missing
 * prefix, wrong length, whitespace or non-ASCII digits are rejected.
 */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string" || !AddressSchema.safeParse(value).success) return null;
  return value.toLowerCase();
}

/** Whether a normalized address is the zero address (a burn, never a payee). */
export function isZeroAddress(address: string): boolean {
  return address === ZERO_ADDRESS;
}

/**
 * Canonical form of an x402 host name: ASCII lowercase with at most one
 * trailing dot removed (`API.Example.com.` → `api.example.com`), accepted only
 * if `DomainSchema` accepts it.
 *
 * Rejects anything that is not plain LDH ASCII (IDNs must arrive in punycode
 * `xn--` form), ports, paths, userinfo, wildcards and empty labels, and every
 * IP-like host: a numeric last label (`192.168.0.1`, `3232235521`) or a label
 * starting with `0x` (`0xc0.0xa8.0.1`). x402 payments must name a DNS host,
 * so a denylist can never be dodged by spelling an endpoint as an address.
 */
export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string" || !HOST_CHARS_RE.test(value)) return null;
  let host = value.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return DomainSchema.safeParse(host).success ? host : null;
}

/**
 * Agent Bank agent ids (`agt_` + 26-character ULID body) compare exactly;
 * anything that is not a well-formed agent id is rejected.
 */
export function normalizeAgentId(value: unknown): string | null {
  return typeof value === "string" && isId("agent", value) ? value : null;
}

/**
 * ERC-8004 identifiers (registry token ids, optionally CAIP-style
 * `eip155:<chain>:<registry>:<id>`) compare case-insensitively; they must pass
 * `Erc8004IdSchema` (printable ASCII, no whitespace).
 */
export function normalizeErc8004Id(value: unknown): string | null {
  if (typeof value !== "string" || !Erc8004IdSchema.safeParse(value).success) return null;
  return value.toLowerCase();
}

/** Normalize a value of a known identifier type. */
export function normalizeIdentifier(type: IdentifierType, value: unknown): string | null {
  switch (type) {
    case "address":
      return normalizeAddress(value);
    case "agent_id":
      return normalizeAgentId(value);
    case "erc8004_id":
      return normalizeErc8004Id(value);
    case "x402_domain":
      return normalizeDomain(value);
  }
}

/**
 * Classify an AP2 payee id, which is a single string that may be an address,
 * an agent id, an x402 domain or an ERC-8004 id. Shape decides, in order:
 * address → `agt_` prefix (must be a well-formed agent id) → dotted host name
 * accepted by `DomainSchema` → ERC-8004 id.
 */
export function classifyPayeeId(id: unknown): { type: IdentifierType; value: string } | null {
  if (typeof id !== "string") return null;
  const address = normalizeAddress(id);
  if (address !== null) return { type: "address", value: address };
  if (id.startsWith("agt_")) {
    const agentId = normalizeAgentId(id);
    return agentId === null ? null : { type: "agent_id", value: agentId };
  }
  if (id.includes(".")) {
    const domain = normalizeDomain(id);
    if (domain !== null) return { type: "x402_domain", value: domain };
  }
  const erc8004 = normalizeErc8004Id(id);
  return erc8004 === null ? null : { type: "erc8004_id", value: erc8004 };
}
