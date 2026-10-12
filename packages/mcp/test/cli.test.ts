import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyRequest } from "@agentbank/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src";
import { balances } from "./fixtures";

/**
 * End to end: the `agentbank-mcp` CLI (from source, over stdio) talks to a
 * fake API that authenticates the agent with core's RFC 9421 `verifyRequest`.
 */

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const sessionKey = generatePrivateKey();
const sessionAddress = privateKeyToAccount(sessionKey).address;

let api: Server;
let apiUrl: string;
const verified: string[] = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    void verifyRequest(
      { method: req.method ?? "GET", url: `http://${headers.host}${req.url}`, headers, body: null },
      { resolveKey: async (id) => (id === SES ? sessionAddress : undefined) },
    )
      .then((sig) => {
        verified.push(`${req.method} ${req.url} ${sig.keyId}`);
        if (req.url === `/v1/accounts/${ACCT}/balances`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(balances()));
        } else {
          res.writeHead(404, { "content-type": "application/problem+json" });
          res.end(
            JSON.stringify({
              type: "urn:agentbank:problem:not_found",
              title: "Not found",
              status: 404,
              code: "not_found",
            }),
          );
        }
      })
      .catch((error: Error) => {
        res.writeHead(401, { "content-type": "application/problem+json" });
        res.end(
          JSON.stringify({
            type: "x",
            title: "x",
            status: 401,
            code: "signature_invalid",
            detail: error.message,
          }),
        );
      });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
});

describe("agentbank-mcp over stdio", () => {
  it("starts from env, lists the tools and makes signed API calls without logging keys", async () => {
    const require = createRequire(import.meta.url);
    const tsxCli = require.resolve("tsx/cli");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
      env: {
        PATH: process.env.PATH ?? "",
        AGENTBANK_API_URL: apiUrl,
        AGENTBANK_ACCOUNT_ID: ACCT,
        AGENTBANK_SESSION_ID: SES,
        AGENTBANK_SESSION_KEY: sessionKey,
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: "cli-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      const result = await client.callTool({ name: "get_balance", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ account_id: ACCT, available: "120.50" });
      expect(verified).toContain(`GET /v1/accounts/${ACCT}/balances ${SES}`);
      const paid = await client.callTool({
        name: "fetch_paid_resource",
        arguments: { url: `${apiUrl}/free` },
      });
      expect(paid.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    expect(stderr).toContain("ready on stdio");
    expect(stderr).toContain("x402 disabled");
    expect(stderr).not.toContain(sessionKey.slice(2));
  }, 30_000);
});
