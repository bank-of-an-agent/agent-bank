import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PROOF_HEADERS,
  type HeaderSource,
  type ProofGate as BaseProofGate,
  type ProofGateResult,
} from "@agentbank/proofs/http";
import type { Hex } from "viem";
import type { ProofRequest } from "../types";
import {
  sendFastify,
  sendNode,
  toWebResponse,
  withHeaders,
  type FastifyReplyLike,
  type FastifyRequestLike,
  type HonoContextLike,
} from "../x402/adapters";
import type { PaywallResponse } from "../x402/paywall";
import { X402_HEADERS } from "../x402/protocol";
import { isTwoPhaseGate } from "./gate";

/**
 * Framework adapters for a proof gate, mirroring the x402 paywall adapters: a request without
 * a valid `AGENT-PROOF` gets `401` with `WWW-Authenticate: AgentProof` and
 * `AGENT-PROOF-REQUIRED`; a verified one reaches the handler with the proof attached
 * ({@link proofOf}, `req.agentProof`, or Hono's `c.get("agentProof")`) and the response gets
 * `AGENT-PROOF-RESPONSE`.
 *
 * Gate and paywall compose: put the gate first and pass `{ beforePaywall: true }`. The gate
 * then uses a proof up only on the request that also carries the payment, so the agent's
 * paid retry reuses its proof instead of proving twice.
 *
 * @packageDocumentation
 */

/** What a handler learns from a verified proof. */
export interface VerifiedProof {
  /** The agent's stable pseudonym for this scope (the same agent always gets the same one). */
  nullifier: Hex;
  /** The attested-facts root the proof is against. */
  root: Hex;
  /** The gate's scope. */
  scope: string;
  /** The (verified) request: which bounds were proven. */
  request: ProofRequest;
}

/** Options of the gate adapters. */
export interface ProofGateAdapterOptions {
  /**
   * An x402 paywall runs after the gate (`honoProofGate(gate, …), honoPaywall(paywall)`). A
   * request with a proof but no payment is verified and passed on to the paywall's 402
   * without using the proof up (needs a gate from this module's `createProofGate`); the
   * paid retry, carrying the same proof, uses it up.
   */
  beforePaywall?: boolean;
}

/** Hono context variables set by {@link honoProofGate}: `new Hono<{ Variables: ProofGateVariables }>()`. */
export interface ProofGateVariables {
  agentProof: VerifiedProof;
}

const verified = new WeakMap<object, VerifiedProof>();

/**
 * The verified proof of a request that passed a gate adapter: pass the Web `Request`, the
 * Node/Express `req`, the Fastify `request` or the Hono context.
 */
export function proofOf(target: object): VerifiedProof | undefined {
  return verified.get(target);
}

function attach(targets: object[], proof: VerifiedProof): void {
  for (const target of targets) verified.set(target, proof);
}

type GateOutcome =
  | { kind: "respond"; response: PaywallResponse }
  | { kind: "pass"; proof: VerifiedProof; headers: Record<string, string> };

const EXPOSE_HEADERS = [PROOF_HEADERS.wwwAuthenticate, PROOF_HEADERS.required, PROOF_HEADERS.response].join(
  ", ",
);

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, string | readonly string[] | undefined>,
  )) {
    if (key.toLowerCase() === wanted && value !== undefined)
      return typeof value === "string" ? value : value[0];
  }
  return undefined;
}

function carriesPayment(headers: HeaderSource): boolean {
  return [X402_HEADERS.paymentSignature, X402_HEADERS.v1Payment].some((name) => {
    const value = readHeader(headers, name);
    return value !== undefined && value.trim() !== "";
  });
}

function challengeResponse(result: Extract<ProofGateResult, { kind: "proof-required" }>): PaywallResponse {
  return {
    status: result.response.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Expose-Headers": EXPOSE_HEADERS,
      ...result.response.headers,
    },
    body: JSON.stringify(result.response.body),
  };
}

// Fail closed without leaking resolver internals (an unreachable RPC or API) to the agent.
const unavailable = (): PaywallResponse => ({
  status: 502,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify({
    error: "proof_verifier_unavailable",
    detail: "Proofs cannot be checked right now; try again later",
  }),
});

async function runGate(
  gate: BaseProofGate,
  headers: HeaderSource,
  options: ProofGateAdapterOptions,
): Promise<GateOutcome> {
  const defer = options.beforePaywall === true && isTwoPhaseGate(gate) && !carriesPayment(headers);
  let result: ProofGateResult;
  try {
    result = defer && isTwoPhaseGate(gate) ? await gate.peek(headers) : await gate.check(headers);
  } catch {
    return { kind: "respond", response: unavailable() };
  }
  if (result.kind === "proof-required") return { kind: "respond", response: challengeResponse(result) };
  return {
    kind: "pass",
    proof: {
      nullifier: result.nullifier,
      root: result.root,
      scope: result.request.scope,
      request: result.request,
    },
    // A proof that is not used up yet (deferred to the paid retry) is not acknowledged.
    headers: defer ? {} : result.headers,
  };
}

