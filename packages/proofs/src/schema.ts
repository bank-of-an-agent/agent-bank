import { DISCLOSURE_CLASSES as API_DISCLOSURE_CLASSES, PROOF_ATTRIBUTES } from "@agentbank/core/api";

/**
 * Schema `agentbank.claims.v1`: the 13 attested attributes in circuit order, their kinds and
 * disclosure classes, and the constants the circuit fixes. The attribute and class lists come
 * from the API contract (`@agentbank/core/api`), so the API, the prover and the verifier cannot
 * disagree on them.
 */

export const CLAIMS_SCHEMA = "agentbank.claims.v1";
export const PROOF_REQUEST_TYPE = "agentbank.proof_request.v1";
export const PROOF_TYPE = "agentbank.proof.v1";

/** Attributes in circuit order (index = position in `mins`/`maxs` and in the leaf hash). */
export const ATTRIBUTES = PROOF_ATTRIBUTES;
export type Attribute = (typeof ATTRIBUTES)[number];

export const DISCLOSURE_CLASSES = API_DISCLOSURE_CLASSES;
export type DisclosureClass = (typeof DISCLOSURE_CLASSES)[number];

/**
 * How bounds on an attribute are written in a proof request:
 * - `money`: decimal USDC string ("5.00"), compared in minor units (6 decimals);
 * - `integer`: base-10 count or tag;
 * - `timestamp`: base-10 unix seconds;
 * - `enum`: base-10 code (principal_verification: 0 none, 1 individual, 2 company).
 */
export type AttributeKind = "money" | "integer" | "timestamp" | "enum";

export interface AttributeInfo {
  index: number;
  kind: AttributeKind;
  disclosureClass: DisclosureClass;
}

export const ATTRIBUTE_INFO: Readonly<Record<Attribute, AttributeInfo>> = {
  principal_verification: { index: 0, kind: "enum", disclosureClass: "principal" },
  per_tx_limit: { index: 1, kind: "money", disclosureClass: "limits" },
  per_day_limit: { index: 2, kind: "money", disclosureClass: "limits" },
  balance: { index: 3, kind: "money", disclosureClass: "balance" },
  reserved_amount: { index: 4, kind: "money", disclosureClass: "reservations" },
  reserved_until: { index: 5, kind: "timestamp", disclosureClass: "reservations" },
  reserved_for: { index: 6, kind: "integer", disclosureClass: "reservations" },
  account_created_on: { index: 7, kind: "timestamp", disclosureClass: "account_age" },
  payments_settled: { index: 8, kind: "integer", disclosureClass: "reputation" },
  volume_settled: { index: 9, kind: "money", disclosureClass: "reputation" },
  escrows_completed: { index: 10, kind: "integer", disclosureClass: "reputation" },
  disputes_lost: { index: 11, kind: "integer", disclosureClass: "reputation" },
  counterparties: { index: 12, kind: "integer", disclosureClass: "reputation" },
};

/** The attributes each disclosure class covers, in circuit order. */
export const CLASS_ATTRIBUTES: Readonly<Record<DisclosureClass, readonly Attribute[]>> = Object.fromEntries(
  DISCLOSURE_CLASSES.map((c) => [c, ATTRIBUTES.filter((a) => ATTRIBUTE_INFO[a].disclosureClass === c)]),
) as unknown as Record<DisclosureClass, readonly Attribute[]>;

export const ATTRIBUTE_COUNT = 13;
export const TREE_DEPTH = 20;
/** Number of public signals: nullifier, root, scope, nonce, mins[13], maxs[13]. */
export const PUBLIC_SIGNAL_COUNT = 4 + 2 * ATTRIBUTE_COUNT;
/** Every attribute and bound is below 2^64; [0, MAX_U64] means "unconstrained". */
export const MAX_U64 = (1n << 64n) - 1n;
/** The BN254 scalar field order r: public signals, roots and nullifiers are below it. */
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Mask with every attribute disclosed. */
export const FULL_DISCLOSURE_MASK = (1 << ATTRIBUTE_COUNT) - 1;

export function isAttribute(value: unknown): value is Attribute {
  return typeof value === "string" && (ATTRIBUTES as readonly string[]).includes(value);
}

export function isDisclosureClass(value: unknown): value is DisclosureClass {
  return typeof value === "string" && (DISCLOSURE_CLASSES as readonly string[]).includes(value);
}

/** The 13-bit disclosure mask for a set of classes: bit i set when attribute i is disclosed. */
export function disclosureMask(classes: Iterable<DisclosureClass>): number {
  let mask = 0;
  for (const c of classes) {
    if (!isDisclosureClass(c)) throw new RangeError(`unknown disclosure class "${String(c)}"`);
    for (const a of CLASS_ATTRIBUTES[c]) mask |= 1 << ATTRIBUTE_INFO[a].index;
  }
  return mask;
}

/**
 * The classes a disclosure mask discloses, in class order. Throws when the mask is outside
 * [0, 8191] or discloses part of a class (masks are always whole classes).
 */
export function classesFromMask(mask: number): DisclosureClass[] {
  if (!Number.isInteger(mask) || mask < 0 || mask > FULL_DISCLOSURE_MASK) {
    throw new RangeError(`disclosure mask ${mask} is not a 13-bit integer`);
  }
  const classes = DISCLOSURE_CLASSES.filter((c) => {
    const bits = disclosureMask([c]);
    return (mask & bits) === bits;
  });
  if (disclosureMask(classes) !== mask) {
    throw new RangeError(`disclosure mask ${mask} discloses part of a class`);
  }
  return classes;
}

/** Whether attribute `attribute` is disclosed by `mask`. */
export function isDisclosed(mask: number, attribute: Attribute): boolean {
  return (mask & (1 << ATTRIBUTE_INFO[attribute].index)) !== 0;
}
