#!/usr/bin/env bash
# Copy the contract ABIs exported by the `contracts` repository (scripts/export-abis.sh writes bare
# ABI arrays to abis/<Contract>.json) into src/abis/, and the deployment address files into
# src/abis/deployments/. The typed `as const` ABIs in src/abis/*.ts are checked against these files by
# test/abis.test.ts, so a contract change that breaks the TypeScript side fails CI after a sync.
#
# Usage: scripts/sync-abis.sh [path/to/contracts]   (default: ../../../contracts, i.e. the sibling repo)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
contracts="${1:-$here/../../../contracts}"

if [ ! -d "$contracts/abis" ]; then
  echo "error: $contracts/abis not found (run scripts/export-abis.sh in the contracts repo first)" >&2
  exit 1
fi

dest="$here/src/abis"
mkdir -p "$dest/deployments"
count=0
for file in "$contracts"/abis/*.json; do
  cp "$file" "$dest/$(basename "$file")"
  count=$((count + 1))
done
for file in "$contracts"/deployments/*.json; do
  [ -e "$file" ] || continue
  cp "$file" "$dest/deployments/$(basename "$file")"
done
# Keep the copies in the monorepo's formatting so `prettier --check` stays green after a sync.
(cd "$here" && npx --no-install prettier --log-level warn --write "src/abis/*.json" "src/abis/deployments/*.json")
echo "synced $count ABI file(s) from $contracts/abis into $dest"
