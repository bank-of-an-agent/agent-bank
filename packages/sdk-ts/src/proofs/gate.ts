import {
  createProofGate as createBaseProofGate,
  MemoryReplayCache,
  type HeaderSource,
  type ProofGate as BaseProofGate,
  type ProofGateOptions,
  type ProofGateResult,
} from "@agentbank/proofs/http";

/**
 * The verifier's proof gate (`@agentbank/proofs` `createProofGate`) with a two-phase check, so
 * a gate in front of an x402 paywall uses a proof up only when the request is served.
 *
 * @packageDocumentation
 */

/** A verified gate result. */
export type VerifiedGateResult = Extract<ProofGateResult, { kind: "verified" }>;

/**
 * A stateless proof gate. `check` verifies and uses the nonce up in one step; `peek` verifies
 * without using it up, and `commit` uses it up later (false when it was used meanwhile).
 */
export interface ProofGate extends BaseProofGate {
  /** Verify the request's `AGENT-PROOF` like {@link check}, leaving its nonce unused. */
  peek(headers: HeaderSource): Promise<ProofGateResult>;
  /** Use up the nonce of a {@link peek}ed result; `false` when it was already used (a replay). */
  commit(result: VerifiedGateResult): Promise<boolean>;
}

/** Whether a gate supports {@link ProofGate.peek} / {@link ProofGate.commit}. */
export function isTwoPhaseGate(gate: BaseProofGate): gate is ProofGate {
  const candidate = gate as Partial<ProofGate>;
  return typeof candidate.peek === "function" && typeof candidate.commit === "function";
}

/**
 * Create a stateless proof gate for an HTTP resource: `createProofGate` of
 * `@agentbank/proofs` (HMAC-derived nonces, a replay cache, root checks through
 * `rootResolver`), plus {@link ProofGate.peek} and {@link ProofGate.commit}.
 *
 * @example
 * ```ts
 * const gate = createProofGate({
 *   scope: "api.seller.example", // your host name
 *   key: process.env.PROOF_GATE_KEY!, // at least 32 bytes
 *   require: [verifiedCompany(), canPayPerTx("5.00")],
 *   rootResolver: apiRootResolver("https://api.agentbank.example"),
 * });
 * ```
 */
export function createProofGate(options: ProofGateOptions): ProofGate {
  const cache = options.replayCache ?? new MemoryReplayCache();
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  // The base gate checks the shared cache for replays but never records: commit() does.
  const inner = createBaseProofGate({
    ...options,
    replayCache: { has: (nonce, now) => cache.has(nonce, now), consume: () => true },
  });
  const commit = async (result: VerifiedGateResult): Promise<boolean> =>
    cache.consume(result.request.nonce, result.request.expires_at, clock());
  return {
    scope: inner.scope,
    createRequest: () => inner.createRequest(),
    challenge: (reason) => inner.challenge(reason),
    peek: (headers) => inner.check(headers),
    commit,
    async check(headers) {
      const result = await inner.check(headers);
      if (result.kind !== "verified" || (await commit(result))) return result;
      return { kind: "proof-required", reason: "nonce_reused", response: inner.challenge("nonce_reused") };
    },
  };
}
