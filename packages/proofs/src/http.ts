import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  Bytes32Schema,
  canonicalJson,
  hexToBytes,
  timingSafeEqual,
  utf8,
} from "@agentbank/core";
import {
  ProofPresentation as ProofPresentationSchema,
  ProofRequest as ProofRequestSchema,
} from "@agentbank/core/api";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { MAX_SCOPE_LENGTH } from "./field";
import {
  createProofRequest,
  DEFAULT_CHAIN_ID,
  DEFAULT_MAX_ROOT_AGE_SECONDS,
  DEFAULT_MIN_ANONYMITY_SET,
  DEFAULT_TTL_SECONDS,
  type ProofRequest,
  type Requirement,
} from "./request";
import {
  verifyPresentation,
  type ProofFailureReason,
  type ProofPresentation,
  type RootResolver,
} from "./verifier";

/**
 * The HTTP binding of private proofs, mirroring the x402 paywall:
 *
 * | Step                      | Status | Header                                                              |
 * | ------------------------- | ------ | ------------------------------------------------------------------- |
 * | Verifier asks for a proof | 401    | `WWW-Authenticate: AgentProof realm="<scope>"`, `AGENT-PROOF-REQUIRED: base64(json(request))` |
 * | Agent retries             | —      | `AGENT-PROOF: base64(json({ request, presentation }))`              |
 * | Verifier accepts          | 2xx    | `AGENT-PROOF-RESPONSE: base64(json({ status: "accepted", nullifier }))` |
 *
 * `createProofGate` is a stateless verifier: nonces are derived from a key, so the gate keeps
 * no per-challenge state, and a replay cache remembers used nonces until their request expires.
 */

export const PROOF_HEADERS = {
  required: "AGENT-PROOF-REQUIRED",
  proof: "AGENT-PROOF",
  response: "AGENT-PROOF-RESPONSE",
  wwwAuthenticate: "WWW-Authenticate",
} as const;

export const PROOF_AUTH_SCHEME = "AgentProof";

/** The header could not be decoded (bad base64, JSON or schema). */
export class ProofHeaderError extends Error {
  override readonly name = "ProofHeaderError";
}

/** `AgentProof realm="<scope>"` (quotes and backslashes escaped). */
export function wwwAuthenticate(scope: string): string {
  return `${PROOF_AUTH_SCHEME} realm="${scope.replace(/["\\]/g, "\\$&")}"`;
}

/** base64(utf8(JSON)) as the headers carry it. */
export function encodeHeaderJson(value: unknown): string {
  return bytesToBase64(utf8(JSON.stringify(value)));
}

/** Decode a base64 (standard or URL-safe) JSON header and validate it. Throws `ProofHeaderError`. */
export function decodeHeaderJson<S extends z.ZodType>(header: string, schema: S): z.output<S> {
  let json: unknown;
  try {
    const normalized = header.trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(padded)));
  } catch {
    throw new ProofHeaderError("header is not base64-encoded JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProofHeaderError(`invalid header: ${issue?.path.join(".") || "value"}: ${issue?.message}`);
  }
  return parsed.data;
}

export const ProofEnvelopeSchema = z.object({
  request: ProofRequestSchema,
  presentation: ProofPresentationSchema,
});
export const ProofResponseSchema = z.object({ status: z.literal("accepted"), nullifier: Bytes32Schema });

export interface ProofEnvelope {
  request: ProofRequest;
  presentation: ProofPresentation;
}

export const encodeProofRequired = (request: ProofRequest): string => encodeHeaderJson(request);
export const decodeProofRequired = (header: string): ProofRequest =>
  decodeHeaderJson(header, ProofRequestSchema);
export const encodeProof = (envelope: ProofEnvelope): string => encodeHeaderJson(envelope);
export const decodeProof = (header: string): ProofEnvelope => decodeHeaderJson(header, ProofEnvelopeSchema);
export const encodeProofResponse = (nullifier: Hex): string =>
  encodeHeaderJson({ status: "accepted", nullifier });
