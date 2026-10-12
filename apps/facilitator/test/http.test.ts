import { usdc } from "@agentbank/core";
import { routes } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import {
  buildPayment,
  createHarness,
  overrideGateway,
  payer,
  relayer,
  seller,
  type Harness,
} from "./helpers";

let db: SqlClient;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

function setup(options: Parameters<typeof createHarness>[1] = {}): { h: Harness; app: FastifyInstance } {
  const h = createHarness(db, options);
  h.chain.faucet(payer.address, usdc("100"));
  return { h, app: buildApp({ facilitator: h.facilitator, metrics: h.metrics, bodyLimitBytes: 16 * 1024 }) };
}

describe("routes from the core contract", () => {
  it("serves exactly the facilitator routes of the registry", () => {
    expect(
      [routes.x402Verify, routes.x402Settle, routes.x402Supported].map((r) => [r.method, r.path, r.service]),
    ).toEqual([
      ["POST", "/v1/x402/verify", "facilitator"],
      ["POST", "/v1/x402/settle", "facilitator"],
      ["GET", "/v1/x402/supported", "facilitator"],
    ]);
  });
});

describe("GET /v1/x402/supported", () => {
  it("lists the exact scheme on the served network with settlement hints", async () => {
    const { h, app } = setup({ options: { maxSettlement: usdc("250") } });
    const res = await app.inject({ method: "GET", url: "/v1/x402/supported" });
    expect(res.statusCode).toBe(200);
    const body = routes.x402Supported.response.parse(res.json());
    expect(body).toEqual({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "eip155:1337",
          extra: {
            asset: h.asset.address,
            name: "USDC",
            version: "2",
            decimals: 6,
            settleBeforeServeAbove: "1.00",
            maxSettlement: "250.00",
          },
        },
      ],
      extensions: [],
      signers: { "eip155:*": [relayer.address] },
    });
  });
});

describe("POST /v1/x402/verify and /settle", () => {
  it("verifies and settles a payment over HTTP in the x402 shape", async () => {
    const { h, app } = setup();
    const { body } = await buildPayment(h, { amount: usdc("1.10") });
    const verify = await app.inject({ method: "POST", url: "/v1/x402/verify", payload: body });
    expect(verify.statusCode).toBe(200);
    expect(routes.x402Verify.response.parse(verify.json())).toEqual({ isValid: true, payer: payer.address });

    const settle = await app.inject({ method: "POST", url: "/v1/x402/settle", payload: body });
    expect(settle.statusCode).toBe(200);
    const settled = routes.x402Settle.response.parse(settle.json());
    expect(settled).toMatchObject({
      success: true,
      payer: payer.address,
      network: "eip155:1337",
      amount: "1100000",
    });
    expect(h.chain.balanceOf(seller)).toBe(usdc("1.10"));

    const replay = await app.inject({ method: "POST", url: "/v1/x402/verify", payload: body });
    expect(replay.json()).toMatchObject({ isValid: false, invalidReason: "authorization_already_used" });
  });

  it("answers invalid payments with HTTP 200 and an invalidReason", async () => {
    const { h, app } = setup();
    const { body } = await buildPayment(h, { network: "eip155:8453" });
    const res = await app.inject({ method: "POST", url: "/v1/x402/verify", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isValid: false, invalidReason: "invalid_network" });
  });

  it.each([
    ["verify", { isValid: false, invalidReason: "invalid_payload" }],
    ["settle", { success: false, errorReason: "invalid_payload", transaction: "", network: "eip155:1337" }],
  ])("%s: invalid JSON is HTTP 400 in the x402 shape", async (route, expected) => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/x402/${route}`,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject(expected);
  });

  it("a missing body is HTTP 400 invalid_payload", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/v1/x402/verify" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("a non-JSON media type is refused in the x402 shape", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/x402/settle",
      headers: { "content-type": "text/plain" },
      payload: "hello",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
  });

  it("an oversized body is refused (413)", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/x402/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(20_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("fail-closed answers keep the x402 shape with a 5xx status", async () => {
    const { h, app } = setup({
      gateway: (gateway) =>
        overrideGateway(gateway, { isDeployed: async () => Promise.reject(new Error("rpc down")) }),
    });
    const { body } = await buildPayment(h);
    const res = await app.inject({ method: "POST", url: "/v1/x402/settle", payload: body });
    expect(res.statusCode).toBe(502);
    expect(routes.x402Settle.response.parse(res.json())).toMatchObject({
      success: false,
      errorReason: "chain_unavailable",
    });
  });
});

describe("operational endpoints", () => {
  it("GET /healthz reports the database and the chain", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = routes.health.response.parse(res.json());
    expect(body.status).toBe("ok");
    expect(body.checks).toMatchObject({ db: "ok", chain: "ok", network: "eip155:1337" });
  });

  it("an unreachable chain is degraded (200); an unreachable database is 503", async () => {
    const { app } = setup({
      gateway: (gateway) =>
        overrideGateway(gateway, { getBlock: async () => Promise.reject(new Error("rpc down")) }),
    });
    const degraded = await app.inject({ method: "GET", url: "/healthz" });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({ status: "degraded", checks: { chain: "unavailable", db: "ok" } });

    const brokenDb: SqlClient = {
      driver: "pglite",
      query: async () => Promise.reject(new Error("down")),
      transaction: async () => Promise.reject(new Error("down")),
      exec: async () => Promise.reject(new Error("down")),
      close: async () => undefined,
    };
    const h = createHarness(brokenDb);
    const app2 = buildApp({ facilitator: h.facilitator });
    const down = await app2.inject({ method: "GET", url: "/healthz" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ status: "degraded", checks: { db: "unavailable" } });
  });

  it("GET /metrics exposes Prometheus counters", async () => {
    const { h, app } = setup();
    const { body } = await buildPayment(h);
    await app.inject({ method: "POST", url: "/v1/x402/settle", payload: body });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain('facilitator_settlements_total{outcome="settled",reason="none"} 1');
    expect(res.body).toContain('facilitator_request_duration_seconds_count{route="settle"} 1');
  });

  it("unknown routes are RFC 9457 problems", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/v1/x402/verify" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      status: 404,
      code: "not_found",
      type: "urn:agentbank:problem:not_found",
    });
  });
});
