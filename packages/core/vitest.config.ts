import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**"], reporter: ["text-summary", "lcov"] },
  },
});
