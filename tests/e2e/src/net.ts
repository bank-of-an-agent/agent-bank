import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Small networking helpers: free ports, `node:http` servers that close cleanly, and a `fetch`
 * that resolves test host names (`api.seller.test`) to local servers, so x402 policies can
 * allowlist real-looking domains while everything runs on 127.0.0.1.
 */

export const LOOPBACK = "127.0.0.1";

/** A port that was free a moment ago (the OS picks it). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface HttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start a `node:http` server on `port` (0: any free port) and return its URL. */
export async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  port = 0,
  host = LOOPBACK,
): Promise<HttpServer> {
  const server: Server = createServer(handler);
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${actual}`,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Read a request body as text. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` that sends requests for hosts `resolve` knows to a local `host:port` instead (like
 * an `/etc/hosts` entry). The response is re-wrapped so its `url` stays the caller's: the x402
 * client pays (and the API's policy judges) the host the agent asked for.
 */
export function resolvingFetch(resolve: (hostname: string) => string | undefined): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = resolve(url.hostname.toLowerCase());
    if (!target) return fetch(request);
    url.protocol = "http:";
    url.host = target;
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      ...(body !== undefined && body.byteLength > 0 ? { body } : {}),
      redirect: "manual",
      signal: request.signal,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
