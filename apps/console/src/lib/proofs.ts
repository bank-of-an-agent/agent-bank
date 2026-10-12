import { DISCLOSURE_CLASSES } from "@agentbank/core/api";

/**
 * Private proofs (docs/private-proofs.md): what an owner lets an agent prove, and how a change
 * to that is classified. The classification mirrors the API's `updateProofSettings` exactly, so
 * the console asks for the owner key in the same cases the API does.
 */

export type DisclosureClass = (typeof DISCLOSURE_CLASSES)[number];

export { DISCLOSURE_CLASSES };

/** Plain-language meaning of each disclosure class: what a verifier may learn a bound on. */
export const DISCLOSURE_CLASS_INFO: Record<DisclosureClass, { label: string; description: string }> = {
  principal: {
    label: "Principal",
    description: "That a verified company or individual stands behind the agent, never which one.",
  },
  limits: {
    label: "Spending limits",
    description: "That its per-payment and daily policy caps fall within a range the verifier names.",
  },
  balance: {
    label: "Balance",
    description: "That it held at least an amount at the last snapshot, in whole dollars.",
  },
  reservations: {
    label: "Reservations",
    description: "That an amount is held for that one verifier until a given time (proof of funds).",
  },
  account_age: {
    label: "Account age",
    description: "That its account is older than a number of days, to the day.",
  },
  reputation: {
    label: "Reputation",
    description:
      "Thresholds on settled payments, volume, completed escrows, lost disputes and counterparties.",
  },
};

export interface DisclosureDraft {
  enabled: boolean;
  disclose: readonly string[];
}

export interface DisclosureChange {
  /** Enabling proofs or adding a class: needs the owner's `proofs.disclose` signature. */
  widening: boolean;
  /** Disabling or removing a class while enabled: applies at once and revokes older roots. */
  narrowing: boolean;
  changed: boolean;
  added: DisclosureClass[];
  removed: DisclosureClass[];
  /** The classes to send, deduplicated, in canonical (class) order. */
  next: DisclosureClass[];
}

/** Classes in canonical order, deduplicated, unknown values dropped. */
export function canonicalClasses(classes: readonly string[]): DisclosureClass[] {
  return DISCLOSURE_CLASSES.filter((c) => classes.includes(c));
}

/** How the API will treat moving from `current` to `draft` (see `updateProofSettings`). */
export function classifyDisclosureChange(current: DisclosureDraft, draft: DisclosureDraft): DisclosureChange {
  const before = canonicalClasses(current.disclose);
  const next = canonicalClasses(draft.disclose);
  const added = next.filter((c) => !before.includes(c));
  const removed = before.filter((c) => !next.includes(c));
  const widening = (!current.enabled && draft.enabled) || added.length > 0;
  const narrowing = current.enabled && (!draft.enabled || removed.length > 0);
  const changed = current.enabled !== draft.enabled || added.length > 0 || removed.length > 0;
  return { widening, narrowing, changed, added, removed, next };
}

/** "Balance and Reputation", "Principal, Limits and Balance". */
export function classList(classes: readonly DisclosureClass[]): string {
  const labels = classes.map((c) => DISCLOSURE_CLASS_INFO[c].label);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** SDK verifiers refuse roots with fewer attested leaves than this by default (`min_anonymity_set`). */
export const DEFAULT_MIN_ANONYMITY_SET = 16;
