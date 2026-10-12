import type { IncomingMessage, ServerResponse } from "node:http";
import type { Paywall, PaywallDecision, PaywallResponse } from "./paywall";

/**
 * Framework adapters for {@link Paywall}. They only use structural types, so
 * the SDK has no runtime dependency on Express, Fastify or Hono. The response
 * helpers are shared with the proof-gate adapters (`../proofs/gate-adapters`).
 *
 * @packageDocumentation
 */

type Verified = Extract<PaywallDecision, { kind: "verified" }>;

export function toWebResponse(response: PaywallResponse): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

// ---------------------------------------------------------------- Web Request/Response

/**
 * Protect a Web-standard handler `(request) => Response` (Next.js route
 * handlers, Bun, Deno, Cloudflare Workers, itty-router, …).
 *
 * @example Next.js (app router)
 * ```ts
 * export const GET = withPaywall(paywall, async () => Response.json({ temp: 21 }));
 * ```
 */
export function withPaywall<Args extends unknown[]>(
  paywall: Paywall,
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    const decision = await paywall.process({
      url: request.url,
      method: request.method,
      headers: request.headers,
    });
    if (decision.kind === "payment-required") return toWebResponse(decision.response);
    if (decision.settleBeforeServe) {
      const outcome = await decision.settle();
      if (!outcome.success) return toWebResponse(outcome.response);
      return withHeaders(await handler(request, ...args), outcome.headers);
    }
    const response = await handler(request, ...args);
    if (response.status >= 400) return response;
    const outcome = await decision.settle();
    if (!outcome.success) {
      await response.body?.cancel().catch(() => undefined);
      return toWebResponse(outcome.response);
    }
    return withHeaders(response, outcome.headers);
  };
}

/** The parts of a Hono `Context` the middleware uses. */
export interface HonoContextLike {
  req: { raw: Request };
  res: Response;
}

/**
 * Hono middleware.
 *
 * @example
 * ```ts
 * app.get("/weather", honoPaywall(paywall), (c) => c.json({ temp: 21 }));
 * ```
 */
export function honoPaywall(
  paywall: Paywall,
): (c: HonoContextLike, next: () => Promise<void>) => Promise<Response | void> {
  return async (c, next) => {
    const request = c.req.raw;
    const decision = await paywall.process({
      url: request.url,
      method: request.method,
      headers: request.headers,
    });
    if (decision.kind === "payment-required") return toWebResponse(decision.response);
    if (decision.settleBeforeServe) {
      const outcome = await decision.settle();
      if (!outcome.success) return toWebResponse(outcome.response);
      await next();
      c.res = withHeaders(c.res, outcome.headers);
      return;
    }
    await next();
    if (c.res.status >= 400) return;
    const outcome = await decision.settle();
    if (!outcome.success) {
      await c.res.body?.cancel().catch(() => undefined);
      // Reset first so Hono does not merge the handler's headers into the 402.
      (c as { res: Response | undefined }).res = undefined;
      c.res = toWebResponse(outcome.response);
      return;
    }
    c.res = withHeaders(c.res, outcome.headers);
  };
}

// ---------------------------------------------------------------- Node http / Express

function nodeRequestUrl(req: IncomingMessage): string {
  const r = req as IncomingMessage & { originalUrl?: string; protocol?: string };
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const protocol = typeof r.protocol === "string" && r.protocol ? r.protocol : encrypted ? "https" : "http";
  const host = req.headers.host ?? "localhost";
  return `${protocol}://${host}${r.originalUrl ?? req.url ?? "/"}`;
}

export function sendNode(res: ServerResponse, response: PaywallResponse): void {
  res.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  res.setHeader("Content-Length", new TextEncoder().encode(response.body).byteLength);
  res.end(response.body);
}

/**
 * Hold the response in memory until `beforeFlush` decides: `undefined`
 * flushes it unchanged (with any headers set meanwhile), a
 * {@link PaywallResponse} replaces it.
 */
function holdResponse(
  res: ServerResponse,
  beforeFlush: (statusCode: number) => Promise<PaywallResponse | undefined>,
): void {
  const original = {
    writeHead: res.writeHead,
    write: res.write,
    end: res.end,
    flushHeaders: res.flushHeaders,
  };
  const chunks: { chunk: unknown; encoding: BufferEncoding | undefined }[] = [];
  let head: unknown[] | undefined;
  let ended = false;

  res.writeHead = function (...args: unknown[]) {
    head = args;
    if (typeof args[0] === "number") res.statusCode = args[0];
    return res;
  } as typeof res.writeHead;
  res.flushHeaders = () => undefined;
  res.write = function (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) {
    chunks.push({
      chunk,
      encoding: typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : undefined,
    });
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof cb === "function") queueMicrotask(() => (cb as () => void)());
    return true;
  } as typeof res.write;
  res.end = function (chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) {
    if (ended) return res;
    ended = true;
    let cb: unknown = callback;
    let body = chunk;
    if (typeof chunk === "function") {
      cb = chunk;
      body = undefined;
    } else if (typeof encodingOrCallback === "function") {
      cb = encodingOrCallback;
    }
    if (body !== undefined && body !== null) {
      chunks.push({
        chunk: body,
        encoding: typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : undefined,
      });
    }
    void (async () => {
      let replacement: PaywallResponse | undefined;
      try {
        replacement = await beforeFlush(res.statusCode);
      } catch {
        replacement = {
          status: 502,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({ error: "settlement_error", detail: "Payment settlement failed" }),
        };
      }
      res.writeHead = original.writeHead;
      res.write = original.write;
      res.end = original.end;
      res.flushHeaders = original.flushHeaders;
      if (replacement) {
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        sendNode(res, replacement);
      } else {
        if (head) (original.writeHead as (...a: unknown[]) => void).apply(res, head);
        for (const { chunk: c, encoding } of chunks) {
          (original.write as (c: unknown, e?: BufferEncoding) => boolean).call(res, c, encoding);
        }
        (original.end as () => void).call(res);
      }
      if (typeof cb === "function") (cb as () => void)();
    })();
    return res;
  } as typeof res.end;
}

