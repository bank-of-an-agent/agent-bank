/**
 * `@agentbank/sdk/proof-server`: admit agents by what Agent Bank attests about them, without
 * learning who they are (private proofs, docs/private-proofs.md).
 *
 * {@link createProofGate} builds a stateless gate (HMAC-derived nonces, a replay cache, root
 * checks against Agent Bank's API or the registry on Base) from requirement builders such as
 * {@link verifiedCompany}, {@link canPayPerTx} or {@link reservedFor}. Adapters mirror the x402
 * paywall's: {@link withProofGate} (Web `Request`/`Response`), {@link honoProofGate},
 * {@link expressProofGate}, {@link nodeProofGate} and {@link fastifyProofGate}. A resource can
 * require a proof and a payment: put the gate first with `{ beforePaywall: true }`, then the
 * paywall from `@agentbank/sdk/x402-server`.
 *
 * @example
 * ```ts
 * import { apiRootResolver, canPayPerTx, createProofGate, honoProofGate, verifiedCompany } from "@agentbank/sdk/proof-server";
 *
 * const gate = createProofGate({
 *   scope: "api.seller.example",
 *   key: process.env.PROOF_GATE_KEY!,
 *   require: [verifiedCompany(), canPayPerTx("5.00")],
 *   rootResolver: apiRootResolver("https://api.agentbank.example"),
 * });
 * app.get("/report", honoProofGate(gate), (c) => c.json({ agent: c.get("agentProof").nullifier }));
 * ```
 *
 * @packageDocumentation
 */

export { createProofGate, isTwoPhaseGate, type ProofGate, type VerifiedGateResult } from "./proofs/gate";

export {
  expressProofGate,
  fastifyProofGate,
  honoProofGate,
  nodeProofGate,
  proofOf,
  withProofGate,
  type ProofGateAdapterOptions,
  type ProofGateVariables,
  type RequestWithProof,
  type VerifiedProof,
} from "./proofs/gate-adapters";

export {
  decodeProof,
  decodeProofRequired,
  decodeProofResponse,
  encodeProof,
  encodeProofRequired,
  encodeProofResponse,
  gateNonce,
  MemoryReplayCache,
  PROOF_AUTH_SCHEME,
  PROOF_HEADERS,
  ProofHeaderError,
  wwwAuthenticate,
  type HeaderSource,
  type ProofChallenge,
  type ProofEnvelope,
  type ProofGateOptions,
  type ProofGateResult,
  type ReplayCache,
} from "@agentbank/proofs/http";

export {
  accountOlderThan,
  balanceAtLeast,
  canPayPerDay,
  canPayPerTx,
  createProofRequest,
  mergeConstraints,
  parseProofRequest,
  requestHash,
  reputation,
  reservedFor,
  spendingCappedAt,
  verifiedCompany,
  verifiedPrincipal,
  type Constraints,
  type CreateProofRequestOptions,
  type Requirement,
  type RequirementContext,
} from "@agentbank/proofs/request";

export {
  apiRootResolver,
  ATTESTATION_REGISTRY_ABI,
  chainRootResolver,
  checkRoot,
  releaseProverResources,
  rootInfoFromApi,
  verifyPresentation,
  VERIFICATION_KEY,
  type RegistryReader,
  type RootInfo,
  type RootQuery,
  type RootResolver,
  type VerificationResult,
  type VerifyPresentationArgs,
} from "@agentbank/proofs/verifier";

export { onchainScope, scopeField, scopeTagOf } from "@agentbank/proofs/field";
export { ProofRequestError } from "@agentbank/proofs";

export type { ProofFailureReason, ProofPresentation, ProofRequest } from "./types";
