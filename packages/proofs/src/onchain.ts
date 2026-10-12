import type { Hex } from "viem";
import { ProofInputError } from "./errors";
import { fromBytes32, nonceField, scopeField, toBytes32 } from "./field";
import { bounds, parseProofRequest, requestHash, type ProofRequest } from "./request";
import { parsePresentation, type ProofPresentation } from "./verifier";

/**
 * On-chain verification with `AgentClaimsVerifier` (contracts/src/AgentClaimsVerifier.sol):
 * its ABI and the calldata for `verify(claims, proof, minAnonymitySet, maxRootAge)` and
 * `verifyAndConsume(context, claims, proof, minAnonymitySet, maxRootAge)`, built from the
 * verifier's own request and the agent's presentation. A request for a consuming contract names
 * it with `onchainScopeId(chainId, consumer, context)`, so `claims.scope` equals
 * `scopeOf(consumer, context)` there.
 */

/** Thirteen u64 bounds in circuit order, as `uint64[13]` takes them. */
export type U64x13 = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

/** `IAgentClaimsVerifier.Claims`: the statement a proof is checked against. */
export interface ClaimsVerifierClaims {
  root: Hex;
  nullifier: bigint;
  scope: bigint;
  nonce: bigint;
  mins: U64x13;
  maxs: U64x13;
}

/** `IAgentClaimsVerifier.Groth16Proof`, in the generated verifier's calldata order (snarkjs `exportSolidityCallData`: `b` pairs swapped). */
export interface ClaimsVerifierProof {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
}

/** The `claims` and `proof` arguments of `AgentClaimsVerifier.verify` / `verifyAndConsume`. */
export interface ClaimsVerifierArgs {
  claims: ClaimsVerifierClaims;
  proof: ClaimsVerifierProof;
}

/** A Groth16 proof in the Solidity verifier's calldata order (`b` pairs swapped, as snarkjs exports). */
export type SolidityProof = ClaimsVerifierProof;

/** `bounds()` always yields 13 values per side. */
const u64x13 = (values: readonly bigint[]): U64x13 => [...values] as unknown as U64x13;

/** The proof of a presentation in `AgentClaimsVerifier`'s calldata order. */
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
): ClaimsVerifierClaims {
  const { mins, maxs } = bounds(request);
  return {
    root: toBytes32(fromBytes32(presentation.root)),
    nullifier: fromBytes32(presentation.nullifier),
    scope: scopeField(request.scope),
    nonce: nonceField(request.nonce),
    mins: u64x13(mins),
    maxs: u64x13(maxs),
  };
}

/**
 * The `claims` and `proof` arguments of `AgentClaimsVerifier.verify` and `verifyAndConsume`,
 * from the verifier's own request (scope, nonce, bounds) and the agent's presentation (root,
 * nullifier, proof). Typed for viem's `readContract` / `writeContract` with
 * {@link CLAIMS_VERIFIER_ABI}. For `verifyAndConsume`, the request's scope must be
 * `onchainScopeId(chainId, consumer, context)` of the calling contract.
 *
 * @throws ProofRequestError when the request is malformed; ProofInputError when the
 *   presentation is malformed or answers another request (request_hash).
 */
export function toClaimsVerifierArgs(request: unknown, presentation: unknown): ClaimsVerifierArgs {
  const parsedRequest = parseProofRequest(request);
  let parsed: ProofPresentation;
  try {
    parsed = parsePresentation(presentation);
  } catch (error) {
    throw new ProofInputError(`invalid presentation: ${(error as Error).message}`);
  }
  if (parsed.request_hash.toLowerCase() !== requestHash(parsedRequest)) {
    throw new ProofInputError("the presentation answers another request (request_hash mismatch)");
  }
  return { claims: toSolidityClaims(parsedRequest, parsed), proof: toSolidityProof(parsed) };
}

const claimsComponents = [
  { name: "root", type: "bytes32" },
  { name: "nullifier", type: "uint256" },
  { name: "scope", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "mins", type: "uint64[13]" },
  { name: "maxs", type: "uint64[13]" },
] as const;

const proofComponents = [
  { name: "a", type: "uint256[2]" },
  { name: "b", type: "uint256[2][2]" },
  { name: "c", type: "uint256[2]" },
] as const;

/** `IAgentClaimsVerifier` (functions, event and errors), for viem. */
export const CLAIMS_VERIFIER_ABI = [
  {
    type: "function",
    name: "ATTRIBUTE_COUNT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "groth16Verifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "scopeOf",
    stateMutability: "view",
    inputs: [
      { name: "consumer", type: "address" },
      { name: "context", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nonceUsed",
    stateMutability: "view",
    inputs: [
      { name: "scope", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      { name: "claims", type: "tuple", components: claimsComponents },
      { name: "proof", type: "tuple", components: proofComponents },
      { name: "minAnonymitySet", type: "uint32" },
      { name: "maxRootAge", type: "uint64" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "verifyAndConsume",
    stateMutability: "nonpayable",
    inputs: [
      { name: "context", type: "bytes32" },
      { name: "claims", type: "tuple", components: claimsComponents },
      { name: "proof", type: "tuple", components: proofComponents },
      { name: "minAnonymitySet", type: "uint32" },
      { name: "maxRootAge", type: "uint64" },
    ],
    outputs: [{ name: "nullifier", type: "uint256" }],
  },
  {
    type: "event",
    name: "ClaimsAccepted",
    inputs: [
      { name: "consumer", type: "address", indexed: true },
      { name: "scope", type: "uint256", indexed: true },
      { name: "nullifier", type: "uint256", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "RootNotValid", inputs: [{ name: "root", type: "bytes32" }] },
  {
    type: "error",
    name: "RootTooOld",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "snapshotAt", type: "uint64" },
      { name: "maxRootAge", type: "uint64" },
    ],
  },
  {
    type: "error",
    name: "AnonymitySetTooSmall",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "leafCount", type: "uint32" },
      { name: "minAnonymitySet", type: "uint32" },
    ],
  },
  { type: "error", name: "InvalidProof", inputs: [] },
  {
    type: "error",
    name: "ScopeMismatch",
    inputs: [
      { name: "expected", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "NonceAlreadyUsed",
    inputs: [
      { name: "scope", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  },
  { type: "error", name: "FieldElementOutOfRange", inputs: [] },
] as const;
