// Packages that type-check this source (it ships as TypeScript) need snarkjs's declaration too.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./snarkjs.d.ts" />
import {
  ProofPresentation as ProofPresentationSchema,
  ProofRoot as ProofRootSchema,
  type PROOF_FAILURE_REASONS,
  type PROOF_ROOT_STATUSES,
} from "@agentbank/core/api";
import * as snarkjs from "snarkjs";
import type { Address, Hex, PublicClient } from "viem";
import type { z } from "zod";
import verificationKeyJson from "../artifacts/verification_key.json" with { type: "json" };
import { fromBytes32, isFieldElement, nonceField, scopeField, toBytes32 } from "./field";
import { bounds, parseProofRequest, requestHash, type ProofRequest } from "./request";

/**
 * Verifying a presentation against the verifier's own request. The public signals are rebuilt
 * from the request, the presented root and the presented nullifier; nothing else the agent
 * sends is trusted. Checks run in the order of docs/private-proofs.md and stop at the first
 * failure.
 */

export type ProofPresentation = z.output<typeof ProofPresentationSchema>;
export type ProofFailureReason = (typeof PROOF_FAILURE_REASONS)[number];
export type ProofRootStatus = (typeof PROOF_ROOT_STATUSES)[number];

/** The bundled snarkjs verification key of the claims circuit. */
export const VERIFICATION_KEY: Readonly<Record<string, unknown>> = verificationKeyJson;

/** What a verifier needs to know about a root (the registry's `rootInfo`). */
export interface RootInfo {
  epoch: bigint;
  /** Unix seconds the attested facts were read. */
  snapshotAt: number;
  /** Unix seconds of publication; null while not (yet) on-chain. */
  publishedAt: number | null;
  /** Unix seconds after which proofs against the root are refused. */
  validUntil: number;
  leafCount: number;
  revoked: boolean;
  /** Lifecycle status, when the source tracks one (the API does). */
  status?: ProofRootStatus;
}

export interface RootQuery {
  root: Hex;
  chainId: number;
  registry: Address | null;
}

/** Looks a root up; null when it was never published (on that chain and registry). */
export type RootResolver = (query: RootQuery) => Promise<RootInfo | null>;

/** A gate's nonce check: null when the nonce is authentic and unused. */
export type NonceCheck = (
  request: ProofRequest,
) => "nonce_invalid" | "nonce_reused" | null | Promise<"nonce_invalid" | "nonce_reused" | null>;

export interface VerifyPresentationArgs {
  /** The verifier's own request (validated here). */
  request: unknown;
  /** The agent's presentation (validated here). */
  presentation: unknown;
  /** The root's registry record, if already known (null: unknown root). */
  rootInfo?: RootInfo | null;
  /** Used when `rootInfo` is not given. */
  rootResolver?: RootResolver;
  /** Unix seconds (default now). */
  now?: number;
  /** Defaults to the bundled verification key. */
  verificationKey?: object;
  /** Gates: nonce authenticity and freshness (checked right after expiry). */
  checkNonce?: NonceCheck;
}

export interface VerificationResult {
  valid: boolean;
  reason: ProofFailureReason | null;
  /** The agent's pseudonym for this scope, when valid. */
  nullifier: Hex | null;
  /** The presented root, when the presentation parses. */
  root: Hex | null;
  /** The root's record, when it was looked up. */
  rootInfo: RootInfo | null;
  /** The validated request, when it parses. */
  request: ProofRequest | null;
}

/** Validate an untrusted presentation; throws on any schema violation or out-of-field value. */
export function parsePresentation(value: unknown): ProofPresentation {
  const presentation = ProofPresentationSchema.parse(value);
  if (
    !isFieldElement(fromBytes32(presentation.root)) ||
    !isFieldElement(fromBytes32(presentation.nullifier))
  ) {
    throw new RangeError("root and nullifier must be BN254 field elements");
  }
  return presentation;
}

/**
 * The 30 public signals, in circuit order, as base-10 strings: nullifier, root,
 * scope(request.scope), nonce, mins[13], maxs[13]. Built from the verifier's request; only the
 * root and nullifier come from the presentation.
 */
export function publicSignals(
  request: ProofRequest,
  presentation: Pick<ProofPresentation, "root" | "nullifier">,
): string[] {
  const { mins, maxs } = bounds(request);
  return [
    fromBytes32(presentation.nullifier),
    fromBytes32(presentation.root),
    scopeField(request.scope),
    nonceField(request.nonce),
    ...mins,
    ...maxs,
  ].map((v) => v.toString());
}

/** The status a root has at `now`, from its registry record. */
export function rootStatusOf(info: RootInfo | null, now: number): ProofRootStatus | null {
  if (info === null) return null;
  if (info.revoked) return "revoked";
  if (info.status === "failed" || info.status === "publishing") return info.status;
  if (info.publishedAt === null) return "publishing";
  if (info.status === "expired" || now > info.validUntil) return "expired";
  return "published";
}

function failure(
  reason: ProofFailureReason,
  partial: Partial<Pick<VerificationResult, "root" | "rootInfo" | "request">> = {},
): VerificationResult {
  return {
    valid: false,
    reason,
    nullifier: null,
    root: partial.root ?? null,
    rootInfo: partial.rootInfo ?? null,
    request: partial.request ?? null,
  };
}

/** The root check (step 3): null when the root is acceptable for this request at `now`. */
export function checkRoot(
  info: RootInfo | null,
  request: ProofRequest,
  now: number,
): ProofFailureReason | null {
  if (
    info === null ||
    info.publishedAt === null ||
    info.status === "publishing" ||
    info.status === "failed"
  ) {
    return "unknown_root";
  }
  if (info.revoked || info.status === "revoked") return "root_revoked";
  if (info.status === "expired" || now > info.validUntil) return "root_expired";
  if (now > info.snapshotAt + request.max_root_age_seconds) return "root_too_old";
  if (info.leafCount < request.min_anonymity_set) return "anonymity_set_too_small";
  return null;
}

