import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    // The private-proof tests make real Groth16 proofs (about 1.5 s each locally; CI runners are slower).
    testTimeout: process.env.CI ? 300_000 : 60_000,
    hookTimeout: process.env.CI ? 300_000 : 60_000,
  },
});
