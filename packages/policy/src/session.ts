import {
  AgentBankError,
  DEFAULT_SESSION_TTL_SECONDS,
  decimalsOf,
  formatAmount,
  MAX_MINOR_UNITS,
  MAX_SESSION_TTL_SECONDS,
  parseAmount,
  SessionScopeSchema,
  type AssetCode,
  type SessionScope,
} from "@agentbank/core";
import { normalizeAddress } from "./normalize";
import { COMPILED_SESSION_SCOPE_FORMAT, type CompiledPolicy, type CompiledSessionScope } from "./types";

/**
 * Cap written into a session scope when neither the policy nor the mandate
 * bounds it: the largest amount the ledger can store.
 */
export const UNBOUNDED_SESSION_AMOUNT = MAX_MINOR_UNITS;
/** Smart Sessions limits mirrored by `SessionScopeSchema`. */
export const MAX_SESSION_RECIPIENTS = 100;
export const MAX_SESSION_CONTRACTS = 20;

/** Options for {@link sessionScopeFromPolicy} and `mandateToSessionScope`. */
export interface SessionScopeOptions {
  /** Session lifetime in seconds (integer). Default 24 hours, at most 7 days. */
  ttlSeconds?: number;
  /**
   * Extra recipient addresses the caller has resolved and vouches for, e.g.
   * the accounts of allowlisted agent ids or ERC-8004 ids, and the agent's
   * own spend key for refills. They join the policy allowlist addresses when
   * the policy is in allowlist mode; otherwise they are ignored.
   */
  recipients?: readonly string[];
  /** Contracts the session may call (escrow, streams). At most 20. */
  contracts?: readonly string[];
  /** Spend under the mandate so far (mandate scopes only), to cap at the remaining budget. */
  mandateSpent?: bigint;
}

/** Narrowing a mandate contributes to a session scope. */
export interface ScopeNarrowing {
  perTx: readonly (bigint | null)[];
  perDay: readonly (bigint | null)[];
  /** Each set restricts on-chain recipients (intersection). */
  recipientSets: readonly ReadonlySet<string>[];
  endsAt: Date | null;
}

function minOf(values: readonly (bigint | null)[]): bigint | null {
  let out: bigint | null = null;
  for (const v of values) if (v !== null && (out === null || v < out)) out = v;
  return out;
}

function addresses(values: readonly string[], path: string): string[] {
  return values.map((raw, i) => {
    const address = normalizeAddress(raw);
    if (address === null) throw new AgentBankError("invalid_request", `${path}[${i}] is not a valid address`);
    return address;
  });
}

/** @internal Shared by {@link sessionScopeFromPolicy} and `mandateToSessionScope`. */
export function buildSessionScope(
  policy: CompiledPolicy,
  now: Date,
  options: SessionScopeOptions,
  narrowing: ScopeNarrowing,
): SessionScope {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AgentBankError("invalid_request", "now must be a valid Date");
  }
  const ttl = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_SESSION_TTL_SECONDS) {
    throw new AgentBankError(
      "invalid_request",
      `Session lifetime must be a whole number of seconds between 1 and ${MAX_SESSION_TTL_SECONDS}`,
    );
  }
  const { limits } = policy;
  // Never above what the ledger can store, however large a mandate amount is.
  const perDay = minOf([
    limits.perDay,
    limits.perWeek,
    limits.perMonth,
    ...narrowing.perDay,
    UNBOUNDED_SESSION_AMOUNT,
  ]) as bigint;
  const perTx = minOf([limits.perTx, policy.requireOwnerAbove, ...narrowing.perTx, perDay]) as bigint;

  const extra = addresses(options.recipients ?? [], "recipients");
  const { allow, deny } = policy.counterparties;
  let recipients: Set<string> | null =
    allow !== null && (allow.addresses.size > 0 || extra.length > 0)
      ? new Set([...allow.addresses, ...extra])
      : null;
  for (const set of narrowing.recipientSets) {
    const current: Set<string> | null = recipients;
    recipients = current === null ? new Set(set) : new Set([...current].filter((a) => set.has(a)));
  }
  const contracts = [...new Set(addresses(options.contracts ?? [], "contracts"))].sort();
  if (contracts.length > MAX_SESSION_CONTRACTS) {
    throw new AgentBankError(
      "invalid_request",
      `A session may call at most ${MAX_SESSION_CONTRACTS} contracts`,
    );
  }

  let expires = now.getTime() + ttl * 1000;
  if (narrowing.endsAt !== null && narrowing.endsAt.getTime() < expires) expires = narrowing.endsAt.getTime();

  const scope: SessionScope = {
    asset: policy.asset,
    max_per_tx: formatAmount(perTx, policy.decimals),
    max_per_day: formatAmount(perDay, policy.decimals),
    expires_at: new Date(expires).toISOString(),
  };
  if (recipients !== null) {
    const list = [...recipients].filter((a) => !deny.addresses.has(a)).sort();
    // More recipients than Smart Sessions can hold: leave the on-chain list
    // open and rely on the co-signer's allowlist, rather than block payees.
    if (list.length <= MAX_SESSION_RECIPIENTS) scope.allowed_recipients = list;
  }
  if (contracts.length > 0) scope.allowed_contracts = contracts;
  return scope;
}

