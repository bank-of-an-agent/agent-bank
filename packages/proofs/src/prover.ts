// Packages that type-check this source (it ships as TypeScript) need snarkjs's declaration too.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./snarkjs.d.ts" />
import { ProofWitness as ProofWitnessSchema } from "@agentbank/core/api";
import * as snarkjs from "snarkjs";
import type { Hex } from "viem";
import { artifactPaths } from "./artifacts";
import { ProofInputError, ProofRefusedError } from "./errors";
import { fromBytes32, nonceField, scopeField, toBytes32 } from "./field";
import {
  bounds,
  checkWitness,
  parseProofRequest,
  requestHash,
  type ProofRequest,
  type ProofWitness,
} from "./request";
import { ATTRIBUTES, PROOF_TYPE } from "./schema";
import { computeRoot, identityCommitment, leafHash, parseSecret } from "./tree";
import { publicSignals, type ProofPresentation } from "./verifier";

export { releaseProverResources } from "./verifier";

/**
 * Proving (Node): the agent proves, with its secret and the witness Agent Bank served, that its
 * leaf is in the published tree and satisfies the verifier's bounds. The prover refuses, before
 * spending a second on proving, when the witness cannot satisfy the request or the request
 * constrains attributes the owner did not disclose.
 */

export interface ProverArtifacts {
  /** Witness generator: a path or the file's bytes. */
  wasm: string | Uint8Array;
  /** Proving key: a path or the file's bytes. */
  zkey: string | Uint8Array;
}

export interface ProveArgs {
  /** The agent's proof secret (bytes32 hex). Never leaves the agent. */
  secret: Hex | string | bigint;
  /** `GET /v1/accounts/{id}/proofs/witness`. */
  witness: unknown;
  /** The verifier's request. */
  request: unknown;
  /** Defaults to the artifacts bundled with this package. */
  artifacts?: ProverArtifacts;
}

/** The circuit's input signals for a prove call, as base-10 strings. */
export interface CircuitInput {
  secret: string;
  attributes: string[];
  disclosureMask: string;
  siblings: string[];
  pathBits: string[];
  root: string;
  scope: string;
  nonce: string;
  mins: string[];
  maxs: string[];
}

export function parseWitness(value: unknown): ProofWitness {
  const parsed = ProofWitnessSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProofInputError(`invalid witness: ${issue?.path.join(".") || "witness"}: ${issue?.message}`);
  }
  return parsed.data;
}

function secretOf(value: ProveArgs["secret"]): bigint {
  try {
    return parseSecret(value);
  } catch (error) {
    throw new ProofInputError(`invalid secret: ${(error as Error).message}`);
  }
}

/**
 * Check that `witness` can prove `request` with `secret`, and build the circuit input. Throws
 * `ProofRefusedError` (chain_mismatch, undisclosed, unsatisfiable, witness_mismatch) or
 * `ProofInputError` / `ProofRequestError` for malformed input.
 */
export function prepareProof(args: Omit<ProveArgs, "artifacts">): {
  request: ProofRequest;
  witness: ProofWitness;
  input: CircuitInput;
} {
  const request = parseProofRequest(args.request);
  const witness = parseWitness(args.witness);
  const secret = secretOf(args.secret);

  if (witness.chain_id !== request.chain_id) {
    throw new ProofRefusedError(
      "chain_mismatch",
      `the witness is for chain ${witness.chain_id}, the request for chain ${request.chain_id}`,
    );
  }
  if (request.registry !== null && witness.registry?.toLowerCase() !== request.registry.toLowerCase()) {
    throw new ProofRefusedError(
      "chain_mismatch",
      "the witness root is from another registry than the request names",
    );
  }

  const check = checkWitness(witness, request);
  if (check.undisclosed.length > 0) {
    throw new ProofRefusedError(
      "undisclosed",
      `the request constrains attributes the owner did not disclose (classes: ${check.undisclosedClasses.join(", ")})`,
      check.outOfBounds,
      check.undisclosedClasses,
    );
  }
  if (check.outOfBounds.length > 0) {
    throw new ProofRefusedError(
      "unsatisfiable",
      `attested values do not satisfy the request (attributes: ${check.outOfBounds.join(", ")})`,
      check.outOfBounds,
    );
  }

  const root = fromBytes32(witness.root);
  const siblings = witness.siblings.map((s) => BigInt(s));
  const leaf = leafHash(identityCommitment(secret), witness.attributes, witness.disclosure_mask);
  if (computeRoot(leaf, siblings, witness.path_bits) !== root) {
    throw new ProofRefusedError(
      "witness_mismatch",
      "the secret and the witness do not hash to the witness root (wrong secret, or a stale witness)",
    );
  }

  const { mins, maxs } = bounds(request);
  const input: CircuitInput = {
    secret: secret.toString(),
    attributes: ATTRIBUTES.map((a) => witness.attributes[a]),
    disclosureMask: witness.disclosure_mask.toString(),
    siblings: witness.siblings,
    pathBits: witness.path_bits.map(String),
    root: root.toString(),
    scope: scopeField(request.scope).toString(),
    nonce: nonceField(request.nonce).toString(),
    mins: mins.map(String),
    maxs: maxs.map(String),
  };
  return { request, witness, input };
}

