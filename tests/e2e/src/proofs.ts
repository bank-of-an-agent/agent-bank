import { randomBytes } from "node:crypto";
import { isAgentBankError, type AgentBankError } from "@agentbank/core";
import { artifactPaths } from "@agentbank/proofs/artifacts";
import { prove } from "@agentbank/proofs/prover";
import {
  ProofError,
  type DisclosureClass,
  type ProofRoot,
  type ProofSettings,
  type ProofWitness,
  type Prover,
} from "@agentbank/sdk";
import {
  apiRootResolver,
  createProofGate,
  decodeProofResponse,
  PROOF_HEADERS,
  proofOf,
  withProofGate,
  type HeaderSource,
  type ProofGate,
  type ProofGateResult,
  type Requirement,
  type VerifiedProof,
} from "@agentbank/sdk/proof-server";
import { createPaywall, withPaywall, X402_HEADERS } from "@agentbank/sdk/x402-server";
import type { Address, Hex } from "viem";
import { markProofTreeDirty } from "../../../apps/api/src/domain/proofs";
import { waitFor, type AgentWorld } from "./actors";
import { serveWeb, type FetchLike, type HttpServer } from "./net";
import type { Stack } from "./stack";

/**
 * Private proofs on the e2e stack (docs/private-proofs.md): root helpers that drive the real
 * `proofs-roots` job, proof-gated sellers built from `@agentbank/sdk/proof-server` (optionally
 * in front of an x402 paywall), and the counters the `gate:proofs` evidence is written from.
 */

