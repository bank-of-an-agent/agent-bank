import { createPaywall, type Paywall } from "@agentbank/sdk/x402-server";
import { withPaywall } from "@agentbank/sdk/x402-server";
import { readBody, serve, type FetchLike, type HttpServer } from "./net";

/**
 * A demo x402 seller: two paid routes behind the SDK's `createPaywall`, served over real HTTP
 * and settled through the stack's facilitator. `/weather` costs $0.01 (settled after serving)
 * and `/report` costs $2.00 (settled before serving, above the $1 threshold). Both pay to the
 * seller's Agent Bank account, so the 0.5% receive fee accrues to it.
 */

export interface DemoSellerOptions {
  facilitatorUrl: string;
  /** The seller's Agent Bank account address (x402 `payTo`). */
  payTo: string;
  /** CAIP-2 network (default eip155:1337, the simulated chain). */
  network?: string;
  /** `fetch` the paywall uses to reach the facilitator (resolves test hosts to local servers). */
  fetch?: FetchLike;
  /** Fixed port (default: a free port). */
  port?: number;
  /** Prices as decimal USDC (defaults: weather 0.01, report 2.00). */
  weatherPrice?: string;
  reportPrice?: string;
}

export interface DemoSeller {
  url: string;
  port: number;
  weatherPaywall: Paywall;
  reportPaywall: Paywall;
  close(): Promise<void>;
}

/** Start the demo seller. The handlers return JSON once the paywall is satisfied. */
export async function startDemoSeller(options: DemoSellerOptions): Promise<DemoSeller> {
  const network = options.network ?? "eip155:1337";
  const common = {
    facilitatorUrl: options.facilitatorUrl,
    payTo: options.payTo,
    network,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const weatherPaywall = createPaywall({
    ...common,
    price: options.weatherPrice ?? "0.01",
    description: "Current weather",
    mimeType: "application/json",
  });
  const reportPaywall = createPaywall({
    ...common,
    price: options.reportPrice ?? "2.00",
    description: "Full research report",
    mimeType: "application/json",
  });

  const weather = withPaywall(weatherPaywall, async () =>
    Response.json({ city: "San Francisco", tempC: 18, conditions: "fog" }),
  );
  const report = withPaywall(reportPaywall, async () =>
    Response.json({ title: "Q4 market report", pages: 42, summary: "Agents are the new API consumers." }),
  );

  const server: HttpServer = await serve((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;
      if (path === "/healthz") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      const handler = path === "/weather" ? weather : path === "/report" ? report : null;
      if (!handler) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const bodyText = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(bodyText ? { body: bodyText } : {}),
      });
      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else {
        res.end();
      }
    });
  }, options.port ?? 0);

  return {
    url: server.url,
    port: server.port,
    weatherPaywall,
    reportPaywall,
    close: () => server.close(),
  };
}
