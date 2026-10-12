import { defineConfig } from "tsup";

/**
 * Publishable build: the `agentbank-mcp` CLI and the library entry, ESM only
 * (Node ≥ 20). `@agentbank/sdk` and `@agentbank/core` are workspace packages
 * and are bundled; `@modelcontextprotocol/sdk`, `viem` and `zod` stay
 * external runtime dependencies.
 */
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  dts: {
    entry: { index: "src/index.ts" },
    compilerOptions: {
      // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
      ignoreDeprecations: "6.0",
      // Inline the bundled workspace packages' types instead of referencing them.
      paths: {
        "@agentbank/sdk": ["../sdk-ts/src/index.ts"],
        "@agentbank/sdk/node": ["../sdk-ts/src/node.ts"],
        "@agentbank/core": ["../core/src/index.ts"],
        "@agentbank/core/api": ["../core/src/api/index.ts"],
      },
    },
  },
  noExternal: ["@agentbank/sdk", "@agentbank/core", "@noble/hashes"],
  external: ["@modelcontextprotocol/sdk", "viem", "zod"],
  platform: "node",
  target: "node20",
  splitting: true,
  sourcemap: true,
  clean: true,
});
