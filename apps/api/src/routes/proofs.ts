import { AgentBankError } from "@agentbank/core";
import type { Handlers } from "../http/registry";

/**
 * Private proofs (docs/private-proofs.md, ADR 0014): circuit, roots, verification, per-agent
 * settings, identity enrollment, witnesses and proof-of-funds reservations.
 *
 * Placeholders: the contract, the OpenAPI document and `@agentbank/proofs` exist, but these
 * operations are not served yet. Each answers `403 feature_gated` (the same answer the API
 * gives when `FEATURE_PRIVATE_PROOFS` is off) until the real handlers replace them.
 */

type ProofOperation =
  | "getProofCircuit"
  | "listProofRoots"
  | "getProofRoot"
  | "verifyProof"
  | "getProofSettings"
  | "updateProofSettings"
  | "enrollProofIdentity"
  | "getProofIdentity"
  | "getProofWitness"
  | "createProofReservation"
  | "listProofReservations"
  | "getProofReservation"
  | "releaseProofReservation";

function notYetServed(operationId: ProofOperation) {
  return async (): Promise<never> => {
    throw new AgentBankError("feature_gated", `Private proofs are not available yet (${operationId})`);
  };
}

export const proofHandlers: Pick<Handlers, ProofOperation> = {
  getProofCircuit: notYetServed("getProofCircuit"),
  listProofRoots: notYetServed("listProofRoots"),
  getProofRoot: notYetServed("getProofRoot"),
  verifyProof: notYetServed("verifyProof"),
  getProofSettings: notYetServed("getProofSettings"),
  updateProofSettings: notYetServed("updateProofSettings"),
  enrollProofIdentity: notYetServed("enrollProofIdentity"),
  getProofIdentity: notYetServed("getProofIdentity"),
  getProofWitness: notYetServed("getProofWitness"),
  createProofReservation: notYetServed("createProofReservation"),
  listProofReservations: notYetServed("listProofReservations"),
  getProofReservation: notYetServed("getProofReservation"),
  releaseProofReservation: notYetServed("releaseProofReservation"),
};
