import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Write a gate-evidence file and run the repository's Prettier over it, so the committed
 * Markdown matches `format:check` (Prettier aligns Markdown tables). Formatting is best-effort:
 * the file is always written even if Prettier is unavailable. Called only by the `gate:*`
 * scripts, never by CI's `test`.
 */
export function writeEvidenceFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  // Evidence lives at <repo>/docs/gates/evidence/…; the repo root is the prefix before /docs/.
  const docsAt = path.indexOf("/docs/");
  const repoRoot = docsAt > 0 ? path.slice(0, docsAt) : resolve(dirname(path), "../../..");
  const bin = resolve(repoRoot, "node_modules/.bin/prettier");
  try {
    if (existsSync(bin)) execFileSync(bin, ["--write", path], { stdio: "ignore" });
  } catch {
    // Prettier unavailable or failed: the unformatted file still stands as evidence.
  }
}
