import { formatAmount, isLockedMainnet, parseAmount } from "@agentbank/core";
import { scopeTagOf, toBytes32 } from "@agentbank/proofs/field";
import { bounds, formatBoundValue, parseProofRequest } from "@agentbank/proofs/request";
import { ATTRIBUTE_INFO, MAX_U64 } from "@agentbank/proofs/schema";
import { identityCommitment, parseSecret } from "@agentbank/proofs/tree";
import type { Hex } from "viem";
import type { RequestOptions } from "../client";
import { InvalidRequestError, PermissionDeniedError } from "../errors";
import { nowSeconds } from "../internal/ids";
import { readOptions } from "../internal/options";
import { Proofs, type Requester } from "../resources";
import type {
  DisclosureClass,
  Page,
  ProofAttribute,
  ProofIdentity,
  ProofPresentation,
  ProofRequest,
  ProofReservation,
  ProofReservationStatus,
  ProofWitness,
} from "../types";
import { ProofError, type ReservationNeeded } from "./errors";
import { scopeMatchesHost } from "./fetch";
import { loadNodeProver, loadProofHttp, nodeProverLoaded } from "./load";

/**
 * The agent side of private proofs: enroll `Poseidon(secret)`, prove a verifier's request
 * with the witness Agent Bank serves, and reserve funds for one verifier. The secret never
 * leaves the process; Agent Bank only ever sees its commitment.
 *
 * @packageDocumentation
 */

/** Circuit files for the prover: paths or the files' bytes. */
export interface ProverArtifacts {
  wasm: string | Uint8Array;
  zkey: string | Uint8Array;
}

/** What a prover receives. */
export interface ProverInput {
  /** The proof secret (bytes32 hex). */
  secret: Hex;
  witness: ProofWitness;
  request: ProofRequest;
}

/**
 * Produces a presentation (`@agentbank/proofs/prover`'s `prove` in Node). Supply your own to
 * prove outside Node (e.g. snarkjs in a browser with the circuit files as URLs).
 */
export type Prover = (input: ProverInput) => Promise<ProofPresentation>;

/** Private-proof settings of an `AgentClient`. */
export interface AgentProofOptions {
  /**
   * Probing guard: at most this many presentations per verifier scope in any hour (default
   * 30). A verifier asking many questions with different thresholds could otherwise narrow
   * down the attested values. `0` refuses every request; `Infinity` disables the guard.
   */
  maxPresentationsPerScopePerHour?: number;
  /**
   * Reserving funds is never automatic: a request that needs a reservation fails with
   * `reservation_required` until you call `proofs.reserve(...)`. Only `false` is accepted.
   */
  autoReserve?: false;
  /**
   * Whether `fetch` / `fetchWithPayment` answer a challenge for `scope` from `url`. Default:
   * only when the scope is the URL's host name, so a server cannot relay another verifier's
   * challenge to you.
   */
  acceptScope?: (scope: string, url: URL) => boolean;
  /** Circuit files (default: the ones bundled with the SDK). */
  artifacts?: ProverArtifacts;
  /** Prove with something else than the bundled Node prover. */
  prover?: Prover;
}

/** Options of {@link AgentProofs.prove}. */
export interface ProveOptions extends Pick<RequestOptions, "signal" | "timeoutMs" | "maxRetries"> {
  /**
   * Prove from this reservation's leaf. By default a request that constrains reservations is
   * matched to an active reservation automatically.
   */
  reservationId?: string;
}

/** Result of {@link AgentProofs.answer}: a presentation ready to send. */
export interface ProofAnswer {
  /** The (validated) request that was proved. */
  request: ProofRequest;
  presentation: ProofPresentation;
  /** The header to send it in: `AGENT-PROOF`. */
  headerName: string;
  /** The header value: `base64(json({ request, presentation }))`. */
  header: string;
}

/** Input of {@link AgentProofs.reserve}. Give `scope` or `scopeTag`, and `expiresAt` or `forSeconds`. */
export interface ReserveInput {
  /** Decimal USDC to hold for the verifier, e.g. `"500.00"`. */
  amount: string;
  /** The verifier's scope (its host name, as in its proof requests). */
  scope?: string;
  /** Or just the verifier's 64-bit scope tag (base-10 string or bigint). */
  scopeTag?: string | bigint;
  /** When the hold is released (ISO 8601 or `Date`), more than a minute and at most 7 days ahead. */
  expiresAt?: string | Date;
  /** Or: seconds from now (more than 60, at most 604800). */
  forSeconds?: number;
}

