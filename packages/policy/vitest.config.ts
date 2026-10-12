import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    // Red-team simulations and property runs are CPU-bound; CI runners are much slower.
    testTimeout: process.env.CI ? 300_000 : 5_000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "text", "lcov"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
