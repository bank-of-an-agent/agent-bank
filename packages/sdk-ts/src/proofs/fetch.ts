import { parseProofRequest } from "@agentbank/proofs/request";
import type { Hex } from "viem";
import type { FetchLike } from "../client";
import type { ProofPresentation, ProofRequest } from "../types";
import { ProofError } from "./errors";
import type * as ProofHttp from "./http";
import { loadProofHttp } from "./load";

/**
 * Answering proof challenges over HTTP:
 *
 * | Step                      | Status | Header                                                          |
 * | ------------------------- | ------ | --------------------------------------------------------------- |
 * | Verifier asks for a proof | 401    | `AGENT-PROOF-REQUIRED: base64(json(request))`                   |
 * | Agent retries             | —      | `AGENT-PROOF: base64(json({ request, presentation }))`          |
 * | Verifier accepts          | 2xx    | `AGENT-PROOF-RESPONSE: base64(json({ status, nullifier }))`     |
 *
 * `AgentClient.fetch` / `fetchWithPayment` / `wrapFetch` run this before the x402 flow, so a
 * resource behind a proof gate and a paywall is fetched in one call; {@link fetchWithProof}
 * is the standalone form.
 *
 * @packageDocumentation
 */

/** Answers proof requests: an `AgentClient`'s `proofs`, or anything with a `prove` method. */
export interface ProofAnswerer {
  /** `false` when no proof can be made (no secret): challenges are then returned unanswered. */
  readonly canProve?: boolean;
  prove(request: ProofRequest): Promise<ProofPresentation>;
  /** Whether to answer a challenge for `scope` from `url` (default: the scope is the URL's host name). */
  acceptsScope?(scope: string, url: URL): boolean;
}

/** Options of {@link fetchWithProof}. */
export interface ProofFetchOptions {
  prover: ProofAnswerer;
  /** Overrides `prover.acceptsScope`. */
  acceptScope?: (scope: string, url: URL) => boolean;
}

/** Proof details of a fetch. */
export interface ProofFetchDetails {
  /** Whether a proof was sent with the (final) request. */
  proofPresented: boolean;
  /** The agent's pseudonym for that verifier, from `AGENT-PROOF-RESPONSE`. */
  nullifier?: Hex;
  /** The proof request that was answered. */
  proofRequest?: ProofRequest;
}

/** Result of {@link fetchWithProof}. */
export interface ProofFetchResult extends ProofFetchDetails {
  response: Response;
}

/** A proof-answering `fetch` and what it presented (one per logical request). */
export interface ProofFetchSession {
  fetch: FetchLike;
  details(): ProofFetchDetails;
}

/** The default scope check: the proof request's scope is the challenging URL's host name. */
export function scopeMatchesHost(scope: string, url: URL): boolean {
  return scope.toLowerCase() === url.hostname.toLowerCase();
}

async function verifierReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : null;
  } catch {
    return null;
  }
}

function parseChallenge(http: typeof ProofHttp, header: string): ProofRequest {
  try {
    return parseProofRequest(http.decodeProofRequired(header));
  } catch (error) {
    throw new ProofError(
      "invalid_request",
      `The verifier's ${http.PROOF_HEADERS.required} header is not a valid proof request: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
}

/**
 * Wrap `fetchImpl` so that a 401 carrying `AGENT-PROOF-REQUIRED` is answered with a proof and
 * the request retried with `AGENT-PROOF`. The proof is kept for later requests through the
 * same session (the x402 paid retry carries it too); when a later request is challenged again
 * (e.g. the gate used up the nonce), a fresh proof is made once. A fresh proof answered with
 * another challenge is a rejection ({@link ProofError} `proof_rejected`).
 */
export function createProofFetch(fetchImpl: FetchLike, options: ProofFetchOptions): ProofFetchSession {
  const prover = options.prover;
  const acceptScope =
    options.acceptScope ??
    ((scope: string, url: URL) =>
      prover.acceptsScope ? prover.acceptsScope(scope, url) : scopeMatchesHost(scope, url));
  let header: string | undefined;
  let presented = false;
  let nullifier: Hex | undefined;
  let proofRequest: ProofRequest | undefined;

  const fetch: FetchLike = async (input, init) => {
    const http = await loadProofHttp();
    const { PROOF_HEADERS } = http;
    const original = new Request(input, init);
    const body = original.body ? new Uint8Array(await original.arrayBuffer()) : undefined;
    const send = (headers: Headers, url: string) =>
      fetchImpl(
        new Request(url, {
          method: original.method,
          headers,
          ...(body ? { body } : {}),
          signal: original.signal,
          redirect: original.redirect,
          credentials: original.credentials,
        }),
      );
    const headers = new Headers(original.headers);
    if (header !== undefined) headers.set(PROOF_HEADERS.proof, header);
    presented = header !== undefined;
    let url = original.url;
    let response = await send(headers, url);
    let fresh = false;
    for (;;) {
      const challenge = response.status === 401 ? response.headers.get(PROOF_HEADERS.required) : null;
      if (challenge === null) break;
      if (fresh) {
        const reason = await verifierReason(response);
        throw new ProofError(
          "proof_rejected",
          `The verifier refused the proof${reason ? ` (${reason})` : ""}`,
          { response, verifierReason: reason, ...(proofRequest ? { request: proofRequest } : {}) },
        );
      }
      if (prover.canProve === false) return response;
      const challengeUrl = new URL(response.url || url);
      const request = parseChallenge(http, challenge);
      if (!acceptScope(request.scope, challengeUrl)) {
        throw new ProofError(
          "scope_mismatch",
          `${challengeUrl.host} asked for a proof for scope "${request.scope}"; refusing to prove to another verifier than the one asking`,
          { request },
        );
      }
      const presentation = await prover.prove(request);
      header = http.encodeProof({ request, presentation });
      proofRequest = request;
      presented = true;
      await response.body?.cancel().catch(() => undefined);
      headers.set(PROOF_HEADERS.proof, header);
      url = challengeUrl.href;
      response = await send(headers, url);
      fresh = true;
    }
    const accepted = response.headers.get(PROOF_HEADERS.response);
    if (accepted && presented) {
      try {
        nullifier = http.decodeProofResponse(accepted).nullifier.toLowerCase() as Hex;
      } catch {
        // a malformed acknowledgement is ignored; the response itself is returned as is
      }
    }
    return response;
  };

  return {
    fetch,
    details: () => ({
      proofPresented: presented,
      ...(nullifier ? { nullifier } : {}),
      ...(proofRequest ? { proofRequest } : {}),
    }),
  };
}

/**
 * `fetch(input, init)`, answering a proof challenge (HTTP 401 with `AGENT-PROOF-REQUIRED`)
 * with `options.prover`. Without a proof secret (`canProve === false`) the 401 is returned
 * unchanged.
 *
 * @example
 * ```ts
 * const { response, proofPresented, nullifier } = await fetchWithProof(fetch, url, undefined, {
 *   prover: agent.proofs,
 * });
 * ```
 *
 * @throws {@link ProofError} `scope_mismatch`, `invalid_request`, `proof_rejected`, or any
 *   refusal of the prover (`unsatisfiable`, `reservation_required`, `rate_limited`, …).
 */
export async function fetchWithProof(
  fetchImpl: FetchLike,
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: ProofFetchOptions,
): Promise<ProofFetchResult> {
  const session = createProofFetch(fetchImpl, options);
  const response = await session.fetch(input, init);
  return { response, ...session.details() };
}
