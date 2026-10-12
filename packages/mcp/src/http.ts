import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Streamable HTTP transport for hosted agents, in stateless mode: every
 * `POST /mcp` gets a fresh MCP server instance (the Agent Bank client behind
 * it is shared).
 *
 * Because the server can move money, it is locked down by default:
 * - binds to `127.0.0.1`; binding to any other interface **requires** a
 *   bearer token (`AGENTBANK_MCP_HTTP_TOKEN`);
 * - DNS-rebinding protection: on loopback, only `Host` headers naming
 *   localhost/127.0.0.1/[::1] are accepted;
 * - browser requests from non-loopback origins are refused (`Origin` check);
 * - the bearer token, when set, is compared in constant time.
 *
 * @packageDocumentation
 */

/** Options of {@link startHttpServer}. */
export interface HttpServerOptions {
  /** Interface to bind (default `127.0.0.1`). */
  host?: string;
  /** Port (default 8090; 0 picks a free port). */
  port?: number;
  /** Endpoint path (default `/mcp`). */
  path?: string;
  /** Bearer token clients must send (`Authorization: Bearer …`). Required off loopback. */
  token?: string;
  /** Allowed `Host` header hostnames (default on loopback: localhost, 127.0.0.1, [::1]). */
  allowedHosts?: string[];
  /** Allowed browser origins (default: loopback origins only). */
  allowedOrigins?: string[];
}

/** A running HTTP server. */
export interface RunningHttpServer {
  /** Endpoint URL, e.g. `http://127.0.0.1:8090/mcp`. */
  url: string;
  server: Server;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function deny(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Serve MCP over streamable HTTP.
 *
 * @param createMcpServer Factory returning a fresh `McpServer` per request.
 * @throws if asked to bind beyond loopback without a token.
 */
export async function startHttpServer(
  createMcpServer: () => McpServer,
  options: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8090;
  const path = options.path ?? "/mcp";
  const loopback = isLoopback(host);
  if (!loopback && !options.token) {
    throw new Error(
      `Refusing to serve money tools on ${host} without a bearer token: set AGENTBANK_MCP_HTTP_TOKEN (or bind to 127.0.0.1)`,
    );
  }
  const allowedHosts = options.allowedHosts ?? (loopback ? ["localhost", "127.0.0.1", "[::1]"] : undefined);
  const allowedOrigins = options.allowedOrigins;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const hostname = hostnameOf(req.headers.host);
    if (allowedHosts && (!hostname || !allowedHosts.includes(hostname))) {
      deny(res, 403, "Invalid Host header");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        originHost = undefined;
      }
      const allowed = allowedOrigins
        ? allowedOrigins.includes(origin)
        : !!originHost && isLoopback(originHost);
      if (!allowed) {
        deny(res, 403, "Origin not allowed");
        return;
      }
    }
    if (options.token && !tokenMatches(req.headers.authorization, options.token)) {
      deny(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== path) {
      deny(res, 404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      deny(res, 405, "Method not allowed: this server is stateless, use POST", { allow: "POST" });
      return;
    }
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) deny(res, 500, "Internal error");
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${displayHost}:${address.port}${path}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
