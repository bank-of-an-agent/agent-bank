import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARTIFACTS_DIR, artifactPaths } from "@agentbank/proofs/artifacts";
import { prove, releaseProverResources, type ProverArtifacts } from "@agentbank/proofs/prover";
import { ProofError } from "./errors";

/**
 * The Node prover, loaded lazily (only when an agent proves), so the main entry point stays
 * free of Node built-ins and of snarkjs.
 *
 * Circuit files: the built SDK ships them in `dist/circuits/` (copied and checked against the
 * circuit manifest by the build); from a source checkout they come from `@agentbank/proofs`.
 */

let cached: ProverArtifacts | undefined;

/** The bundled circuit files (`agent_claims.wasm`, `agent_claims.zkey`). */
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

export { prove, releaseProverResources };
