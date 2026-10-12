import {
  bytesToHex,
  canonicalKeccak,
  CHAINS,
  formatAmount,
  isDecimalString,
  randomBytes,
} from "@agentbank/core";
import {
  ProofRequest as ProofRequestSchema,
  type ProofBound as ProofBoundSchema,
  type ProofWitness as ProofWitnessSchema,
} from "@agentbank/core/api";
import type { Address, Hex } from "viem";
import type { z } from "zod";
import { ProofRequestError } from "./errors";
import { randomNonce, scopeTagOf } from "./field";
import {
  ATTRIBUTE_COUNT,
  ATTRIBUTE_INFO,
  ATTRIBUTES,
  isAttribute,
  isDisclosed,
  MAX_U64,
  PROOF_REQUEST_TYPE,
  type Attribute,
  type DisclosureClass,
} from "./schema";

/**
 * Proof requests: what a verifier asks an agent to prove. Requirements are small builders
 * (`verifiedCompany()`, `canPayPerTx("5.00")`, `reservedFor("500.00", { until, scope })`…) that
 * `createProofRequest` intersects into per-attribute [min, max] bounds.
 */

export type ProofRequest = z.output<typeof ProofRequestSchema>;
export type ProofBound = z.output<typeof ProofBoundSchema>;
export type ProofWitness = z.output<typeof ProofWitnessSchema>;
export type Constraints = Partial<Record<Attribute, ProofBound>>;

export interface RequirementContext {
  /** The request's scope. */
  scope: string;
  /** The request's issued_at (unix seconds). */
  now: number;
  /** The request's expires_at (unix seconds). */
  expiresAt: number;
}

/** Constraints, or a function of the request being built (for scope- or time-relative bounds). */
export type Requirement = Constraints | ((context: RequirementContext) => Constraints);

const USDC_DECIMALS = 6;
const SECONDS_PER_DAY = 86_400;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

export const DEFAULT_TTL_SECONDS = 300;
export const DEFAULT_MAX_ROOT_AGE_SECONDS = 7_200;
export const DEFAULT_MIN_ANONYMITY_SET = 16;
export const DEFAULT_CHAIN_ID = CHAINS["base-sepolia"].id;

// ---------------------------------------------------------------- values

/**
 * Parse a decimal USDC string into minor units with the API's money grammar (no sign, exponent,
 * whitespace or leading zeros; at most 6 decimals). Bounds may reach 2^64 - 1 minor units.
 */
export function parseUsdcBound(value: string): bigint {
  if (!isDecimalString(value)) throw new ProofRequestError(`"${value}" is not a decimal USDC amount`);
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > USDC_DECIMALS) {
    throw new ProofRequestError(`"${value}" has more than ${USDC_DECIMALS} decimal places`);
  }
  const minor = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
  if (minor > MAX_U64) throw new ProofRequestError(`"${value}" exceeds 2^64 - 1 minor units`);
  return minor;
}

