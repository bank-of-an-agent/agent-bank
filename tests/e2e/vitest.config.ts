import { defineConfig } from "vitest/config";

/**
 * Each test boots the whole stack (API, co-signer, reconciler, indexer, facilitator) on its own
 * ports, so they run with a small worker pool and generous timeouts. The red-team and exit-drill
 * gate suites run at a reduced size by default (the full counts come from the `gate:*` scripts);
 * the long-running `sandbox` is a script, not a test.
 */
export default defineConfig({
  test: {
    maxWorkers: 2,
    fileParallelism: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