// ---------------------------------------------------------------- Web Request/Response

/**
 * Protect a Web-standard handler `(request) => Response` (Next.js route handlers, Bun, Deno,
 * Cloudflare Workers, …). Read the proof with {@link proofOf}`(request)`.
 *
 * @example With a paywall after the gate
 * ```ts
 * export const GET = withProofGate(gate, withPaywall(paywall, handler), { beforePaywall: true });
 * ```
 */
export function withProofGate<Args extends unknown[]>(
  gate: BaseProofGate,
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  options: ProofGateAdapterOptions = {},
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    const outcome = await runGate(gate, request.headers, options);
    if (outcome.kind === "respond") return toWebResponse(outcome.response);
    attach([request], outcome.proof);
    const response = await handler(request, ...args);
    return Object.keys(outcome.headers).length > 0 ? withHeaders(response, outcome.headers) : response;
  };
}

/**
 * Hono middleware. The proof is available as `c.get("agentProof")` (type the app with
 * {@link ProofGateVariables}) or {@link proofOf}`(c)`.
 *
 * @example
 * ```ts
 * const app = new Hono<{ Variables: ProofGateVariables }>();
 * app.get("/report", honoProofGate(gate), (c) => c.json({ agent: c.get("agentProof").nullifier }));
 * ```
 */
export function honoProofGate(
  gate: BaseProofGate,
  options: ProofGateAdapterOptions = {},
): (c: HonoContextLike, next: () => Promise<void>) => Promise<Response | void> {
  return async (c, next) => {
    const request = c.req.raw;
    const outcome = await runGate(gate, request.headers, options);
    if (outcome.kind === "respond") return toWebResponse(outcome.response);
    attach([c, request], outcome.proof);
    (c as { set?: (key: string, value: unknown) => void }).set?.("agentProof", outcome.proof);
    await next();
    if (Object.keys(outcome.headers).length > 0) c.res = withHeaders(c.res, outcome.headers);
  };
}

// ---------------------------------------------------------------- Node http / Express

/** A Node request after a gate adapter: `req.agentProof` is set. */
export type RequestWithProof<T extends object = IncomingMessage> = T & { agentProof?: VerifiedProof };

function attachNode(req: object, proof: VerifiedProof): void {
  attach([req], proof);
  (req as RequestWithProof<object>).agentProof = proof;
}

/**
 * Express / Connect middleware: sets `req.agentProof` (also {@link proofOf}`(req)`).
 *
 * @example
 * ```ts
 * app.get("/report", expressProofGate(gate), (req, res) => res.json({ agent: proofOf(req)?.nullifier }));
 * app.get("/paid", expressProofGate(gate, { beforePaywall: true }), expressPaywall(paywall), handler);
 * ```
 */
export function expressProofGate(
  gate: BaseProofGate,
  options: ProofGateAdapterOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void {
  return (req, res, next) => {
    runGate(gate, req.headers, options).then((outcome) => {
      if (outcome.kind === "respond") return sendNode(res, outcome.response);
      attachNode(req, outcome.proof);
      for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
      next();
    }, next);
  };
}

/**
 * Protect a plain Node `http` request listener (`req.agentProof` is set).
 *
 * @example
 * ```ts
 * http.createServer(nodeProofGate(gate, (req, res) => res.end("members only"))).listen(4021);
 * ```
 */
export function nodeProofGate(
  gate: BaseProofGate,
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  options: ProofGateAdapterOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    runGate(gate, req.headers, options)
      .then(async (outcome) => {
        if (outcome.kind === "respond") return sendNode(res, outcome.response);
        attachNode(req, outcome.proof);
        for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
        await handler(req, res);
      })
      .catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else {
          res.destroy();
        }
      });
  };
}

// ---------------------------------------------------------------- Fastify

/**
 * Fastify route hook: sets `request.agentProof` (also {@link proofOf}`(request)`). With a
 * paywall, run both pre-handlers in order and keep the paywall's `onSend`.
 *
 * @example
 * ```ts
 * const proof = fastifyProofGate(gate, { beforePaywall: true });
 * const pay = fastifyPaywall(paywall);
 * app.get("/paid", { preHandler: [proof.preHandler, pay.preHandler], onSend: pay.onSend }, handler);
 * ```
 */
export function fastifyProofGate(
  gate: BaseProofGate,
  options: ProofGateAdapterOptions = {},
): { preHandler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown> } {
  return {
    async preHandler(request, reply) {
      const outcome = await runGate(gate, request.headers, options);
      if (outcome.kind === "respond") return sendFastify(reply, outcome.response);
      attachNode(request, outcome.proof);
      for (const [name, value] of Object.entries(outcome.headers)) reply.header(name, value);
      return undefined;
    },
  };
}