async function handleNode(
  paywall: Paywall,
  req: IncomingMessage,
  res: ServerResponse,
  run: () => unknown,
): Promise<void> {
  const decision = await paywall.process({
    url: nodeRequestUrl(req),
    method: req.method ?? "GET",
    headers: req.headers,
  });
  if (decision.kind === "payment-required") {
    sendNode(res, decision.response);
    return;
  }
  if (decision.settleBeforeServe) {
    const outcome = await decision.settle();
    if (!outcome.success) {
      sendNode(res, outcome.response);
      return;
    }
    for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
    await run();
    return;
  }
  holdResponse(res, async (statusCode) => {
    if (statusCode >= 400) return undefined;
    const outcome = await decision.settle();
    if (!outcome.success) return outcome.response;
    for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
    return undefined;
  });
  await run();
}

/**
 * Express / Connect middleware. For payments settled after the handler, the
 * handler's response is buffered until settlement succeeds.
 *
 * @example
 * ```ts
 * app.get("/weather", expressPaywall(paywall), (req, res) => res.json({ temp: 21 }));
 * ```
 */
export function expressPaywall(
  paywall: Paywall,
): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void {
  return (req, res, next) => {
    handleNode(paywall, req, res, () => next()).catch((error: unknown) => next(error));
  };
}

/**
 * Protect a plain Node `http` request listener.
 *
 * @example
 * ```ts
 * http.createServer(nodePaywall(paywall, (req, res) => res.end("paid content"))).listen(4021);
 * ```
 */
export function nodePaywall(
  paywall: Paywall,
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleNode(paywall, req, res, () => handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else {
        res.destroy();
      }
    });
  };
}

// ---------------------------------------------------------------- Fastify

/** The parts of a Fastify request the hooks use. */
export interface FastifyRequestLike {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  host?: string;
}

/** The parts of a Fastify reply the hooks use. */
export interface FastifyReplyLike {
  statusCode: number;
  code(statusCode: number): unknown;
  header(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
  getHeaders(): Record<string, unknown>;
  send(payload?: unknown): unknown;
}

function fastifyUrl(request: FastifyRequestLike): string {
  const host =
    request.host ?? (typeof request.headers.host === "string" ? request.headers.host : "localhost");
  return `${request.protocol ?? "http"}://${host}${request.url}`;
}

export function sendFastify(reply: FastifyReplyLike, response: PaywallResponse): unknown {
  reply.code(response.status);
  for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
  return reply.send(response.body);
}

/**
 * Fastify route hooks. Spread them into the route options.
 *
 * @example
 * ```ts
 * app.get("/weather", { ...fastifyPaywall(paywall) }, async () => ({ temp: 21 }));
 * ```
 */
export function fastifyPaywall(paywall: Paywall): {
  preHandler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>;
  onSend: (request: FastifyRequestLike, reply: FastifyReplyLike, payload: unknown) => Promise<unknown>;
} {
  const pending = new WeakMap<object, Verified>();
  return {
    async preHandler(request, reply) {
      const decision = await paywall.process({
        url: fastifyUrl(request),
        method: request.method,
        headers: request.headers,
      });
      if (decision.kind === "payment-required") return sendFastify(reply, decision.response);
      if (decision.settleBeforeServe) {
        const outcome = await decision.settle();
        if (!outcome.success) return sendFastify(reply, outcome.response);
        for (const [name, value] of Object.entries(outcome.headers)) reply.header(name, value);
        return undefined;
      }
      pending.set(request, decision);
      return undefined;
    },
    async onSend(request, reply, payload) {
      const decision = pending.get(request);
      if (!decision) return payload;
      pending.delete(request);
      if (reply.statusCode >= 400) return payload;
      const outcome = await decision.settle();
      if (!outcome.success) {
        for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
        reply.code(outcome.response.status);
        for (const [name, value] of Object.entries(outcome.response.headers)) reply.header(name, value);
        return outcome.response.body;
      }
      for (const [name, value] of Object.entries(outcome.headers)) reply.header(name, value);
      return payload;
    },
  };
}
