import { AgentBankError, type PaymentKind } from "@agentbank/core";
import {
  isZeroAddress,
  normalizeAddress,
  normalizeAgentId,
  normalizeDomain,
  normalizeErc8004Id,
  normalizeIdentifier,
  type IdentifierType,
} from "./normalize";
import type { CounterpartySet, IntentCounterparty } from "./types";

/** Wire shape of a counterparty list in a policy document. */
export interface CounterpartyListInput {
  addresses?: readonly string[] | undefined;
  agent_ids?: readonly string[] | undefined;
  erc8004_ids?: readonly string[] | undefined;
  x402_domains?: readonly string[] | undefined;
}

/** The four identifier types with their set and wire names, in a fixed order. */
export const IDENTIFIER_FIELDS = [
  { type: "address", set: "addresses", wire: "addresses" },
  { type: "agent_id", set: "agentIds", wire: "agent_ids" },
  { type: "erc8004_id", set: "erc8004Ids", wire: "erc8004_ids" },
  { type: "x402_domain", set: "x402Domains", wire: "x402_domains" },
] as const satisfies readonly {
  type: IdentifierType;
  set: keyof CounterpartySet;
  wire: keyof CounterpartyListInput;
}[];

const SET_OF: Readonly<Record<IdentifierType, keyof CounterpartySet>> = {
  address: "addresses",
  agent_id: "agentIds",
  erc8004_id: "erc8004Ids",
  x402_domain: "x402Domains",
};

interface MutableCounterpartySet {
  addresses: Set<string>;
  agentIds: Set<string>;
  erc8004Ids: Set<string>;
  x402Domains: Set<string>;
}

function mutableSet(): MutableCounterpartySet {
  return { addresses: new Set(), agentIds: new Set(), erc8004Ids: new Set(), x402Domains: new Set() };
}

/** Build a set from a single list of identifiers of mixed types. */
export function counterpartySetOf(
  entries: Iterable<{ type: IdentifierType; value: string }>,
): CounterpartySet {
  const out = mutableSet();
  for (const entry of entries) out[SET_OF[entry.type]].add(entry.value);
  return out;
}

/**
 * Normalize the lists of a policy document into a set. Throws
 * `invalid_request` naming the first entry that cannot be normalized.
 */
export function counterpartySetFromLists(
  lists: readonly (CounterpartyListInput | undefined)[],
  path: string,
): CounterpartySet {
  const out = mutableSet();
  for (const list of lists) {
    if (list === undefined) continue;
    for (const field of IDENTIFIER_FIELDS) {
      (list[field.wire] ?? []).forEach((raw, i) => {
        const value = normalizeIdentifier(field.type, raw);
        if (value === null) {
          throw new AgentBankError(
            "invalid_request",
            `${path}.${field.wire}[${i}] is not a valid identifier`,
          );
        }
        out[field.set].add(value);
      });
    }
  }
  return out;
}

/** Number of identifiers in a set. */
export function counterpartySetSize(set: CounterpartySet): number {
  return set.addresses.size + set.agentIds.size + set.erc8004Ids.size + set.x402Domains.size;
}

/** Whether a set holds a normalized identifier. */
export function counterpartySetHas(set: CounterpartySet, type: IdentifierType, value: string): boolean {
  return set[SET_OF[type]].has(value);
}

/** A payee with every identifier normalized (`null` when not provided). */
export interface NormalizedCounterparty {
  readonly address: string | null;
  readonly agentId: string | null;
  readonly erc8004Id: string | null;
  readonly x402Domain: string | null;
}

/**
 * Normalize the counterparty of an intent. Every identifier that is present
 * must be well formed; x402 payments must name the paid host and every other
 * kind must name at least one of address, agent id or ERC-8004 id. The zero
 * address is never a valid payee.
 */