// ---------------------------------------------------------------- roots

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Every root of the stack's chain, newest first (public `GET /v1/proofs/roots`, all pages). */
export async function listProofRoots(stack: Stack): Promise<ProofRoot[]> {
  const out: ProofRoot[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `limit=100&cursor=${encodeURIComponent(cursor)}` : "limit=100";
    const page: { data: ProofRoot[]; next_cursor: string | null } = await getJson(
      `${stack.apiUrl}/v1/proofs/roots?${query}`,
    );
    out.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

/** The newest root (any status), or undefined before the first build. */
export async function latestProofRoot(stack: Stack): Promise<ProofRoot | undefined> {
  const page = await getJson<{ data: ProofRoot[] }>(`${stack.apiUrl}/v1/proofs/roots?limit=1`);
  return page.data[0];
}

/** One root as verifiers see it (public `GET /v1/proofs/roots/{root}`). */
export function proofRoot(stack: Stack, root: string): Promise<ProofRoot> {
  return getJson<ProofRoot>(`${stack.apiUrl}/v1/proofs/roots/${root}`);
}

/**
 * Snapshot the attested facts now and wait until the root is on-chain: raise the tree's dirty
 * flag exactly as an enrollment, settings change or reservation does (`markProofTreeDirty`), then
 * pump the driver, which runs the real `proofs-roots` job, until a root newer than the current
 * one is published. Facts that never mark the tree dirty (balances, payments, escrows) are
 * otherwise only re-attested every `PROOFS_ROOT_INTERVAL_SECONDS`.
 */
export async function publishProofRoot(stack: Stack): Promise<ProofRoot> {
  const before = BigInt((await latestProofRoot(stack))?.epoch ?? "0");
  await markProofTreeDirty(stack.deps.db, stack.chainId, { narrowing: false }, stack.clock.now());
  return waitFor(
    stack,
    async () => {
      const latest = await latestProofRoot(stack);
      return latest && BigInt(latest.epoch) > before && latest.status === "published" ? latest : undefined;
    },
    "the proofs-roots job to publish a new root",
  );
}

/** Wait until the API reports `root` with `status` (e.g. `revoked` after a narrowing change). */
export function waitForRootStatus(
  stack: Stack,
  root: string,
  status: ProofRoot["status"],
): Promise<ProofRoot> {
  return waitFor(
    stack,
    async () => {
      const current = await proofRoot(stack, root);
      return current.status === status ? current : undefined;
    },
    `root ${root.slice(0, 10)}… to become ${status}`,
  );
}

/** The root as `AgentAttestationRegistry` on the (simulated) chain records it, via the chain gateway. */
export function registryRoot(stack: Stack, root: string) {
  return stack.deps.chain.getAttestationRoot(root as Hex);
}

/** Owner-signed widening: enable proofs with `disclose`, then the agent enrolls `Poseidon(secret)`. */
export async function enableProofs(
  world: AgentWorld,
  disclose: readonly DisclosureClass[],
): Promise<ProofSettings> {
  const settings = await world.principal.proofs.configure(world.agentId, { enabled: true, disclose });
  await world.agent.proofs.enroll();
  return settings;
}

// ---------------------------------------------------------------- counters (gate evidence)

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** What happened to proofs during a run: the numbers of `docs/gates/evidence/private-proofs.md`. */
export class ProofStats {
  /** Wall-clock milliseconds of each Groth16 proof (the prover itself, witness in hand). */
  readonly provingMs: number[] = [];
  /** Milliseconds of each gate check that carried a presentation (root lookup + Groth16 verify). */
  readonly verifyingMs: number[] = [];
  /** The anonymity set (`leaf_count`) of the root behind each proof. */
  readonly anonymitySets: number[] = [];
  readonly rootsProvedAgainst = new Set<string>();
  /** `min_anonymity_set` values the gates asked for. */
  readonly gateMinAnonymitySets = new Set<number>();
  /** Gate checks that accepted a presentation. */
  accepted = 0;
  /** 401 challenges issued to requests without a presentation. */
  challenges = 0;
  /** Gate refusals of a presentation, by verifier reason. */
  readonly verifierRefusals = new Map<string, number>();
  /** Refusals by the agent's SDK before (or instead of) proving, by `ProofError` reason. */
  readonly agentRefusals = new Map<string, number>();
  /** Agent Bank refusing to serve a witness, by error code (and reason). */
  readonly witnessRefusals = new Map<string, number>();
  /** `POST /v1/proofs/verify` outcomes (`valid` or the failure reason). */
  readonly apiVerifications = new Map<string, number>();
  /** Proof-of-funds reservations the run created, released early and saw expire. */
  readonly reservations = { created: 0, released: 0, expired: 0 };
  /** Scenarios that ran to completion. */
  readonly scenarios: { id: string; title: string; detail: string }[] = [];

  get generated(): number {
    return this.provingMs.length;
  }

  recordProof(ms: number, witness: ProofWitness): void {
    this.provingMs.push(ms);
    this.anonymitySets.push(witness.leaf_count);
    this.rootsProvedAgainst.add(witness.root);
  }

  recordGate(result: ProofGateResult, ms: number, hadProof: boolean): void {
    if (!hadProof) {
      this.challenges++;
      return;
    }
    this.verifyingMs.push(ms);
    if (result.kind === "verified") this.accepted++;
    else bump(this.verifierRefusals, result.reason ?? "missing");
  }

  recordApiVerification(valid: boolean, reason: string | null): void {
    bump(this.apiVerifications, valid ? "valid" : (reason ?? "invalid"));
  }

  recordRefusal(error: AgentBankError): void {
    if (error instanceof ProofError) {
      // A verifier's refusal is counted where it happened, at the gate.
      if (error.reason !== "proof_rejected") bump(this.agentRefusals, error.reason);
      return;
    }
    const reason = (error.extensions as { reason?: unknown }).reason;
    bump(this.witnessRefusals, typeof reason === "string" ? `${error.code} (${reason})` : error.code);
  }

  scenario(id: string, title: string, detail: string): void {
    this.scenarios.push({ id, title, detail });
  }
}

/**
 * The SDK's Node prover (`@agentbank/proofs/prover` with the bundled circuit), timed: what an
 * `AgentClient` runs by default, plus the counters.
 */
export function timedProver(stats: ProofStats): Prover {
  const { wasm, zkey } = artifactPaths();
  return async (input) => {
    const started = performance.now();
    const presentation = await prove({ ...input, artifacts: { wasm, zkey } });
    stats.recordProof(performance.now() - started, input.witness);
    return presentation;
  };
}

/** Await something that must be refused (a `ProofError` or an API error); record and return it. */
export async function refusal(
  stats: ProofStats | undefined,
  promise: Promise<unknown>,
): Promise<AgentBankError> {
  try {
    await promise;
  } catch (error) {
    if (!isAgentBankError(error)) throw error;
    stats?.recordRefusal(error);
    return error;
  }
  throw new Error("expected the proof to be refused, but it went through");
}

// ---------------------------------------------------------------- proof-gated sellers

/** One proof-gated resource. */
export interface ProofRouteOptions {
  require: readonly Requirement[];
  /** The request's `min_anonymity_set` (default: the seller's). */
  minAnonymitySet?: number;
  /** Also charge this much with x402 after the proof (decimal USDC; needs `payTo`). */
  price?: string;
  /** The JSON served once admitted (default: the route, scope, nullifier and root). */
  body?: (proof: VerifiedProof | undefined) => unknown;
}

/** One request a seller saw on a proof-gated route. */
export interface SellerRequest {
  path: string;
  /** The `AGENT-PROOF` header as received (null without one). */
  proof: string | null;
  /** Whether it carried an x402 payment. */
  paid: boolean;
  status: number;
  /** The gate's failure reason on a 401 (null for a first challenge). */
  reason: string | null;
  /** From `AGENT-PROOF-RESPONSE` on acceptance. */
  nullifier: string | null;
}

export interface ProofRoutesOptions {
  /** The verifier's scope: its host name, which the agent's SDK checks against the URL. */
  scope: string;
  /** Agent Bank's API: roots are resolved through `GET /v1/proofs/roots/{root}`. */
  apiUrl: string;
  /** Default `min_anonymity_set` of the requests (small stacks have small trees). */
  minAnonymitySet: number;
  /** HMAC key of the stateless gates (default: 32 random bytes). */
  key?: string;
  stats?: ProofStats;
  /** x402 for priced routes. */
  payTo?: string;
  facilitatorUrl?: string;
  network?: string;
  /** `fetch` the paywall uses to reach the facilitator. */
  fetch?: FetchLike;
}

export interface ProofRoutes {
  readonly scope: string;
  /** Requests seen so far, in order. */
  readonly log: SellerRequest[];
  /** Add (or replace) a proof-gated route. */
  route(path: string, options: ProofRouteOptions): void;
  /** The gate behind a route (to issue challenges by hand). */
  gate(path: string): ProofGate | undefined;
  /** Serve a request; null when no proof-gated route matches. */
  handle(request: Request): Promise<Response | null>;
}

/** Count gate checks into `stats` (time, outcome) without changing what the gate does. */
function instrument(gate: ProofGate, stats: ProofStats | undefined): ProofGate {
  if (!stats) return gate;
  const timed =
    (run: (headers: HeaderSource) => Promise<ProofGateResult>) =>
    async (headers: HeaderSource): Promise<ProofGateResult> => {
      const hadProof = Boolean(
        (headers as { get(name: string): string | null }).get?.(PROOF_HEADERS.proof)?.trim(),
      );
      const started = performance.now();
      const result = await run(headers);
      stats.recordGate(result, performance.now() - started, hadProof);
      return result;
    };
  return { ...gate, check: timed(gate.check), peek: timed(gate.peek) };
}

/**
 * Proof-gated routes as a seller would build them with `@agentbank/sdk/proof-server`: one
 * stateless gate per route (HMAC nonces, replay cache, roots checked against Agent Bank's API on
 * the request's chain and registry, read from `GET /v1/proofs/circuit`), the Web adapter
 * `withProofGate`, and for priced routes the x402 paywall after the gate (`beforePaywall`).
 */
export async function createProofRoutes(options: ProofRoutesOptions): Promise<ProofRoutes> {
  const circuit = await getJson<{ chain_id: number; registry: Address | null }>(
    `${options.apiUrl}/v1/proofs/circuit`,
  );
  const key = options.key ?? randomBytes(32).toString("hex");
  const rootResolver = apiRootResolver(options.apiUrl);
  const routes = new Map<string, { gate: ProofGate; handler: (request: Request) => Promise<Response> }>();
  const log: SellerRequest[] = [];

  const route = (path: string, def: ProofRouteOptions): void => {
    const minAnonymitySet = def.minAnonymitySet ?? options.minAnonymitySet;
    options.stats?.gateMinAnonymitySets.add(minAnonymitySet);
    const gate = instrument(
      createProofGate({
        scope: options.scope,
        key,
        require: def.require,
        rootResolver,
        minAnonymitySet,
        chainId: circuit.chain_id,
        registry: circuit.registry,
      }),
      options.stats,
    );
    const serve = async (request: Request): Promise<Response> => {
      const proof = proofOf(request);
      return Response.json(
        def.body
          ? def.body(proof)
          : { ok: true, resource: path, scope: options.scope, nullifier: proof?.nullifier ?? null },
      );
    };
    let handler: (request: Request) => Promise<Response> = serve;
    if (def.price !== undefined) {
      if (!options.payTo || !options.facilitatorUrl) throw new Error(`${path}: a priced route needs payTo`);
      const paywall = createPaywall({
        facilitatorUrl: options.facilitatorUrl,
        payTo: options.payTo,
        price: def.price,
        network: options.network ?? `eip155:${circuit.chain_id}`,
        description: `Proof-gated ${path}`,
        mimeType: "application/json",
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      handler = withPaywall(paywall, serve);
    }
    routes.set(path, {
      gate,
      handler: withProofGate(gate, handler, { beforePaywall: def.price !== undefined }),
    });
  };

  const handle = async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    const entry = routes.get(path);
    if (!entry) return null;
    const response = await entry.handler(request);
    let reason: string | null = null;
    if (response.status === 401) {
      reason = await response
        .clone()
        .json()
        .then((body) => (body as { reason?: string | null }).reason ?? null)
        .catch(() => null);
    }
    let nullifier: string | null = null;
    const ack = response.headers.get(PROOF_HEADERS.response);
    if (ack) {
      try {
        nullifier = decodeProofResponse(ack).nullifier;
      } catch {
        // a malformed acknowledgement is the gate's bug, not the agent's; the test sees null
      }
    }
    log.push({
      path,
      proof: request.headers.get(PROOF_HEADERS.proof),
      paid: [X402_HEADERS.paymentSignature, X402_HEADERS.v1Payment].some((h) => request.headers.has(h)),
      status: response.status,
      reason,
      nullifier,
    });
    return response;
  };

  return { scope: options.scope, log, route, gate: (path) => routes.get(path)?.gate, handle };
}

export interface ProofSeller extends ProofRoutes {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** A seller serving only proof-gated routes, on its own port. */
export async function startProofSeller(
  options: ProofRoutesOptions & { port?: number },
): Promise<ProofSeller> {
  const routes = await createProofRoutes(options);
  const server: HttpServer = await serveWeb((request) => routes.handle(request), options.port ?? 0);
  return { ...routes, url: server.url, port: server.port, close: () => server.close() };
}