/** The longest a reservation may last. */
export const MAX_RESERVATION_SECONDS = 7 * 24 * 3600;
/** A reservation must last more than this many seconds. */
export const MIN_RESERVATION_SECONDS = 60;
/** Default probing guard. */
export const DEFAULT_MAX_PRESENTATIONS_PER_SCOPE_PER_HOUR = 30;

const HOUR_MS = 3_600_000;
const USDC_DECIMALS = 6;
const RESERVATION_ATTRIBUTES = ["reserved_amount", "reserved_until", "reserved_for"] as const;
const SECRET_RE = /^0x[0-9a-fA-F]{1,64}$/;

/** Whether `value` is a usable proof secret: 0x hex of a non-zero BN254 field element. */
export function isProofSecret(value: unknown): value is Hex {
  if (typeof value !== "string" || !SECRET_RE.test(value)) return false;
  try {
    parseSecret(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- prover loading

async function nodeProver(): ReturnType<typeof loadNodeProver> {
  try {
    return await loadNodeProver();
  } catch (error) {
    throw new ProofError(
      "prover_unavailable",
      "The Node prover could not be loaded; outside Node pass proofs.prover",
      {
        cause: error,
      },
    );
  }
}

function nodeProverWith(artifacts: ProverArtifacts | undefined): Prover {
  return async (input) => {
    const prover = await nodeProver();
    return prover.prove({ ...input, artifacts: artifacts ?? prover.defaultArtifacts() });
  };
}

/**
 * snarkjs keeps a BN254 curve (with worker threads) after the first proof. Short-lived
 * processes (scripts, CLIs) call this so they can exit.
 */
export async function releaseProofResources(): Promise<void> {
  const loaded = nodeProverLoaded();
  if (!loaded) return;
  try {
    await (await loaded).releaseProverResources();
  } catch {
    // nothing was loaded, so nothing to release
  }
}

// ---------------------------------------------------------------- probing guard

class PresentationLimiter {
  readonly #max: number;
  readonly #log = new Map<string, number[]>();

  constructor(max: number) {
    this.#max = max;
  }

  /** Take a slot for `scope` (throws `rate_limited`); the returned function gives it back. */
  take(request: ProofRequest): () => void {
    const scope = request.scope;
    const now = Date.now();
    const recent = (this.#log.get(scope) ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length >= this.#max) {
      this.#log.set(scope, recent);
      const oldest = recent[0];
      throw new ProofError(
        "rate_limited",
        `Refusing to prove: ${recent.length} presentation(s) to "${scope}" in the last hour reach maxPresentationsPerScopePerHour (${this.#max}); a verifier asking many questions can narrow down the attested values`,
        { request, ...(oldest !== undefined ? { retryAfterMs: oldest + HOUR_MS - now } : {}) },
      );
    }
    recent.push(now);
    this.#log.set(scope, recent);
    return () => {
      const list = this.#log.get(scope);
      const index = list?.lastIndexOf(now) ?? -1;
      if (list && index >= 0) list.splice(index, 1);
    };
  }
}

// ---------------------------------------------------------------- helpers

async function parseRequestInput(input: unknown): Promise<ProofRequest> {
  try {
    const decoded = typeof input === "string" ? (await loadProofHttp()).decodeProofRequired(input) : input;
    return parseProofRequest(decoded);
  } catch (error) {
    throw new ProofError(
      "invalid_request",
      `Invalid proof request: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
}

/** Map the prover's refusals to `ProofError`s; everything else (API errors) passes through. */
function toProofError(error: unknown, request: ProofRequest): unknown {
  if (!(error instanceof Error) || error instanceof ProofError) return error;
  if (error.name === "ProofRefusedError") {
    const refusal = error as Error & {
      reason: "unsatisfiable" | "undisclosed" | "witness_mismatch" | "chain_mismatch";
      attributes: readonly ProofAttribute[];
      undisclosedClasses: readonly DisclosureClass[];
    };
    return new ProofError(refusal.reason, `The agent cannot prove this request: ${refusal.message}`, {
      request,
      attributes: refusal.attributes,
      undisclosedClasses: refusal.undisclosedClasses,
      cause: error,
    });
  }
  if (error.name === "ProofInputError") {
    return new ProofError("invalid_witness", `Unusable witness: ${error.message}`, { request, cause: error });
  }
  if (error.name === "ProofRequestError") {
    return new ProofError("invalid_request", `Invalid proof request: ${error.message}`, {
      request,
      cause: error,
    });
  }
  return error;
}

function within(value: bigint, range: readonly [bigint, bigint]): boolean {
  return value >= range[0] && value <= range[1];
}

function canonicalAmount(amount: string): string {
  if (typeof amount !== "string") {
    throw new InvalidRequestError("invalid_amount", 'amount must be a decimal string such as "500.00"');
  }
  let minor: bigint;
  try {
    minor = parseAmount(amount, USDC_DECIMALS);
  } catch {
    throw new InvalidRequestError(
      "invalid_amount",
      "amount must be a non-negative decimal string with at most 6 decimals",
    );
  }
  if (minor <= 0n) throw new InvalidRequestError("invalid_amount", "amount must be greater than zero");
  return formatAmount(minor, USDC_DECIMALS);
}

function scopeTagString(tag: string | bigint): string {
  const value = typeof tag === "bigint" ? tag : /^[1-9][0-9]{0,19}$/.test(tag) ? BigInt(tag) : -1n;
  if (value < 1n || value > MAX_U64) {
    throw new InvalidRequestError("invalid_request", "scopeTag must be an integer in [1, 2^64 - 1]");
  }
  return value.toString();
}

function reservationExpiry(input: ReserveInput): string {
  if ((input.expiresAt === undefined) === (input.forSeconds === undefined)) {
    throw new InvalidRequestError("invalid_request", "Give exactly one of expiresAt or forSeconds");
  }
  let expiresMs: number;
  if (input.forSeconds !== undefined) {
    if (
      !Number.isSafeInteger(input.forSeconds) ||
      input.forSeconds <= MIN_RESERVATION_SECONDS ||
      input.forSeconds > MAX_RESERVATION_SECONDS
    ) {
      throw new InvalidRequestError(
        "invalid_request",
        `forSeconds must be an integer above ${MIN_RESERVATION_SECONDS} and at most ${MAX_RESERVATION_SECONDS}`,
      );
    }
    expiresMs = Date.now() + input.forSeconds * 1000;
  } else {
    const at = input.expiresAt as string | Date;
    expiresMs = at instanceof Date ? at.getTime() : Date.parse(at);
    if (!Number.isFinite(expiresMs)) {
      throw new InvalidRequestError("invalid_request", "expiresAt must be an ISO 8601 time or a Date");
    }
    if (expiresMs <= Date.now() + MIN_RESERVATION_SECONDS * 1000) {
      throw new InvalidRequestError("invalid_request", "expiresAt must be more than 60 seconds ahead");
    }
    if (expiresMs > Date.now() + MAX_RESERVATION_SECONDS * 1000 + 60_000) {
      throw new InvalidRequestError("invalid_request", "expiresAt must be at most 7 days ahead");
    }
  }
  return new Date(expiresMs).toISOString();
}

// ---------------------------------------------------------------- AgentProofs

/** Construction parameters of {@link AgentProofs} (built by `AgentClient`). */
export interface AgentProofsConfig {
  accountId: string;
  /** 0x hex proof secret; without it the client can reserve but not enroll or prove. */
  secret?: Hex;
  options?: AgentProofOptions;
}

/**
 * `AgentClient.proofs`: the raw Proofs operations plus the agent's flows.
 *
 * @example
 * ```ts
 * const agent = new AgentClient({ …, proofSecret: process.env.AGENTBANK_PROOF_SECRET });
 * await agent.proofs.enroll(); // once: registers Poseidon(secret)
 * const presentation = await agent.proofs.prove(request); // request from AGENT-PROOF-REQUIRED
 * ```
 */
export class AgentProofs extends Proofs {
  /** The account the flows act on. */
  readonly accountId: string;
  readonly #secret: Hex | undefined;
  readonly #limiter: PresentationLimiter;
  readonly #prover: Prover;
  readonly #acceptScope: (scope: string, url: URL) => boolean;

  constructor(client: Requester, config: AgentProofsConfig) {
    super(client);
    const options = config.options ?? {};
    this.accountId = config.accountId;
    if (config.secret !== undefined && !isProofSecret(config.secret)) {
      throw new InvalidRequestError(
        "invalid_request",
        "proofSecret must be 0x-prefixed hex of a non-zero BN254 field element (see generateProofSecret)",
      );
    }
    this.#secret = config.secret === undefined ? undefined : toBytes32(parseSecret(config.secret));
    const max = options.maxPresentationsPerScopePerHour ?? DEFAULT_MAX_PRESENTATIONS_PER_SCOPE_PER_HOUR;
    if (!(Number.isSafeInteger(max) || max === Number.POSITIVE_INFINITY) || max < 0) {
      throw new InvalidRequestError(
        "invalid_request",
        "proofs.maxPresentationsPerScopePerHour must be a non-negative integer (or Infinity)",
      );
    }
    if (options.autoReserve !== undefined && options.autoReserve !== false) {
      throw new InvalidRequestError(
        "invalid_request",
        "proofs.autoReserve can only be false: the SDK never reserves funds on its own",
      );
    }
    this.#limiter = new PresentationLimiter(max);
    this.#prover = options.prover ?? nodeProverWith(options.artifacts);
    this.#acceptScope = options.acceptScope ?? scopeMatchesHost;
  }

  /** Whether a proof secret is configured (without one, challenges are left unanswered). */
  get canProve(): boolean {
    return this.#secret !== undefined;
  }

  /** `Poseidon(secret)` as bytes32 hex, the commitment to enroll (public), if a secret is set. */
  get identityCommitment(): Hex | undefined {
    return this.#secret === undefined ? undefined : toBytes32(identityCommitment(this.#secret));
  }

  /** Whether the automatic fetch flow answers a challenge for `scope` from `url`. */
  acceptsScope(scope: string, url: URL): boolean {
    return this.#acceptScope(scope, url);
  }

  #requireSecret(): Hex {
    if (this.#secret === undefined) {
      throw new ProofError(
        "proof_secret_missing",
        "This client has no proof secret: pass proofSecret to AgentClient (generateProofSecret(), then proofs.enroll())",
      );
    }
    return this.#secret;
  }

  /** Enroll the identity commitment `Poseidon(secret)` for this account (once per secret). */
  async enroll(options?: RequestOptions): Promise<ProofIdentity> {
    const secret = this.#requireSecret();
    return this.enrollIdentity(
      this.accountId,
      { identity_commitment: toBytes32(identityCommitment(secret)) },
      options,
    );
  }

  /** This account's enrolled identity commitment. */
  identity(options?: RequestOptions): Promise<ProofIdentity> {
    return this.retrieveIdentity(this.accountId, options);
  }

  /**
   * Prove a verifier's request (the object, or the base64 `AGENT-PROOF-REQUIRED` header
   * value): fetch the witness (from a matching active reservation when the request
   * constrains reservations), check locally that it can satisfy the request, and prove
   * (about 1.5 s in Node). Send the result back as
   * `AGENT-PROOF: encodeProof({ request, presentation })`.
   *
   * @throws {@link ProofError} `proof_secret_missing`, `invalid_request`, `request_expired`,
   *   `rate_limited` (probing guard), `reservation_required`, `reservation_pending`,
   *   `unsatisfiable`, `undisclosed`, `witness_mismatch`, `chain_mismatch`.
   */
  async prove(request: ProofRequest | string, options: ProveOptions = {}): Promise<ProofPresentation> {
    const secret = this.#requireSecret();
    const parsed = await parseRequestInput(request);
    if (isLockedMainnet(parsed.chain_id)) {
      throw new PermissionDeniedError(
        "mainnet_locked",
        `The proof request is for chain ${parsed.chain_id}, a mainnet; Agent Bank is testnet-only`,
      );
    }
    if (nowSeconds() > parsed.expires_at) {
      throw new ProofError(
        "request_expired",
        "The proof request has expired; ask the verifier for a new one",
        {
          request: parsed,
        },
      );
    }
    const release = this.#limiter.take(parsed);
    try {
      const reservationId = options.reservationId ?? (await this.#reservationFor(parsed, options));
      const witness = await this.witness(
        this.accountId,
        reservationId !== undefined ? { reservation_id: reservationId } : {},
        readOptions(options),
      );
      return await this.#prover({ secret, witness, request: parsed });
    } catch (error) {
      release();
      throw toProofError(error, parsed);
    }
  }

  /**
   * {@link prove}, then encode the `AGENT-PROOF` header to send back to the verifier
   * (`fetchWithPayment` and {@link fetchWithProof} do this for HTTP resources automatically).
   */
  async answer(challenge: ProofRequest | string, options: ProveOptions = {}): Promise<ProofAnswer> {
    const request = await parseRequestInput(challenge);
    const presentation = await this.prove(request, options);
    const http = await loadProofHttp();
    return {
      request,
      presentation,
      headerName: http.PROOF_HEADERS.proof,
      header: http.encodeProof({ request, presentation }),
    };
  }

  /**
   * Hold funds for one verifier so the agent can prove "$X is reserved for you until T". The
   * agent cannot spend them through Agent Bank or cancel the reservation; it expires on its
   * own (the owner can release it early). Provable from the next root (`pending` → `active`).
   */
  async reserve(input: ReserveInput, options?: RequestOptions): Promise<ProofReservation> {
    const amount = canonicalAmount(input.amount);
    if ((input.scope === undefined) === (input.scopeTag === undefined)) {
      throw new InvalidRequestError("invalid_request", "Give exactly one of scope or scopeTag");
    }
    if (
      input.scope !== undefined &&
      (typeof input.scope !== "string" || input.scope.length === 0 || input.scope.length > 253)
    ) {
      throw new InvalidRequestError("invalid_request", "scope must be 1 to 253 characters");
    }
    const expiresAt = reservationExpiry(input);
    return this.createReservation(
      this.accountId,
      {
        amount: { amount, asset: "USDC" },
        ...(input.scope !== undefined
          ? { scope: input.scope }
          : { scope_tag: scopeTagString(input.scopeTag as string | bigint) }),
        expires_at: expiresAt,
      },
      options,
    );
  }

  /** This account's reservations, newest first. */
  reservations(
    query: { status?: ProofReservationStatus; limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<ProofReservation>> {
    return this.listReservations(this.accountId, query, options);
  }

  /**
   * The reservation to prove a request from, when it constrains reserved_amount,
   * reserved_until or reserved_for: an active reservation whose amount, expiry and scope tag
   * all lie within the request's bounds (the latest-expiring one).
   */
  async #reservationFor(request: ProofRequest, options: ProveOptions): Promise<string | undefined> {
    const { mins, maxs } = bounds(request);
    const [amount, until, tag] = RESERVATION_ATTRIBUTES.map((a) => {
      const i = ATTRIBUTE_INFO[a].index;
      return [mins[i] as bigint, maxs[i] as bigint] as const;
    }) as [readonly [bigint, bigint], readonly [bigint, bigint], readonly [bigint, bigint]];
    const constrained = [amount, until, tag].some(([min, max]) => min !== 0n || max !== MAX_U64);
    if (!constrained) return undefined;

    const fits = (r: ProofReservation) =>
      within(parseAmount(r.amount.amount, USDC_DECIMALS), amount) &&
      within(BigInt(Math.floor(Date.parse(r.expires_at) / 1000)), until) &&
      within(BigInt(r.scope_tag), tag);
    const active = (await this.#all("active", options)).filter(fits);
    if (active.length > 0) {
      active.sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at) || a.id.localeCompare(b.id));
      return (active[0] as ProofReservation).id;
    }

    const scopeTag = tag[0] === tag[1] ? tag[0].toString() : undefined;
    const needed: ReservationNeeded = {
      amount: formatBoundValue("reserved_amount", amount[0]),
      scope:
        scopeTag !== undefined && scopeTag === scopeTagOf(request.scope).toString()
          ? request.scope
          : undefined,
      scopeTag,
      until: Number(until[0]),
    };
    const forWhom = needed.scope ? `"${needed.scope}"` : scopeTag ? `scope tag ${scopeTag}` : "this verifier";
    const untilText =
      needed.until > 0 ? ` until ${new Date(needed.until * 1000).toISOString()} or later` : "";
    const pending = (await this.#all("pending", options)).filter(fits);
    if (pending.length > 0) {
      throw new ProofError(
        "reservation_pending",
        `Reservation ${(pending[0] as ProofReservation).id} matches this request but no published root includes it yet; try again after the next root`,
        { request, reservationNeeded: needed },
      );
    }
    throw new ProofError(
      "reservation_required",
      `This proof request needs at least ${needed.amount} USDC reserved for ${forWhom}${untilText}, and no active reservation matches. The SDK never reserves funds on its own: call proofs.reserve({ amount: "${needed.amount}", ${needed.scope ? `scope: "${needed.scope}"` : `scopeTag: "${scopeTag ?? "…"}"`}, expiresAt }) first; it becomes provable at the next root.`,
      { request, reservationNeeded: needed },
    );
  }

  async #all(status: ProofReservationStatus, options: ProveOptions): Promise<ProofReservation[]> {
    const all: ProofReservation[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listReservations(
        this.accountId,
        { status, limit: 200, ...(cursor ? { cursor } : {}) },
        readOptions(options),
      );
      all.push(...page.data);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return all;
  }
}