/** Parse one bound of `attribute` into the raw value the circuit compares. */
export function parseBoundValue(attribute: Attribute, value: string): bigint {
  if (typeof value !== "string")
    throw new ProofRequestError(`bounds on ${attribute} must be strings`, attribute);
  try {
    if (ATTRIBUTE_INFO[attribute].kind === "money") return parseUsdcBound(value);
  } catch (error) {
    throw new ProofRequestError(`${attribute}: ${(error as Error).message}`, attribute);
  }
  if (!INTEGER_RE.test(value)) {
    throw new ProofRequestError(`${attribute}: "${value}" is not a base-10 integer`, attribute);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new ProofRequestError(`${attribute}: "${value}" exceeds 2^64 - 1`, attribute);
  return parsed;
}

/** Format a raw bound value the way requests carry it (decimal USDC for money). */
export function formatBoundValue(attribute: Attribute, value: bigint): string {
  return ATTRIBUTE_INFO[attribute].kind === "money" ? formatAmount(value, USDC_DECIMALS) : value.toString();
}

export interface Bounds {
  /** Lower bounds in circuit order. */
  mins: bigint[];
  /** Upper bounds in circuit order. */
  maxs: bigint[];
}

/**
 * The circuit's `mins` and `maxs` for a request's constraints: [0, 2^64 - 1] for every
 * attribute or side left out. Throws `ProofRequestError` for unknown attributes, malformed or
 * out-of-range values and min > max.
 */
export function bounds(request: { constraints: Readonly<Record<string, unknown>> }): Bounds {
  const mins: bigint[] = new Array<bigint>(ATTRIBUTE_COUNT).fill(0n);
  const maxs: bigint[] = new Array<bigint>(ATTRIBUTE_COUNT).fill(MAX_U64);
  const constraints = request.constraints;
  if (typeof constraints !== "object" || constraints === null || Array.isArray(constraints)) {
    throw new ProofRequestError("constraints must be an object");
  }
  for (const [name, bound] of Object.entries(constraints)) {
    if (!isAttribute(name)) throw new ProofRequestError(`unknown attribute "${name}"`);
    if (bound === undefined) continue;
    if (typeof bound !== "object" || bound === null || Array.isArray(bound)) {
      throw new ProofRequestError(`the bound on ${name} must be an object`, name);
    }
    const extra = Object.keys(bound).filter((k) => k !== "min" && k !== "max");
    if (extra.length > 0) throw new ProofRequestError(`the bound on ${name} has unknown keys`, name);
    const { min, max } = bound as { min?: string; max?: string };
    const i = ATTRIBUTE_INFO[name].index;
    if (min !== undefined) mins[i] = parseBoundValue(name, min);
    if (max !== undefined) maxs[i] = parseBoundValue(name, max);
    if ((mins[i] as bigint) > (maxs[i] as bigint)) {
      throw new ProofRequestError(`${name}: min is greater than max`, name);
    }
  }
  return { mins, maxs };
}

// ---------------------------------------------------------------- requirements

function intString(value: number | bigint | string, what: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value.toString();
  if (typeof value === "bigint" && value >= 0n && value <= MAX_U64) return value.toString();
  if (typeof value === "string" && INTEGER_RE.test(value) && BigInt(value) <= MAX_U64) return value;
  throw new ProofRequestError(`${what} must be a non-negative integer below 2^64`);
}

function unixSeconds(value: number | Date): number {
  const seconds = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new ProofRequestError("times must be unix seconds");
  return seconds;
}

function money(attribute: Attribute, amount: string): string {
  parseBoundValue(attribute, amount);
  return amount;
}

/** A verified individual or company stands behind the agent (principal_verification ≥ 1). */
export function verifiedPrincipal(): Constraints {
  return { principal_verification: { min: "1" } };
}

/** A verified company stands behind the agent (principal_verification = 2). */
export function verifiedCompany(): Constraints {
  return { principal_verification: { min: "2", max: "2" } };
}

/** The agent's policy lets it pay at least `amount` in one transaction. */
export function canPayPerTx(amount: string): Constraints {
  return { per_tx_limit: { min: money("per_tx_limit", amount) } };
}

/** The agent's policy lets it pay at least `amount` per rolling day. */
export function canPayPerDay(amount: string): Constraints {
  return { per_day_limit: { min: money("per_day_limit", amount) } };
}

/** The agent's spending is capped at most at these limits (a bounded-risk counterparty). */
export function spendingCappedAt(caps: { perTx?: string; perDay?: string }): Constraints {
  if (caps.perTx === undefined && caps.perDay === undefined) {
    throw new ProofRequestError("spendingCappedAt needs perTx or perDay");
  }
  const out: Constraints = {};
  if (caps.perTx !== undefined) out.per_tx_limit = { max: money("per_tx_limit", caps.perTx) };
  if (caps.perDay !== undefined) out.per_day_limit = { max: money("per_day_limit", caps.perDay) };
  return out;
}

/** The agent held at least `amount` available at the snapshot (floored to whole dollars). */
export function balanceAtLeast(amount: string): Constraints {
  return { balance: { min: money("balance", amount) } };
}

/**
 * At least `amount` is reserved for the verifier until at least `until` (unix seconds or a
 * Date; or `forSeconds` after the request is issued). `reserved_for` must equal the tag of
 * `scope`, which defaults to the request's own scope.
 */
export function reservedFor(
  amount: string,
  options: { until?: number | Date; forSeconds?: number; scope?: string },
): Requirement {
  money("reserved_amount", amount);
  if ((options.until === undefined) === (options.forSeconds === undefined)) {
    throw new ProofRequestError("reservedFor needs exactly one of until, forSeconds");
  }
  const absolute = options.until === undefined ? undefined : unixSeconds(options.until);
  if (options.forSeconds !== undefined) unixSeconds(options.forSeconds);
  return (context) => {
    const tag = scopeTagOf(options.scope ?? context.scope).toString();
    const until = absolute ?? context.now + (options.forSeconds as number);
    return {
      reserved_amount: { min: amount },
      reserved_until: { min: until.toString() },
      reserved_for: { min: tag, max: tag },
    };
  };
}

/** The agent's account was created at least `days` days before `now` (default: the request's issued_at). */
export function accountOlderThan(days: number, options: { now?: number | Date } = {}): Requirement {
  if (!Number.isSafeInteger(days) || days < 0)
    throw new ProofRequestError("days must be a non-negative integer");
  const fixedNow = options.now === undefined ? undefined : unixSeconds(options.now);
  return (context) => {
    const latest = (fixedNow ?? context.now) - days * SECONDS_PER_DAY;
    if (latest < 0) throw new ProofRequestError("accountOlderThan reaches before 1970");
    return { account_created_on: { max: latest.toString() } };
  };
}

/** Track-record thresholds; every option is optional, at least one is required. */
export function reputation(options: {
  paymentsSettled?: number | bigint | string;
  volumeSettled?: string;
  escrowsCompleted?: number | bigint | string;
  disputesLostAtMost?: number | bigint | string;
  counterparties?: number | bigint | string;
}): Constraints {
  const out: Constraints = {};
  if (options.paymentsSettled !== undefined) {
    out.payments_settled = { min: intString(options.paymentsSettled, "paymentsSettled") };
  }
  if (options.volumeSettled !== undefined) {
    out.volume_settled = { min: money("volume_settled", options.volumeSettled) };
  }
  if (options.escrowsCompleted !== undefined) {
    out.escrows_completed = { min: intString(options.escrowsCompleted, "escrowsCompleted") };
  }
  if (options.disputesLostAtMost !== undefined) {
    out.disputes_lost = { max: intString(options.disputesLostAtMost, "disputesLostAtMost") };
  }
  if (options.counterparties !== undefined) {
    out.counterparties = { min: intString(options.counterparties, "counterparties") };
  }
  if (Object.keys(out).length === 0) throw new ProofRequestError("reputation needs at least one threshold");
  return out;
}

/**
 * Intersect requirements into one constraints object: per attribute the largest min and the
 * smallest max. Throws when the intersection is empty. Trivial sides are dropped and values are
 * normalized (money as canonical decimal strings).
 */
export function mergeConstraints(parts: readonly Constraints[]): Constraints {
  const { mins, maxs } = bounds({ constraints: {} });
  for (const part of parts) {
    const b = bounds({ constraints: part });
    for (let i = 0; i < ATTRIBUTE_COUNT; i++) {
      if ((b.mins[i] as bigint) > (mins[i] as bigint)) mins[i] = b.mins[i] as bigint;
      if ((b.maxs[i] as bigint) < (maxs[i] as bigint)) maxs[i] = b.maxs[i] as bigint;
    }
  }
  const out: Constraints = {};
  ATTRIBUTES.forEach((attribute, i) => {
    const min = mins[i] as bigint;
    const max = maxs[i] as bigint;
    if (min > max) throw new ProofRequestError(`requirements on ${attribute} cannot all hold`, attribute);
    const bound: ProofBound = {};
    if (min > 0n) bound.min = formatBoundValue(attribute, min);
    if (max < MAX_U64) bound.max = formatBoundValue(attribute, max);
    if (bound.min !== undefined || bound.max !== undefined) out[attribute] = bound;
  });
  return out;
}

export interface CreateProofRequestOptions {
  /** The verifier's identifier, normally its host name. */
  scope: string;
  require?: readonly Requirement[];
  /** Seconds until the request expires (default 300). */
  ttlSeconds?: number;
  /** Oldest root snapshot accepted (default 7,200 s). */
  maxRootAgeSeconds?: number;
  /** Fewest leaves the root must have (default 16). */
  minAnonymitySet?: number;
  /** Chain the root must be published on (default Base Sepolia, 84532). */
  chainId?: number;
  /** Registry the root must be published in (default null: the deployment's). */
  registry?: Address | null;
  /** 31-byte nonce (default random). Gates derive it from their key. */
  nonce?: Hex;
  /** 16 bytes of lowercase hex (default random). */
  requestId?: string;
  /** Issue time (default now). */
  now?: number | Date;
}

/** Build and validate a proof request. Throws `ProofRequestError`. */
export function createProofRequest(options: CreateProofRequestOptions): ProofRequest {
  const issuedAt = unixSeconds(options.now ?? new Date());
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0)
    throw new ProofRequestError("ttlSeconds must be a positive integer");
  const context: RequirementContext = { scope: options.scope, now: issuedAt, expiresAt: issuedAt + ttl };
  const constraints = mergeConstraints(
    (options.require ?? []).map((r) => (typeof r === "function" ? r(context) : r)),
  );
  const candidate = {
    type: PROOF_REQUEST_TYPE,
    scope: options.scope,
    request_id: options.requestId ?? bytesToHex(randomBytes(16)).slice(2),
    nonce: options.nonce ?? randomNonce(),
    issued_at: issuedAt,
    expires_at: issuedAt + ttl,
    constraints,
    max_root_age_seconds: options.maxRootAgeSeconds ?? DEFAULT_MAX_ROOT_AGE_SECONDS,
    min_anonymity_set: options.minAnonymitySet ?? DEFAULT_MIN_ANONYMITY_SET,
    chain_id: options.chainId ?? DEFAULT_CHAIN_ID,
    registry: options.registry ?? null,
  };
  const parsed = ProofRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProofRequestError(
      `invalid proof request: ${issue?.path.join(".") || "request"}: ${issue?.message}`,
    );
  }
  return parsed.data;
}

