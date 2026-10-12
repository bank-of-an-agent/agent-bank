import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
