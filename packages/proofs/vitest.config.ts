import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    // Real Groth16 proofs take about 1.5 s each locally; CI runners are much slower.
    testTimeout: process.env.CI ? 300_000 : 60_000,
    hookTimeout: process.env.CI ? 300_000 : 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/snarkjs.d.ts"],
      reporter: ["text-summary", "text", "lcov"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
