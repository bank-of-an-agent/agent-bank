#!/usr/bin/env bash
# Copies the claims circuit artifacts (agent_claims.wasm, agent_claims.zkey,
# verification_key.json, manifest.json) from the contracts repository into
# packages/proofs/artifacts, after checking every file against the SHA-256 hashes in the
# manifest. Nothing is copied unless all hashes match.
#
#   pnpm --filter @agentbank/proofs sync-circuits
#   CIRCUITS_ARTIFACTS=/path/to/contracts/circuits/artifacts pnpm --filter @agentbank/proofs sync-circuits
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="${CIRCUITS_ARTIFACTS:-$package_dir/../../../contracts/circuits/artifacts}"
target_dir="$package_dir/artifacts"

if [[ ! -f "$source_dir/manifest.json" ]]; then
  echo "sync-circuits: no manifest.json in $source_dir (set CIRCUITS_ARTIFACTS)" >&2
  exit 1
fi
source_dir="$(cd "$source_dir" && pwd)"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

for file in agent_claims.wasm agent_claims.zkey verification_key.json manifest.json; do
  if [[ ! -f "$source_dir/$file" ]]; then
    echo "sync-circuits: missing $source_dir/$file" >&2
    exit 1
  fi
  cp "$source_dir/$file" "$staging/$file"
done

node --input-type=module - "$staging" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const files = { wasm: "agent_claims.wasm", zkey: "agent_claims.zkey", verification_key: "verification_key.json" };
let failed = false;
if (manifest.schema !== "agentbank.claims.v1") {
  console.error(`sync-circuits: unexpected schema ${manifest.schema}`);
  failed = true;
}
for (const [key, file] of Object.entries(files)) {
  const expected = manifest.sha256?.[key];
  const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
  if (expected !== actual) {
    console.error(`sync-circuits: ${file} sha256 ${actual} does not match the manifest (${expected})`);
    failed = true;
  } else {
    console.error(`sync-circuits: ${file} ${actual} ok`);
  }
}
const vkey = JSON.parse(readFileSync(join(dir, "verification_key.json"), "utf8"));
if (vkey.nPublic !== manifest.public_signals?.length) {
  console.error(`sync-circuits: verification key has ${vkey.nPublic} public signals, manifest lists ${manifest.public_signals?.length}`);
  failed = true;
}
process.exit(failed ? 1 : 0);
NODE

mkdir -p "$target_dir"
for file in agent_claims.wasm agent_claims.zkey verification_key.json manifest.json; do
  cp "$staging/$file" "$target_dir/$file"
done
echo "sync-circuits: copied artifacts from $source_dir to $target_dir" >&2
