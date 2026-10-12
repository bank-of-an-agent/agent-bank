import { defineConfig } from "vitest/config";

const fork = process.env.RUN_FORK_TESTS === "1";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    // Live (RUN_LIVE_TESTS=1) and fork (RUN_FORK_TESTS=1) suites talk to real nodes.
    testTimeout: 30_000,
    hookTimeout: 900_000,
    // Fork suites share one Anvil and move its clock: run files one at a time.
    fileParallelism: !fork,
    globalSetup: ["test/fork/globalSetup.ts"],
    coverage: { provider: "v8", include: ["src/**"], reporter: ["text-summary", "lcov"] },
  },
});
