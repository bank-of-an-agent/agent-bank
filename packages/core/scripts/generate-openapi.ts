/**
 * Writes the OpenAPI 3.1 documents generated from the route registry.
 *   pnpm --filter @agentbank/core openapi           # write
 *   pnpm --filter @agentbank/core openapi --check   # fail if out of date (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/api/openapi";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = resolve(root, "docs/openapi.json");
const doc = `${JSON.stringify(buildOpenApiDocument({ serverUrls: ["http://localhost:8080"] }), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // missing file is a mismatch
  }
  if (current !== doc) {
    console.error("docs/openapi.json is out of date. Run: pnpm openapi");
    process.exit(1);
  }
  console.log("docs/openapi.json is up to date");
} else {
  writeFileSync(target, doc);
  console.log(`wrote ${target}`);
}
