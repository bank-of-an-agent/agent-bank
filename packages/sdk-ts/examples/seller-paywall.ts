/**
 * Sell an API per call with x402: a plain Node HTTP server whose `/weather`
 * costs 0.01 USDC (settled after the handler) and `/report` costs 2.00 USDC
 * (above $1.00, so settled before the handler runs). Payments are verified
 * and settled by Agent Bank's facilitator.
 *
 *   AGENTBANK_FACILITATOR_URL=http://localhost:8080/v1/x402 \
 *   SELLER_PAY_TO=0xYourAccountAddress \
 *   pnpm --filter @agentbank/sdk exec tsx examples/seller-paywall.ts
 *
 * Express, Fastify, Hono and Next.js adapters work the same way:
 * `expressPaywall`, `fastifyPaywall`, `honoPaywall`, `withPaywall`.
 */
import { createServer } from "node:http";
import { createPaywall, nodePaywall } from "@agentbank/sdk/x402-server";

const facilitatorUrl = process.env.AGENTBANK_FACILITATOR_URL ?? "http://localhost:8080/v1/x402";
const payTo = process.env.SELLER_PAY_TO ?? "0x7777777777777777777777777777777777777777";

const weather = nodePaywall(
  createPaywall({
    facilitatorUrl,
    payTo,
    price: "0.01",
    description: "Current weather",
    mimeType: "application/json",
  }),
  (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ city: "Lisbon", temp: 21 }));
  },
);

const report = nodePaywall(
  createPaywall({
    facilitatorUrl,
    payTo,
    price: "2.00",
    description: "Quarterly report",
    mimeType: "text/plain",
  }),
  (_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("Q3: revenue up, costs down.");
  },
);

createServer((req, res) => {
  if (req.url?.startsWith("/weather")) return weather(req, res);
  if (req.url?.startsWith("/report")) return report(req, res);
  res.statusCode = 404;
  res.end();
}).listen(4021, "127.0.0.1", () => {
  console.log("seller listening on http://127.0.0.1:4021 (/weather 0.01 USDC, /report 2.00 USDC)");
});
