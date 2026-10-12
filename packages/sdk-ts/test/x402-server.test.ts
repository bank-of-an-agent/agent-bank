import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { encodeHeaderValue, readPaymentResponse, transferWithAuthorizationTypedData } from "../src";
import {
  createPaywall,
  expressPaywall,
  fastifyPaywall,
  honoPaywall,
  nodePaywall,
  withPaywall,
  type Paywall,
} from "../src/x402-server";
import { createLocalFacilitator, USDC_BASE_SEPOLIA } from "./helpers/x402-facilitator";

const SELLER = "0x7777777777777777777777777777777777777777";
const buyerKey = privateKeyToAccount(generatePrivateKey());
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(handler: Parameters<typeof createServer>[1] | express.Express): Promise<string> {
  const server = createServer(handler as Parameters<typeof createServer>[1]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sign an EIP-3009 payment for the paywall's requirements, like any x402 buyer would. */
async function paymentHeader(
  paywall: Paywall,
  version: 1 | 2 = 2,
  nonceSeed = `${Math.random()}`,
): Promise<Record<string, string>> {
  const r = paywall.requirements;
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: buyerKey.address,
    to: r.payTo,
    value: r.amount,
    validAfter: "0",
    validBefore: String(now + r.maxTimeoutSeconds),
    nonce: keccak256(toHex(nonceSeed)),
  };
  const signature = await buyerKey.signTypedData(
    transferWithAuthorizationTypedData(
      { name: "USDC", version: "2", chainId: 84532, verifyingContract: r.asset },
      authorization,
    ),
  );
  if (version === 1) {
    return {
      "X-PAYMENT": encodeHeaderValue({
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: { signature, authorization },
      }),
    };
  }
  return {
    "PAYMENT-SIGNATURE": encodeHeaderValue({
      x402Version: 2,
      resource: { url: "http://seller.test" },
      accepted: r,
      payload: { signature, authorization },
    }),
  };
}

function setup(price: string, events: string[] = []) {
  const local = createLocalFacilitator();
  const paywall = createPaywall({
    facilitatorUrl: "http://facilitator.test/v1/x402/",
    payTo: SELLER,
    price,
    description: "Report",
    mimeType: "application/json",
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      events.push(url.endsWith("/verify") ? "verify" : "settle");
      return local.fetch(input, init);
    },
  });
  return { local, paywall, events };
}