export function normalizeIntentCounterparty(
  raw: IntentCounterparty | null | undefined,
  kind: PaymentKind,
): { counterparty: NormalizedCounterparty; problems: string[] } {
  const problems: string[] = [];
  const cp: IntentCounterparty = raw !== null && typeof raw === "object" ? raw : {};
  if (cp !== raw) problems.push("intent.counterparty is missing");
  const take = (
    field: keyof IntentCounterparty,
    normalize: (value: unknown) => string | null,
  ): string | null => {
    const value = cp[field];
    if (isAbsent(value)) return null;
    const normalized = normalize(value);
    if (normalized === null) problems.push(`counterparty.${field} ${quote(value)} is malformed`);
    return normalized;
  };
  const counterparty: NormalizedCounterparty = {
    address: take("address", normalizeAddress),
    agentId: take("agentId", normalizeAgentId),
    erc8004Id: take("erc8004Id", normalizeErc8004Id),
    x402Domain: take("x402Domain", normalizeDomain),
  };
  if (counterparty.address !== null && isZeroAddress(counterparty.address)) {
    problems.push("counterparty.address is the zero address");
  }
  if (kind === "x402") {
    if (isAbsent(cp.x402Domain)) {
      problems.push("x402 payments must name the paid host (counterparty.x402Domain)");
    }
  } else if (isAbsent(cp.address) && isAbsent(cp.agentId) && isAbsent(cp.erc8004Id)) {
    problems.push(`${kind} payments must name the payee (address, agent id or ERC-8004 id)`);
  }
  return { counterparty, problems };
}

/**
 * Quote a raw identifier for a rule detail with every non-ASCII character
 * escaped, so homoglyphs and zero-width characters are visible in the audit log.
 */
export function quote(value: unknown): string {
  if (typeof value !== "string") return `(${typeof value})`;
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/** Identifiers of a counterparty as `[type, value]` pairs, optionally only those relevant to a kind. */
function identifiers(
  cp: NormalizedCounterparty,
  kind: PaymentKind | null,
): Array<{ type: IdentifierType; value: string }> {
  const out: Array<{ type: IdentifierType; value: string }> = [];
  const push = (type: IdentifierType, value: string | null): void => {
    if (value !== null) out.push({ type, value });
  };
  if (kind === null || kind !== "x402") {
    push("address", cp.address);
    push("agent_id", cp.agentId);
    push("erc8004_id", cp.erc8004Id);
  }
  if (kind === null || kind === "x402") push("x402_domain", cp.x402Domain);
  return out;
}

/** Human-readable label of an identifier, e.g. `address 0xabc…`. */
export function describeIdentifier(type: IdentifierType, value: string): string {
  return `${type.replace("_", " ")} ${value}`;
}

/**
 * First identifier of the counterparty (any type) found in the set, as a
 * label, or `null`. Used for restrictions (denylists, caps), where matching
 * broadly is the safe direction.
 */
export function findAnyMatch(set: CounterpartySet, cp: NormalizedCounterparty): string | null {
  for (const id of identifiers(cp, null)) {
    if (counterpartySetHas(set, id.type, id.value)) return describeIdentifier(id.type, id.value);
  }
  return null;
}

/**
 * First identifier relevant to the payment kind found in the set, or `null`.
 * Used for permissions (allowlists, mandate payees), where matching narrowly
 * is the safe direction: x402 payments match by host name only; every other
 * kind by address, agent id or ERC-8004 id.
 */
export function findRelevantMatch(
  set: CounterpartySet,
  cp: NormalizedCounterparty,
  kind: PaymentKind,
): string | null {
  for (const id of identifiers(cp, kind)) {
    if (counterpartySetHas(set, id.type, id.value)) return describeIdentifier(id.type, id.value);
  }
  return null;
}

/** Whether the counterparty carries an identifier of the given type and value. */
export function counterpartyHas(cp: NormalizedCounterparty, type: IdentifierType, value: string): boolean {
  return identifiers(cp, null).some((id) => id.type === type && id.value === value);
}

/** Short description of the counterparty for rule details. */
export function describeCounterparty(cp: NormalizedCounterparty, kind: PaymentKind): string {
  const ids = identifiers(cp, kind);
  const list = ids.length > 0 ? ids : identifiers(cp, null);
  return list.length === 0
    ? "unidentified counterparty"
    : list.map((id) => describeIdentifier(id.type, id.value)).join(", ");
}
