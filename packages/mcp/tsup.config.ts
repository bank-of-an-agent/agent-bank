import { defineConfig } from "tsup";

/**
 * Publishable build: the `agentbank-mcp` CLI and the library entry, ESM only
 * (Node ≥ 20). `@agentbank/sdk`, `@agentbank/core` and `@agentbank/proofs` are
 * workspace packages and are bundled; `@modelcontextprotocol/sdk`, `viem`,
 * `zod`, `snarkjs` and `poseidon-lite` stay external runtime dependencies. The
 * circuit files the bundled prover needs are copied to `dist/circuits/`.
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
        "@agentbank/proofs": ["../proofs/src/index.ts"],
        "@agentbank/proofs/*": ["../proofs/src/*.ts"],
      },
    },
  },
  noExternal: ["@agentbank/sdk", "@agentbank/core", "@agentbank/proofs", "@noble/hashes"],
  external: ["@modelcontextprotocol/sdk", "viem", "zod", "snarkjs", "poseidon-lite"],
  platform: "node",
  target: "node20",
  splitting: true,
  sourcemap: true,
  clean: true,
  onSuccess: "tsx ../sdk-ts/scripts/copy-circuits.ts dist/circuits",
});
