/**
 * Copy the claims circuit files (about 11 MB) into `dist/circuits/` (or the directory given as
 * the first argument, relative to the working directory), where the bundled prover looks first.
 * Nothing is copied unless every file matches the circuit manifest's SHA-256. Runs after every
 * `tsup` build (`onSuccess`) of the SDK and of the MCP server, which bundles the SDK.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS_DIR, artifactPaths, verifyArtifacts } from "@agentbank/proofs/artifacts";

const check = verifyArtifacts(ARTIFACTS_DIR);
if (!check.ok) {
  console.error(`circuit artifacts do not match the manifest: ${check.mismatches.join(", ")}`);
  process.exit(1);
}
const target = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../dist/circuits/", import.meta.url));
mkdirSync(target, { recursive: true });
const source = artifactPaths(ARTIFACTS_DIR);
const copied = artifactPaths(target);
for (const key of ["wasm", "zkey", "verificationKey", "manifest"] as const)
  copyFileSync(source[key], copied[key]);
console.log(`circuits → ${target}`);