/** Validate an untrusted proof request (schema and bounds). Throws `ProofRequestError`. */
export function parseProofRequest(value: unknown): ProofRequest {
  const parsed = ProofRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProofRequestError(
      `invalid proof request: ${issue?.path.join(".") || "request"}: ${issue?.message}`,
    );
  }
  bounds(parsed.data);
  return parsed.data;
}

/** request_hash = keccak256(canonical JSON of the request). */
export function requestHash(request: ProofRequest): Hex {
  return canonicalKeccak(request);
}

export interface WitnessCheck {
  /** Attributes whose attested value lies outside the requested bounds. */
  outOfBounds: Attribute[];
  /** Attributes the request constrains although the disclosure mask hides them. */
  undisclosed: Attribute[];
  /** The classes of `undisclosed`. */
  undisclosedClasses: DisclosureClass[];
}

/** Compare a witness's attested values and disclosure mask with a request's bounds. */
export function checkWitness(
  witness: Pick<ProofWitness, "attributes" | "disclosure_mask">,
  request: ProofRequest,
): WitnessCheck {
  const { mins, maxs } = bounds(request);
  const outOfBounds: Attribute[] = [];
  const undisclosed: Attribute[] = [];
  ATTRIBUTES.forEach((attribute, i) => {
    const raw = witness.attributes[attribute];
    const value = typeof raw === "string" && INTEGER_RE.test(raw) ? BigInt(raw) : -1n;
    const min = mins[i] as bigint;
    const max = maxs[i] as bigint;
    if (value < min || value > max) outOfBounds.push(attribute);
    const constrained = min !== 0n || max !== MAX_U64;
    if (constrained && !isDisclosed(witness.disclosure_mask, attribute)) undisclosed.push(attribute);
  });
  const undisclosedClasses = [...new Set(undisclosed.map((a) => ATTRIBUTE_INFO[a].disclosureClass))];
  return { outOfBounds, undisclosed, undisclosedClasses };
}

/**
 * The attributes that stop this witness from proving this request (out of bounds or
 * constrained but undisclosed), in circuit order. Empty when a proof is possible.
 */
export function checkWitnessSatisfies(
  witness: Pick<ProofWitness, "attributes" | "disclosure_mask">,
  request: ProofRequest,
): Attribute[] {
  const { outOfBounds, undisclosed } = checkWitness(witness, request);
  const failing = new Set<Attribute>([...outOfBounds, ...undisclosed]);
  return ATTRIBUTES.filter((a) => failing.has(a));
}
