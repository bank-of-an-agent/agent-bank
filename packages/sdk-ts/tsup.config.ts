import { defineConfig, type Options } from "tsup";

type EsbuildPlugin = NonNullable<Options["esbuildPlugins"]>[number];

/**
 * `@agentbank/proofs` modules have no side effects. Telling esbuild so lets it drop the ones a
 * bundle does not use: the main entry takes header and request helpers from the proofs
 * package without pulling in its verifier (and with it snarkjs), which only the lazily loaded
 * prover and `proof-server` need.
 */
const proofsWithoutSideEffects: EsbuildPlugin = {
  name: "agentbank-proofs-side-effect-free",
  setup(build) {
    const skip = Symbol("skip");
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === skip) return undefined;
      const inProofs =
        /[\\/]packages[\\/]proofs[\\/]src[\\/]/.test(args.importer) && args.path.startsWith(".");
      if (!inProofs && !/^@agentbank\/proofs(\/|$)/.test(args.path)) return undefined;
      const resolved = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: skip,
      });
      if (resolved.errors.length > 0 || resolved.external) return resolved;
      return { path: resolved.path, namespace: resolved.namespace, sideEffects: false };
    });
  },
};

/**
 * Publishable build: ESM + CJS + declarations for the five entry points.
 * `@agentbank/core` and `@agentbank/proofs` are private, so they are bundled into the output
 * (code and types); `viem`, `zod`, `snarkjs` and `poseidon-lite` stay external runtime
 * dependencies. Proving (Node only) is the `prover` entry, which `AgentClient` imports at run time
 * from next to its own chunk; its circuit files (about 11 MB) are copied to `dist/circuits/`,
 * checked against the circuit manifest.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    "x402-server": "src/x402-server.ts",
    "proof-server": "src/proof-server.ts",
    // Node only. The main entry loads it from a run-time location bundlers do not follow.
    prover: "src/prover.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
      ignoreDeprecations: "6.0",
      // Inline the private core and proofs packages' types instead of referencing them.
      paths: {
        "@agentbank/core": ["../core/src/index.ts"],
        "@agentbank/core/api": ["../core/src/api/index.ts"],
        "@agentbank/proofs": ["../proofs/src/index.ts"],
        "@agentbank/proofs/*": ["../proofs/src/*.ts"],
      },
    },
  },
  noExternal: ["@agentbank/core", "@agentbank/proofs", "@noble/hashes"],
  external: ["viem", "zod", "snarkjs", "poseidon-lite", /^node:/],
  esbuildPlugins: [proofsWithoutSideEffects],
  // `import.meta.url` (circuit file lookup) in the CommonJS build.
  shims: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  onSuccess: "tsx scripts/copy-circuits.ts",
});
