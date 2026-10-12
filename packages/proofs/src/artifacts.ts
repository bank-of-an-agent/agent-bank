import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CLAIMS_SCHEMA } from "./schema";

/**
 * The claims circuit artifacts bundled with this package (Node only). They are produced and
 * checked in the contracts repository (`contracts/circuits`) and copied here by
 * `pnpm --filter @agentbank/proofs sync-circuits`, which verifies them against the manifest.
 */

export const ARTIFACTS_DIR = fileURLToPath(new URL("../artifacts/", import.meta.url));

export interface ArtifactPaths {
  wasm: string;
  zkey: string;
  verificationKey: string;
  manifest: string;
}

export function artifactPaths(dir: string = ARTIFACTS_DIR): ArtifactPaths {
  return {
    wasm: join(dir, "agent_claims.wasm"),
    zkey: join(dir, "agent_claims.zkey"),
    verificationKey: join(dir, "verification_key.json"),
    manifest: join(dir, "manifest.json"),
  };
}

export const CircuitManifestSchema = z
  .object({
    schema: z.literal(CLAIMS_SCHEMA),
    protocol: z.literal("groth16"),
    curve: z.literal("bn128"),
    tree_depth: z.number().int().positive(),
    attributes: z.array(z.string()),
    public_signals: z.array(z.string()),
    constraints: z.number().int().positive(),
    toolchain: z.record(z.string(), z.string()),
    ceremony: z.string(),
    sha256: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .loose();

export type CircuitManifest = z.output<typeof CircuitManifestSchema>;

export function loadManifest(dir: string = ARTIFACTS_DIR): CircuitManifest {
  return CircuitManifestSchema.parse(JSON.parse(readFileSync(artifactPaths(dir).manifest, "utf8")));
}

export function loadVerificationKey(dir: string = ARTIFACTS_DIR): Record<string, unknown> {
  return JSON.parse(readFileSync(artifactPaths(dir).verificationKey, "utf8")) as Record<string, unknown>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Check the wasm, zkey and verification key against the manifest's SHA-256 hashes. */
export function verifyArtifacts(dir: string = ARTIFACTS_DIR): { ok: boolean; mismatches: string[] } {
  const manifest = loadManifest(dir);
  const paths = artifactPaths(dir);
  const files: Record<string, string> = {
    wasm: paths.wasm,
    zkey: paths.zkey,
    verification_key: paths.verificationKey,
  };
  const mismatches = Object.entries(files)
    .filter(([key, path]) => manifest.sha256[key] !== sha256File(path))
    .map(([key]) => key);
  return { ok: mismatches.length === 0, mismatches };
}