/**
 * Verify a presentation. Order: malformed → request_expired → nonce (gates) →
 * request_hash_mismatch → root (unknown, revoked, expired, too old, anonymity set) →
 * invalid_proof. Root resolver errors propagate (fail closed); everything else is a result.
 */
export async function verifyPresentation(args: VerifyPresentationArgs): Promise<VerificationResult> {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  let request: ProofRequest;
  let presentation: ProofPresentation;
  try {
    request = parseProofRequest(args.request);
  } catch {
    return failure("malformed");
  }
  try {
    presentation = parsePresentation(args.presentation);
  } catch {
    return failure("malformed", { request });
  }
  const root = toBytes32(fromBytes32(presentation.root));

  if (now > request.expires_at) return failure("request_expired", { root, request });
  if (args.checkNonce) {
    const nonceFailure = await args.checkNonce(request);
    if (nonceFailure) return failure(nonceFailure, { root, request });
  }
  if (presentation.request_hash.toLowerCase() !== requestHash(request)) {
    return failure("request_hash_mismatch", { root, request });
  }

  let rootInfo: RootInfo | null;
  if (args.rootInfo !== undefined) rootInfo = args.rootInfo;
  else if (args.rootResolver) {
    rootInfo = await args.rootResolver({
      root,
      chainId: request.chain_id,
      registry: request.registry as Address | null,
    });
  } else throw new TypeError("verifyPresentation needs rootInfo or rootResolver");
  const rootFailure = checkRoot(rootInfo, request, now);
  if (rootFailure) return failure(rootFailure, { root, rootInfo, request });

  const ok = await snarkjs.groth16
    .verify(
      args.verificationKey ?? VERIFICATION_KEY,
      publicSignals(request, presentation),
      presentation.proof,
    )
    .catch(() => false);
  if (!ok) return failure("invalid_proof", { root, rootInfo, request });
  return {
    valid: true,
    reason: null,
    nullifier: toBytes32(fromBytes32(presentation.nullifier)),
    root,
    rootInfo,
    request,
  };
}

// ---------------------------------------------------------------- root resolvers

function unixFromIso(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

/** Map an API `ProofRoot` to a `RootInfo`. */
export function rootInfoFromApi(root: z.output<typeof ProofRootSchema>): RootInfo {
  return {
    epoch: BigInt(root.epoch),
    snapshotAt: unixFromIso(root.snapshot_at),
    publishedAt: root.published_at === null ? null : unixFromIso(root.published_at),
    validUntil: unixFromIso(root.valid_until),
    leafCount: root.leaf_count,
    revoked: root.status === "revoked",
    status: root.status,
  };
}

function sameRegistry(expected: Address | null, actual: string | null): boolean {
  return expected === null || (actual !== null && actual.toLowerCase() === expected.toLowerCase());
}

/**
 * Resolve roots through Agent Bank's public API (`GET /v1/proofs/roots/{root}`), for verifiers
 * without chain access. A root from another chain or registry than the request names is
 * treated as unknown.
 */
export function apiRootResolver(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): RootResolver {
  const base = baseUrl.replace(/\/+$/, "");
  return async ({ root, chainId, registry }) => {
    const response = await fetchImpl(`${base}/v1/proofs/roots/${root}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`root lookup failed: HTTP ${response.status}`);
    const parsed = ProofRootSchema.parse(await response.json());
    if (parsed.root.toLowerCase() !== root.toLowerCase())
      throw new Error("root lookup returned another root");
    if (parsed.chain_id !== chainId || !sameRegistry(registry, parsed.registry)) return null;
    return rootInfoFromApi(parsed);
  };
}

/** The registry views verifiers read (IAgentAttestationRegistry). */
export const ATTESTATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "rootInfo",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "epoch", type: "uint64" },
          { name: "snapshotAt", type: "uint64" },
          { name: "publishedAt", type: "uint64" },
          { name: "validUntil", type: "uint64" },
          { name: "leafCount", type: "uint32" },
          { name: "revoked", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isValidRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "latestRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "latestEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

/** The part of a viem public client the chain resolver uses. */
export type RegistryReader = Pick<PublicClient, "readContract"> & { chain?: { id: number } | undefined };

/**
 * Resolve roots by reading `AgentAttestationRegistry.rootInfo` on-chain. A root from another
 * chain or registry than the request names is treated as unknown; RPC errors propagate.
 */
export function chainRootResolver(client: RegistryReader, registryAddress: Address): RootResolver {
  return async ({ root, chainId, registry }) => {
    if (!sameRegistry(registry, registryAddress)) return null;
    if (client.chain !== undefined && client.chain.id !== chainId) return null;
    const info = await client.readContract({
      address: registryAddress,
      abi: ATTESTATION_REGISTRY_ABI,
      functionName: "rootInfo",
      args: [root],
    });
    if (info.epoch === 0n) return null;
    return {
      epoch: info.epoch,
      snapshotAt: Number(info.snapshotAt),
      publishedAt: Number(info.publishedAt),
      validUntil: Number(info.validUntil),
      leafCount: Number(info.leafCount),
      revoked: info.revoked,
    };
  };
}

/**
 * snarkjs keeps a BN254 curve (with worker threads) cached after the first prove or verify.
 * Short-lived processes (CLIs, scripts) call this so they can exit.
 */
export async function releaseProverResources(): Promise<void> {
  const cached = (globalThis as { curve_bn128?: { terminate?: () => Promise<void> } | null }).curve_bn128;
  if (cached?.terminate) await cached.terminate();
}
