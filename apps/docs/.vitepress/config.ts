import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme, type Plugin } from "vitepress";
import spec from "../../../docs/openapi.json";
import { generateApiReference, prettierFormatter } from "./openapi/generate";
import type { OpenApiDocument } from "./openapi/types";

/**
 * Agent Bank documentation site.
 *
 * - Builds fully offline: fonts are self-hosted (`@fontsource-variable/*`),
 *   search is VitePress local search, code highlighting happens at build time.
 * - The API reference (`/api/*`) is generated on every dev start and build
 *   from `docs/openapi.json`, which is itself generated from the route
 *   registry (ADR 0003). Importing the document makes VitePress restart the
 *   dev server when it changes.
 * - Dead links fail the build (VitePress default; keep it that way).
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");
const specPath = resolve(srcDir, "../../docs/openapi.json");
const REPO = "https://github.com/bank-of-an-agent/agent-bank";

/** Deploy base path, e.g. `/agent-bank/` for a GitHub Pages project site. */
const base = process.env.DOCS_BASE ?? "/";

const apiSidebar = await generateApiReference(spec as unknown as OpenApiDocument, {
  srcDir,
  dir: "api",
  format: await prettierFormatter(),
});

const mainSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "Get started",
    items: [
      { text: "Concepts in 5 minutes", link: "/get-started/" },
      { text: "Local sandbox", link: "/get-started/sandbox" },
      { text: "Principal setup", link: "/get-started/principal-setup" },
      { text: "Your first payment", link: "/get-started/first-payment" },
      { text: "Your first x402 call", link: "/get-started/first-x402-call" },
    ],
  },
  {
    text: "Concepts",
    items: [
      { text: "Accounts and keys", link: "/concepts/accounts-and-keys" },
      { text: "Policies", link: "/concepts/policies" },
      { text: "Mandates", link: "/concepts/mandates" },
      { text: "Approvals", link: "/concepts/approvals" },
      { text: "Owner operations", link: "/concepts/owner-operations" },
      { text: "The ledger", link: "/concepts/ledger" },
      { text: "Reconciliation", link: "/concepts/reconciliation" },
      { text: "Escrow and streams", link: "/concepts/escrow-and-streams" },
      { text: "Savings and treasury", link: "/concepts/savings" },
      { text: "Fees and plans", link: "/concepts/fees-and-plans" },
      { text: "Exit tool", link: "/concepts/exit-tool" },
      { text: "Security model", link: "/concepts/security-model" },
      { text: "Regulatory posture", link: "/concepts/regulatory-posture" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "TypeScript SDK", link: "/guides/typescript-sdk" },
      { text: "Python SDK", link: "/guides/python-sdk" },
      { text: "MCP server", link: "/guides/mcp-server" },
      { text: "x402: pay for APIs", link: "/guides/x402-buyer" },
      { text: "x402: charge for APIs", link: "/guides/x402-seller" },
      { text: "Webhooks", link: "/guides/webhooks" },
      { text: "Idempotency and errors", link: "/guides/idempotency-and-errors" },
      { text: "Request signing", link: "/guides/request-signing" },
    ],
  },
  {
    text: "Framework quickstarts",
    items: [
      { text: "Overview", link: "/quickstarts/" },
      { text: "Claude Agent SDK", link: "/quickstarts/claude-agent-sdk" },
      { text: "OpenAI Agents SDK", link: "/quickstarts/openai-agents-sdk" },
      { text: "Vercel AI SDK", link: "/quickstarts/vercel-ai-sdk" },
      { text: "LangChain.js and LangGraph", link: "/quickstarts/langchain" },
      { text: "Any MCP client", link: "/quickstarts/mcp-client" },
    ],
  },
  {
    text: "Operations",
    items: [
      { text: "Overview", link: "/operations/" },
      { text: "Incident runbooks", link: "/operations/runbooks" },
      { text: "Phase gates", link: "/operations/gates" },
      { text: "Architecture decisions", link: "/operations/adrs" },
    ],
  },
];

const referenceSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "API reference",
    items: [
      { text: "Overview", link: "/api/" },
      { text: "Schemas", link: "/api/schemas" },
    ],
  },
  ...apiSidebar.map((group) => ({ text: group.text, items: group.items, collapsed: false })),
];

/** Serves `docs/openapi.json` at `/openapi.json` in dev; `buildEnd` copies it for production. */
function openApiAsset(): Plugin {
  return {
    name: "agentbank:openapi-json",
    configureServer(server) {
      server.middlewares.use(`${base}openapi.json`, (_req, res) => {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(readFileSync(specPath));
      });
    },
  };
}

export default defineConfig({
  lang: "en-US",
  title: "Agent Bank",
  titleTemplate: ":title · Agent Bank docs",
  description:
    "Non-custodial, programmable bank accounts for AI agents: USDC on Base, limits enforced by code, x402, escrow and streams. Pre-release, testnet only.",
  base,
  srcExclude: ["api/_*.md", "README.md"],
  cleanUrls: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}mark.svg` }],
    ["meta", { name: "theme-color", content: "#070B16" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Agent Bank documentation" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Bank accounts for AI agents, with limits that live in code. Agent Bank can refuse a payment, never make one.",
      },
    ],
  ],
  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
  },
  themeConfig: {
    logo: { src: "/mark.svg", alt: "" },
    siteTitle: "Agent Bank",
    nav: [
      { text: "Get started", link: "/get-started/", activeMatch: "^/get-started/" },
      { text: "Concepts", link: "/concepts/accounts-and-keys", activeMatch: "^/concepts/" },
      { text: "Guides", link: "/guides/typescript-sdk", activeMatch: "^/guides/" },
      { text: "Quickstarts", link: "/quickstarts/", activeMatch: "^/quickstarts/" },
      { text: "API", link: "/api/", activeMatch: "^/api/" },
      { text: "Operations", link: "/operations/", activeMatch: "^/operations/" },
    ],
    sidebar: {
      "/api/": referenceSidebar,
      "/": mainSidebar,
    },
    outline: { level: [2, 3], label: "On this page" },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/bank-of-an-agent" }],
    editLink: {
      pattern: `${REPO}/edit/main/apps/docs/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message:
        "Pre-release software, Base Sepolia testnet only. Agent Bank is not a bank or a money transmitter, and nothing here is legal advice.",
      copyright: "Apache-2.0 · Bank of an Agent",
    },
    externalLinkIcon: true,
  },
  vite: {
    plugins: [openApiAsset()],
  },
  buildEnd(siteConfig) {
    copyFileSync(specPath, join(siteConfig.outDir, "openapi.json"));
  },
});
