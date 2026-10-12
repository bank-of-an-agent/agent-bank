/**
 * `@agentbank/sdk/prover`: the Node prover for private proofs (snarkjs with the circuit files
 * shipped in `dist/circuits/`).
 *
 * In Node, `AgentClient` with a `proofSecret` loads it on its own at the first proof, from a
 * location computed at run time that bundlers never follow (it reads the circuit files from
 * disk). In a bundled server app, import it and pass it explicitly:
 *
 * ```ts
 * import { nodeProver } from "@agentbank/sdk/prover";
 * const agent = new AgentClient({ …, proofSecret, proofs: { prover: nodeProver } });
 * ```
 *
 * Outside Node, pass a prover of your own (`proofs.prover`).
 *
 * `toClaimsVerifierArgs(request, presentation)` turns a proof for an on-chain scope id into the
 * arguments of `AgentClaimsVerifier.verify` / `verifyAndConsume`.
 *
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARTIFACTS_DIR, artifactPaths } from "@agentbank/proofs/artifacts";
import { prove, releaseProverResources } from "@agentbank/proofs/prover";
import type { Prover, ProverArtifacts } from "./proofs/agent";
import { ProofError } from "./proofs/errors";

let cached: ProverArtifacts | undefined;

/**
 * The circuit files (`agent_claims.wasm`, `agent_claims.zkey`): next to the built SDK
 * (`dist/circuits/`, copied and checked against the circuit manifest by the build), or from
 * `@agentbank/proofs` in a source checkout.
 */
export function defaultArtifacts(): ProverArtifacts {
  if (cached) return cached;
  const candidates = [fileURLToPath(new URL("./circuits/", import.meta.url)), ARTIFACTS_DIR];
  for (const dir of candidates) {
    const paths = artifactPaths(dir);
    if (existsSync(paths.wasm) && existsSync(paths.zkey)) {
      cached = { wasm: paths.wasm, zkey: paths.zkey };
      return cached;
    }
  }
  throw new ProofError(
    "prover_unavailable",
    "The circuit files (agent_claims.wasm, agent_claims.zkey) were not found next to the SDK; pass proofs.artifacts",
  );
}

/** A {@link Prover} for `AgentClient`'s `proofs.prover`, with the bundled circuit files. */
export const nodeProver: Prover = (input) => prove({ ...input, artifacts: defaultArtifacts() });

export { prove, releaseProverResources };
export {
  CLAIMS_VERIFIER_ABI,
  toClaimsVerifierArgs,
  type ClaimsVerifierArgs,
  type ClaimsVerifierClaims,
  type ClaimsVerifierProof,
  type U64x13,
} from "@agentbank/proofs/onchain";
export type { Prover, ProverArtifacts, ProverInput } from "./proofs/agent";
