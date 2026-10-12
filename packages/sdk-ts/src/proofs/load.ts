import type * as ProofHttp from "./http";
import type * as NodeProver from "./node-prover";

/**
 * Lazily loaded parts of private proofs, so `@agentbank/sdk` itself loads neither snarkjs nor
 * Node built-ins: the HTTP header helpers (on the first proof challenge) and the Node prover
 * (on the first proof). A failed load is retried on the next call.
 */

let http: Promise<typeof ProofHttp> | undefined;
let nodeProver: Promise<typeof NodeProver> | undefined;

export async function loadProofHttp(): Promise<typeof ProofHttp> {
  http ??= import("./http");
  try {
    return await http;
  } catch (error) {
    http = undefined;
    throw error;
  }
}

export async function loadNodeProver(): Promise<typeof NodeProver> {
  nodeProver ??= import("./node-prover");
  try {
    return await nodeProver;
  } catch (error) {
    nodeProver = undefined;
    throw error;
  }
}

/** Whether the Node prover was loaded (so there may be prover resources to release). */
export function nodeProverLoaded(): Promise<typeof NodeProver> | undefined {
  return nodeProver;
}
