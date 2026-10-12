import { defineConfig } from "tsup";

/**
 * Publishable build: ESM + CJS + declarations for the three entry points.
 * `@agentbank/core` is private, so it is bundled into the output (code and
 * types); `viem` and `zod` stay external runtime dependencies.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    "x402-server": "src/x402-server.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
      ignoreDeprecations: "6.0",
      // Inline the private core package's types instead of referencing it.
      paths: {
        "@agentbank/core": ["../core/src/index.ts"],
        "@agentbank/core/api": ["../core/src/api/index.ts"],
      },
    },
  },
  noExternal: ["@agentbank/core", "@noble/hashes"],
  external: ["viem", "zod", /^node:/],
  splitting: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
});