export const decodeProofResponse = (header: string): { status: "accepted"; nullifier: string } =>
  decodeHeaderJson(header, ProofResponseSchema);

// ---------------------------------------------------------------- nonces

function keyBytes(key: Uint8Array | string): Uint8Array {
  return typeof key === "string" ? utf8(key) : key;
}

/**
 * A stateless gate's nonce: the first 31 bytes of HMAC-SHA256(key, canonicalJson(request
 * without nonce)), as 0x + 62 hex digits. String keys are UTF-8 encoded.
 */
export function gateNonce(
  key: Uint8Array | string,
  request: Omit<ProofRequest, "nonce"> | ProofRequest,
): Hex {
  const { nonce: _nonce, ...withoutNonce } = request as ProofRequest;
  return bytesToHex(hmac(sha256, keyBytes(key), utf8(canonicalJson(withoutNonce))).slice(0, 31));
}

// ---------------------------------------------------------------- replay cache

/** Remembers nonces of accepted proofs until their request expires. */
export interface ReplayCache {
  /** Whether the nonce was accepted before and its request has not expired at `now`. */
  has(nonce: string, now: number): boolean | Promise<boolean>;
  /** Record the nonce until `expiresAt`; false when it is already recorded (a replay). */
  consume(nonce: string, expiresAt: number, now: number): boolean | Promise<boolean>;
}

/**
 * In-memory replay cache for a single process. Expired entries are evicted as new ones arrive;
 * when `maxEntries` unexpired entries exist, the soonest-expiring is dropped.
 */
export class MemoryReplayCache implements ReplayCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(nonce: string, now: number): boolean {
    const expiresAt = this.entries.get(nonce);
    if (expiresAt === undefined) return false;
    if (expiresAt < now) {
      this.entries.delete(nonce);
      return false;
    }
    return true;
  }

  consume(nonce: string, expiresAt: number, now: number): boolean {
    if (this.has(nonce, now)) return false;
    if (this.entries.size >= this.maxEntries) this.evict(now);
    this.entries.set(nonce, expiresAt);
    return true;
  }

  /** Drop expired entries, then the soonest-expiring ones while the cache is full. */
  evict(now: number): void {
    for (const [nonce, expiresAt] of this.entries) if (expiresAt < now) this.entries.delete(nonce);
    while (this.entries.size >= this.maxEntries) {
      let soonest: [string, number] | undefined;
      for (const entry of this.entries) if (!soonest || entry[1] < soonest[1]) soonest = entry;
      this.entries.delete((soonest as [string, number])[0]);
    }
  }
}

// ---------------------------------------------------------------- gate

export type HeaderSource =
  { get(name: string): string | null } | Readonly<Record<string, string | readonly string[] | undefined>>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, string | readonly string[] | undefined>,
  )) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === "string" ? value : value[0];
  }
  return undefined;
}

export interface ProofGateOptions {
  /** The verifier's scope, normally its host name. */
  scope: string;
  /** HMAC key for stateless nonces, at least 32 bytes (strings are UTF-8 encoded). */
  key: Uint8Array | string;
  require: readonly Requirement[];
  /** How long a challenge stays valid (default 300 s). */
  ttlSeconds?: number;
  /** Where roots are checked: `apiRootResolver(...)` or `chainRootResolver(...)`. */
  rootResolver: RootResolver;
  /** Used nonces (default: a fresh in-memory cache). Share one across instances behind a balancer. */
  replayCache?: ReplayCache;
  /** Default 16. */
  minAnonymitySet?: number;
  /** Default 7,200 s. */
  maxRootAgeSeconds?: number;
  /** Default Base Sepolia (84532). */
  chainId?: number;
  /** Default null (the deployment's registry). */
  registry?: Address | null;
  /** Clock in unix seconds (default the system clock). */
  now?: () => number;
  /** Defaults to the bundled verification key. */
  verificationKey?: object;
}

export interface ProofChallenge {
  status: 401;
  headers: Record<string, string>;
  body: { error: "proof_required"; reason: ProofFailureReason | null; request: ProofRequest };
  request: ProofRequest;
}

