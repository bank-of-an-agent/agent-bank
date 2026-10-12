import { defineConfig } from "tsup";

/**
 * One deployable bundle, `dist/index.js` (the Dockerfile runs it). Workspace
 * packages ship TypeScript sources, so they are bundled in; third-party
 * dependencies stay external and are installed by `pnpm deploy --prod`.
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
});