/**
 * Prove a request (about 1.3 s in Node). Returns the presentation to send back as
 * `AGENT-PROOF: base64(json({ request, presentation }))`.
 */
export async function prove(args: ProveArgs): Promise<ProofPresentation> {
  const { request, witness, input } = prepareProof(args);
  const files = args.artifacts ?? artifactPaths();
  const { proof, publicSignals: signals } = await snarkjs.groth16.fullProve(
    input as unknown as Record<string, unknown>,
    files.wasm,
    files.zkey,
  );
  const presentation: ProofPresentation = {
    type: PROOF_TYPE,
    request_hash: requestHash(request),
    root: toBytes32(fromBytes32(witness.root)),
    nullifier: toBytes32(BigInt(signals[0] as string)),
    proof: {
      pi_a: [proof.pi_a[0], proof.pi_a[1], proof.pi_a[2]] as [string, string, string],
      pi_b: [
        [proof.pi_b[0]?.[0], proof.pi_b[0]?.[1]],
        [proof.pi_b[1]?.[0], proof.pi_b[1]?.[1]],
        [proof.pi_b[2]?.[0], proof.pi_b[2]?.[1]],
      ] as [[string, string], [string, string], [string, string]],
      pi_c: [proof.pi_c[0], proof.pi_c[1], proof.pi_c[2]] as [string, string, string],
      protocol: "groth16",
      curve: "bn128",
    },
  };
  const expected = publicSignals(request, presentation);
  if (signals.length !== expected.length || signals.some((s, i) => s !== expected[i])) {
    throw new Error("the circuit's public signals differ from the request's (artifact mismatch?)");
  }
  return presentation;
}

/** A Groth16 proof in the Solidity verifier's calldata order (`b` pairs swapped, as snarkjs exports). */
export interface SolidityProof {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
}

export function toSolidityProof(presentation: Pick<ProofPresentation, "proof">): SolidityProof {
  const { pi_a, pi_b, pi_c } = presentation.proof;
  return {
    a: [BigInt(pi_a[0]), BigInt(pi_a[1])],
    b: [
      [BigInt(pi_b[0][1]), BigInt(pi_b[0][0])],
      [BigInt(pi_b[1][1]), BigInt(pi_b[1][0])],
    ],
    c: [BigInt(pi_c[0]), BigInt(pi_c[1])],
  };
}

/** `IAgentClaimsVerifier.Claims` for a request and presentation (for on-chain verification). */
export function toSolidityClaims(
  request: ProofRequest,
  presentation: Pick<ProofPresentation, "root" | "nullifier">,
): {
  root: Hex;
  nullifier: bigint;
  scope: bigint;
  nonce: bigint;
  mins: bigint[];
  maxs: bigint[];
} {
  const { mins, maxs } = bounds(request);
  return {
    root: toBytes32(fromBytes32(presentation.root)),
    nullifier: fromBytes32(presentation.nullifier),
    scope: scopeField(request.scope),
    nonce: nonceField(request.nonce),
    mins,
    maxs,
  };
}