/**
 * Default scope for a new session key under a policy:
 *
 * - `max_per_tx` = min(`per_tx`, `per_day`, `per_week`, `per_month`,
 *   `require_owner_above`): payments above `require_owner_above` are signed
 *   by the owner key, never by a session.
 * - `max_per_day` = min(`per_day`, `per_week`, `per_month`).
 * - Caps the policy leaves open are {@link UNBOUNDED_SESSION_AMOUNT}.
 * - `allowed_recipients` only in allowlist mode with addresses (plus
 *   `options.recipients`), minus denylisted addresses; omitted when more
 *   than 100 remain (the co-signer still enforces the allowlist).
 * - `expires_at` = now + ttl (default 24 h, at most 7 days).
 *
 * @param options A lifetime in seconds, or {@link SessionScopeOptions}.
 */
export function sessionScopeFromPolicy(
  policy: CompiledPolicy,
  now: Date,
  options: number | SessionScopeOptions = {},
): SessionScope {
  const opts = typeof options === "number" ? { ttlSeconds: options } : options;
  return buildSessionScope(policy, now, opts, { perTx: [], perDay: [], recipientSets: [], endsAt: null });
}

/** A session scope as stored or received (asset may be omitted; it defaults to USDC). */
export type SessionScopeInput = Omit<SessionScope, "asset"> & { asset?: AssetCode | undefined };

/**
 * Compile a session scope (wire shape) for evaluation: validated with
 * `SessionScopeSchema`, amounts parsed to minor units, addresses lowercased.
 * Throws `AgentBankError("invalid_request")` when invalid.
 */
export function compileSessionScope(scope: SessionScopeInput): CompiledSessionScope {
  const parsed = SessionScopeSchema.safeParse(scope);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    );
    throw new AgentBankError("invalid_request", `Invalid session scope: ${issues.join("; ")}`);
  }
  const source = parsed.data;
  const decimals = decimalsOf(source.asset);
  const amount = (value: string, path: string): bigint => {
    try {
      return parseAmount(value, decimals);
    } catch (error) {
      throw new AgentBankError("invalid_request", `${path}: ${(error as Error).message}`);
    }
  };
  const set = (values: readonly string[] | undefined, path: string): ReadonlySet<string> | null =>
    values === undefined ? null : new Set(addresses(values, path));
  return Object.freeze({
    format: COMPILED_SESSION_SCOPE_FORMAT,
    asset: source.asset,
    maxPerTx: amount(source.max_per_tx, "max_per_tx"),
    maxPerDay: amount(source.max_per_day, "max_per_day"),
    allowedRecipients: set(source.allowed_recipients, "allowed_recipients"),
    allowedContracts: set(source.allowed_contracts, "allowed_contracts"),
    expiresAt: new Date(source.expires_at),
    source,
  });
}
