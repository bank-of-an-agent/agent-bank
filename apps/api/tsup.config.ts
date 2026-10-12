import { cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Two entry points: `dist/index.js` (HTTP server) and `dist/worker.js` (background jobs).
 * Workspace packages (`@agentbank/*`) export TypeScript sources, so they are bundled; the
 * API's own dependencies stay external and are installed by `pnpm deploy --prod`; transitive
 * dependencies of workspace packages are bundled.
 * SQL migrations are copied next to the bundle (`dist/migrations`).
 */
export default defineConfig({
  entry: { index: "src/index.ts", worker: "src/worker.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: true,
  dts: false,
  // @noble/* is bundled too: workspace packages pin different majors (core uses
  // @noble/hashes 2.x, the chain's @noble/curves 1.x needs hashes 1.x), so each import must
  // resolve from its own package at build time.
  noExternal: [/^@agentbank\/(?!cosigner)/, /^@noble\//],
  // The in-process co-signer (COSIGNER_MODE=inprocess, local development with `pnpm dev`) is
  // never bundled: production images carry no co-signer code or key handling.
  external: ["@agentbank/cosigner"],
  onSuccess: async () => {
    cpSync(resolve(here, "../../packages/db/migrations"), resolve(here, "dist/migrations"), {
      recursive: true,
    });
  },
});
