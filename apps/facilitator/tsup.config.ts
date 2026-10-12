import { cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One deployable bundle, `dist/index.js` (the Dockerfile runs it). Workspace packages
 * (`@agentbank/*`) ship TypeScript sources, so they are bundled in; third-party dependencies
 * stay external and are installed by `pnpm deploy --prod`. SQL migrations are copied next to
 * the bundle (`dist/migrations`) for `MIGRATE_ON_START`.
 */
export default defineConfig({
  entry: { index: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@agentbank\//],
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  onSuccess: async () => {
    cpSync(resolve(here, "../../packages/db/migrations"), resolve(here, "dist/migrations"), {
      recursive: true,
    });
  },
});
