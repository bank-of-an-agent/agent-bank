/**
 * Prefixed, time-sortable identifiers: `<prefix>_<26 char Crockford base32>`.
 * The body is a ULID (48-bit millisecond timestamp + 80 random bits), so ids
 * sort by creation time and are safe to expose publicly.
 */

export const ID_PREFIXES = {
  org: "org",
  member: "mem",
  apiKey: "key",
  agent: "agt",
  account: "acct",
  session: "ses",
  mandate: "mdt",
  policy: "pol",
  payment: "pay",
  paymentRequest: "preq",
  decision: "dec",
  approval: "apr",
  escrow: "esc",
  stream: "str",
  ledgerAccount: "lac",
  entry: "ent",
  hold: "hld",
  chainEvent: "cev",
  webhookEndpoint: "whe",
  webhookDelivery: "whd",
  event: "evt",
  vault: "vlt",
  sweepRule: "swp",
  fund: "fnd",
  feeCharge: "fee",
  subscription: "sub",
  statement: "stm",
  topUpRule: "atu",
  audit: "aud",
  x402: "x4p",
  ownerOperation: "oop",
  proofReservation: "prv",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(ms: number): string {
  let value = BigInt(ms);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

/** Create a new id for the given kind, e.g. `newId("payment")` → `pay_01J…`. */
export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${encodeTime(now)}${encodeRandom()}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && BODY_RE.test(value.slice(prefix.length));
}

/** Regex source matching ids of a kind, used by the API contract. */
export function idPattern(kind: IdKind): string {
  return `^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`;
}

/** Millisecond timestamp encoded in an id. */
export function idTimestamp(id: string): number {
  const body = id.slice(id.indexOf("_") + 1, id.indexOf("_") + 11);
  let value = 0;
  for (const ch of body) value = value * 32 + CROCKFORD.indexOf(ch);
  return value;
}
