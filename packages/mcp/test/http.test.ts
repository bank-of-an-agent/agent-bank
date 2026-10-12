import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentBankMcpServer, startHttpServer, TOOL_NAMES, type RunningHttpServer } from "../src";
import { mockBackend } from "./fixtures";

const running: RunningHttpServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

async function start(options: Parameters<typeof startHttpServer>[1] = {}) {
  const backend = mockBackend();
  const server = await startHttpServer(() => createAgentBankMcpServer(backend), { port: 0, ...options });
  running.push(server);
  return { backend, server };
}

/** Raw POST with full control over Host/Origin headers. */
function rawPost(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  });
}

describe("streamable HTTP transport", () => {
  it("serves the tools to an MCP client on 127.0.0.1", async () => {
    const { server, backend } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const result = await client.callTool({ name: "get_balance", arguments: {} });
    expect(result.structuredContent).toMatchObject({ available: "120.50" });
    expect(backend.balance).toHaveBeenCalledOnce();
    await client.close();
  });

  it("blocks DNS rebinding (foreign Host) and cross-site browser origins", async () => {
    const { server } = await start();
    expect((await rawPost(server.url, { host: "evil.example.com" })).status).toBe(403);
    expect((await rawPost(server.url, { origin: "https://evil.example.com" })).status).toBe(403);
    const ok = await rawPost(server.url, { origin: "http://localhost:3000" });
    expect(ok.status).toBe(200);
  });

  it("requires the bearer token when configured", async () => {
    const { server } = await start({ token: "s3cret-token-0123456789" });
    expect((await rawPost(server.url, {})).status).toBe(401);
    expect((await rawPost(server.url, { authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: "Bearer s3cret-token-0123456789" } },
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(TOOL_NAMES.length);
    await client.close();
  });

  it("refuses to bind beyond loopback without a token and rejects non-POST methods", async () => {
    await expect(
      startHttpServer(() => createAgentBankMcpServer(mockBackend()), { host: "0.0.0.0", port: 0 }),
    ).rejects.toThrow(/AGENTBANK_MCP_HTTP_TOKEN/);
    const { server } = await start();
    const res = await fetch(server.url, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await fetch(server.url.replace("/mcp", "/other"), { method: "POST" })).status).toBe(404);
  });
});