export type ProofGateResult =
  | { kind: "proof-required"; reason: ProofFailureReason | null; response: ProofChallenge }
  | {
      kind: "verified";
      nullifier: Hex;
      root: Hex;
      request: ProofRequest;
      /** Add to the 2xx response. */
      headers: Record<string, string>;
    };

export interface ProofGate {
  readonly scope: string;
  /** A fresh request with an authentic nonce. */
  createRequest(): ProofRequest;
  /** The 401 response asking for a proof. */
  challenge(reason?: ProofFailureReason | null): ProofChallenge;
  /** Check a request's `AGENT-PROOF` header. Root resolver errors propagate (answer 5xx). */
  check(headers: HeaderSource): Promise<ProofGateResult>;
}

/** A stateless proof gate for an HTTP resource. */
export function createProofGate(options: ProofGateOptions): ProofGate {
  const key = keyBytes(options.key);
  if (key.length < 32) throw new RangeError("the gate key must be at least 32 bytes");
  if (options.scope.length === 0 || options.scope.length > MAX_SCOPE_LENGTH) {
    throw new RangeError(`scope must be 1 to ${MAX_SCOPE_LENGTH} characters`);
  }
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const cache = options.replayCache ?? new MemoryReplayCache();
  const placeholder = `0x${"0".repeat(62)}` as Hex;

  const createRequest = (): ProofRequest => {
    const draft = createProofRequest({
      scope: options.scope,
      require: options.require,
      ttlSeconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      maxRootAgeSeconds: options.maxRootAgeSeconds ?? DEFAULT_MAX_ROOT_AGE_SECONDS,
      minAnonymitySet: options.minAnonymitySet ?? DEFAULT_MIN_ANONYMITY_SET,
      chainId: options.chainId ?? DEFAULT_CHAIN_ID,
      registry: options.registry ?? null,
      nonce: placeholder,
      now: clock(),
    });
    return { ...draft, nonce: gateNonce(key, draft) };
  };

  const challenge = (reason: ProofFailureReason | null = null): ProofChallenge => {
    const request = createRequest();
    return {
      status: 401,
      headers: {
        [PROOF_HEADERS.wwwAuthenticate]: wwwAuthenticate(options.scope),
        [PROOF_HEADERS.required]: encodeProofRequired(request),
      },
      body: { error: "proof_required", reason, request },
      request,
    };
  };

  const required = (reason: ProofFailureReason | null): ProofGateResult => ({
    kind: "proof-required",
    reason,
    response: challenge(reason),
  });

  const check = async (headers: HeaderSource): Promise<ProofGateResult> => {
    const header = readHeader(headers, PROOF_HEADERS.proof);
    if (header === undefined || header.trim() === "") return required(null);
    let envelope: ProofEnvelope;
    try {
      envelope = decodeProof(header);
    } catch {
      return required("malformed");
    }
    const now = clock();
    const result = await verifyPresentation({
      request: envelope.request,
      presentation: envelope.presentation,
      rootResolver: options.rootResolver,
      now,
      ...(options.verificationKey ? { verificationKey: options.verificationKey } : {}),
      checkNonce: async (request) => {
        if (request.scope !== options.scope) return "nonce_invalid";
        if (!timingSafeEqual(hexToBytes(request.nonce), hexToBytes(gateNonce(key, request)))) {
          return "nonce_invalid";
        }
        return (await cache.has(request.nonce, now)) ? "nonce_reused" : null;
      },
    });
    if (!result.valid) return required(result.reason);
    const request = result.request as ProofRequest;
    if (!(await cache.consume(request.nonce, request.expires_at, now))) return required("nonce_reused");
    const nullifier = result.nullifier as Hex;
    return {
      kind: "verified",
      nullifier,
      root: result.root as Hex,
      request,
      headers: { [PROOF_HEADERS.response]: encodeProofResponse(nullifier) },
    };
  };

  return { scope: options.scope, createRequest, challenge, check };
}