describe("paywall core", () => {
  it("answers unpaid requests with a v2 PAYMENT-REQUIRED header and a v1 body", async () => {
    const { paywall } = setup("0.01");
    const decision = await paywall.process({
      url: "http://seller.test/report?x=1",
      method: "GET",
      headers: {},
    });
    if (decision.kind !== "payment-required") throw new Error("expected 402");
    expect(decision.response.status).toBe(402);
    expect(decision.response.headers["Cache-Control"]).toBe("no-store");
    const challenge = decodePaymentRequiredHeader(decision.response.headers["PAYMENT-REQUIRED"] ?? "");
    expect(challenge).toEqual({
      x402Version: 2,
      error: "Payment required",
      resource: { url: "http://seller.test/report?x=1", description: "Report", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: USDC_BASE_SEPOLIA,
          amount: "10000",
          payTo: SELLER,
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });
    const body = JSON.parse(decision.response.body);
    expect(body).toMatchObject({
      x402Version: 1,
      accepts: [{ network: "base-sepolia", maxAmountRequired: "10000" }],
    });
  });

  it("decides settle-before-serve strictly above $1.00", () => {
    expect(setup("1.00").paywall.settleBeforeServe).toBe(false);
    expect(setup("1.000001").paywall.settleBeforeServe).toBe(true);
    expect(
      createPaywall({ facilitatorUrl: "http://f", payTo: SELLER, price: "0.01", settlement: "before-serve" })
        .settleBeforeServe,
    ).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(() => createPaywall({ facilitatorUrl: "http://f", payTo: "nope", price: "1" })).toThrow(/payTo/);
    expect(() => createPaywall({ facilitatorUrl: "http://f", payTo: SELLER, price: "0" })).toThrow(
      /greater than zero/,
    );
    expect(() =>
      createPaywall({ facilitatorUrl: "http://f", payTo: SELLER, price: "1", network: "eip155:8453" }),
    ).toThrow(/mainnet/i);
  });

  it("rejects mismatched, garbage and replayed payments", async () => {
    const { paywall, local } = setup("0.01");
    const other = setup("0.05").paywall;
    const wrong = await paywall.process({
      url: "http://s/x",
      method: "GET",
      headers: await paymentHeader(other),
    });
    expect(wrong.kind).toBe("payment-required");
    if (wrong.kind === "payment-required") {
      expect(decodePaymentRequiredHeader(wrong.response.headers["PAYMENT-REQUIRED"] ?? "").error).toBe(
        "no_matching_requirements",
      );
    }
    const garbage = await paywall.process({
      url: "http://s/x",
      method: "GET",
      headers: { "payment-signature": "%%" },
    });
    expect(garbage.kind).toBe("payment-required");

    const headers = await paymentHeader(paywall);
    const [a, b] = await Promise.all([
      paywall.process({ url: "http://s/x", method: "GET", headers }),
      paywall.process({ url: "http://s/x", method: "GET", headers }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["payment-required", "verified"]);
    expect(local.verifications).toHaveLength(1);
  });

  it("returns 502 when the facilitator is down (fail closed)", async () => {
    const paywall = createPaywall({
      facilitatorUrl: "http://facilitator.test",
      payTo: SELLER,
      price: "0.01",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const decision = await paywall.process({
      url: "http://s/x",
      method: "GET",
      headers: await paymentHeader(paywall),
    });
    if (decision.kind !== "payment-required") throw new Error("expected error");
    expect(decision.response.status).toBe(502);
  });
});

describe("Web Request/Response adapter (withPaywall)", () => {
  it("serves then settles at or below $1.00, adding PAYMENT-RESPONSE", async () => {
    const { paywall, events } = setup("0.50");
    const handler = withPaywall(paywall, async () => {
      events.push("handler");
      return Response.json({ ok: true });
    });
    const unpaid = await handler(new Request("http://seller.test/x"));
    expect(unpaid.status).toBe(402);
    const paid = await handler(
      new Request("http://seller.test/x", { headers: await paymentHeader(paywall) }),
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ ok: true });
    expect(readPaymentResponse(paid)?.success).toBe(true);
    expect(events).toEqual(["verify", "handler", "settle"]);
  });

  it("settles before serving above $1.00", async () => {
    const { paywall, events } = setup("2.50");
    const handler = withPaywall(paywall, async () => {
      events.push("handler");
      return Response.json({ ok: true });
    });
    const paid = await handler(
      new Request("http://seller.test/x", { headers: await paymentHeader(paywall) }),
    );
    expect(paid.status).toBe(200);
    expect(events).toEqual(["verify", "settle", "handler"]);
  });

  it("never runs the handler when an upfront settlement fails", async () => {
    const { paywall, events, local } = setup("5.00");
    local.setFailSettlement(true);
    const handler = withPaywall(paywall, async () => {
      events.push("handler");
      return Response.json({ ok: true });
    });
    const res = await handler(new Request("http://seller.test/x", { headers: await paymentHeader(paywall) }));
    expect(res.status).toBe(402);
    expect(events).toEqual(["verify", "settle"]);
    expect(readPaymentResponse(res)?.success).toBe(false);
  });

  it("does not charge for handler errors and replaces the response when settlement fails", async () => {
    const { paywall, events, local } = setup("0.10");
    const failing = withPaywall(paywall, async () => new Response("boom", { status: 500 }));
    const error = await failing(
      new Request("http://seller.test/x", { headers: await paymentHeader(paywall) }),
    );
    expect(error.status).toBe(500);
    expect(events).toEqual(["verify"]);

    local.setFailSettlement(true);
    const handler = withPaywall(paywall, async () => Response.json({ secret: "content" }));
    const res = await handler(new Request("http://seller.test/x", { headers: await paymentHeader(paywall) }));
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("secret");
  });

  it("accepts x402 v1 X-PAYMENT payments and answers with X-PAYMENT-RESPONSE", async () => {
    const { paywall, local } = setup("0.01");
    const handler = withPaywall(paywall, async () => Response.json({ ok: true }));
    const res = await handler(
      new Request("http://seller.test/x", { headers: await paymentHeader(paywall, 1) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(local.settled).toHaveLength(1);
  });
});

describe("framework adapters", () => {
  it("Express: buffers the response until settlement", async () => {
    const { paywall, events } = setup("0.01");
    const app = express();
    app.get("/r", expressPaywall(paywall), (_req, res) => {
      events.push("handler");
      res.status(200).json({ via: "express" });
    });
    const base = await listen(app);
    expect((await fetch(`${base}/r`)).status).toBe(402);
    const res = await fetch(`${base}/r`, { headers: await paymentHeader(paywall) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "express" });
    expect(readPaymentResponse(res)?.success).toBe(true);
    expect(events).toEqual(["verify", "handler", "settle"]);
  });

  it("Express: replaces the buffered body with a 402 when settlement fails", async () => {
    const { paywall, local } = setup("0.01");
    local.setFailSettlement(true);
    const app = express();
    app.get("/r", expressPaywall(paywall), (_req, res) => {
      res.json({ secret: "do not leak" });
    });
    const base = await listen(app);
    const res = await fetch(`${base}/r`, { headers: await paymentHeader(paywall) });
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("do not leak");
  });

  it("Node http: settles before serving above $1.00", async () => {
    const { paywall, events } = setup("1.50");
    const base = await listen(
      nodePaywall(paywall, (_req, res) => {
        events.push("handler");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("node ok");
      }),
    );
    const res = await fetch(`${base}/n`, { headers: await paymentHeader(paywall) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("node ok");
    expect(readPaymentResponse(res)?.success).toBe(true);
    expect(events).toEqual(["verify", "settle", "handler"]);
  });

  it("Node http: streams written with write() are held and flushed after settlement", async () => {
    const { paywall } = setup("0.01");
    const base = await listen(
      nodePaywall(paywall, (_req, res) => {
        res.statusCode = 200;
        res.write("part 1, ");
        res.end("part 2");
      }),
    );
    const res = await fetch(`${base}/n`, { headers: await paymentHeader(paywall) });
    expect(await res.text()).toBe("part 1, part 2");
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });

  it("Fastify: preHandler + onSend hooks", async () => {
    const { paywall, events } = setup("0.01");
    const app = Fastify();
    app.get("/f", { ...fastifyPaywall(paywall) }, async () => {
      events.push("handler");
      return { via: "fastify" };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const unpaid = await fetch(`${base}/f`);
      expect(unpaid.status).toBe(402);
      expect(unpaid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
      const res = await fetch(`${base}/f`, { headers: await paymentHeader(paywall) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ via: "fastify" });
      expect(readPaymentResponse(res)?.success).toBe(true);
      expect(events).toEqual(["verify", "handler", "settle"]);
    } finally {
      await app.close();
    }
  });

  it("Fastify: failed settlement turns the reply into a 402", async () => {
    const { paywall, local } = setup("0.01");
    local.setFailSettlement(true);
    const app = Fastify();
    app.get("/f", { ...fastifyPaywall(paywall) }, async () => ({ secret: "do not leak" }));
    const res = await app.inject({ method: "GET", url: "/f", headers: await paymentHeader(paywall) });
    expect(res.statusCode).toBe(402);
    expect(res.body).not.toContain("do not leak");
    await app.close();
  });

  it("Hono: middleware", async () => {
    const { paywall, events } = setup("2.00");
    const app = new Hono();
    app.get("/h", honoPaywall(paywall), (c) => {
      events.push("handler");
      return c.json({ via: "hono" });
    });
    expect((await app.request("http://seller.test/h")).status).toBe(402);
    const res = await app.request("http://seller.test/h", { headers: await paymentHeader(paywall) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "hono" });
    expect(readPaymentResponse(res)?.success).toBe(true);
    expect(events).toEqual(["verify", "settle", "handler"]);
  });

  it("Hono: serve-then-settle failure yields a clean 402", async () => {
    const { paywall, local } = setup("0.01");
    local.setFailSettlement(true);
    const app = new Hono();
    app.get("/h", honoPaywall(paywall), (c) => {
      c.header("x-handler", "1");
      return c.json({ secret: "do not leak" });
    });
    const res = await app.request("http://seller.test/h", { headers: await paymentHeader(paywall) });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-handler")).toBeNull();
    expect(await res.text()).not.toContain("do not leak");
  });
});
