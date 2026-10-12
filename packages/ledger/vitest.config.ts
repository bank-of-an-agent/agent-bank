import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    testTimeout: process.env.CI ? 300_000 : 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "text", "lcov"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
