import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/** The monorepo root: workspace packages (e.g. `@agentbank/core`) live outside this app. */
const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Static security headers for every response. The Content-Security-Policy for
 * pages carries a per-request nonce and is set in `src/proxy.ts`.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // The root Dockerfile builds this app with APP=console.
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@agentbank/core", "@agentbank/policy", "@agentbank/sdk"],
  poweredByHeader: false,
  // Do not write AGENTS.md files into the app during `next dev`.
  agentRules: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // JSON and CSV from the BFF: never rendered as a document, never cached.
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
