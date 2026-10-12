import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      // `server-only` throws outside a React Server environment; Next enforces it at build time.
      "server-only": path.join(root, "test/support/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    // Memory on build machines is limited; the suite is small.
    maxWorkers: 2,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
