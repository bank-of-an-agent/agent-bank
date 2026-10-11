import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, ROUTE_LIST, routes } from "../src/api";
import { PolicyDocumentSchema } from "../src/policy-schema";
import { OpenPaymentMandateSchema } from "../src/mandate-schema";

describe("API contract", () => {
  it("has unique operation ids and method+path pairs", () => {
    const ops = new Set(ROUTE_LIST.map((r) => r.operationId));
    expect(ops.size).toBe(ROUTE_LIST.length);
    const pairs = new Set(ROUTE_LIST.map((r) => `${r.method} ${r.path}`));
    expect(pairs.size).toBe(ROUTE_LIST.length);
  });

  it("requires idempotency keys on every money-moving write", () => {
    for (const r of [
      routes.createPayment,
      routes.submitPaymentSignature,
      routes.x402Pay,
      routes.createEscrow,
      routes.createStream,
    ]) {
      expect(r.idempotent).toBe(true);
    }
  });

  it("covers every endpoint listed in the design doc", () => {
    const pairs = new Set(ROUTE_LIST.map((r) => `${r.method} ${r.path}`));
    for (const expected of [
      "POST /v1/orgs",
      "POST /v1/agents",
      "GET /v1/agents/{id}",
      "POST /v1/agents/{id}/freeze",
      "POST /v1/agents/{id}/accounts",
      "GET /v1/accounts/{id}/balances",
      "POST /v1/sessions",
      "DELETE /v1/sessions/{id}",
      "POST /v1/mandates",
      "PUT /v1/agents/{id}/policy",
      "POST /v1/policy/check",
      "POST /v1/payments",
      "GET /v1/payments/{id}",
      "POST /v1/payment-requests",
      "POST /v1/x402/pay",
      "POST /v1/x402/verify",
      "POST /v1/x402/settle",
      "POST /v1/escrows",
      "POST /v1/escrows/{id}/release",
      "POST /v1/escrows/{id}/refund",
      "POST /v1/escrows/{id}/dispute",
      "POST /v1/streams",
      "GET /v1/approvals",
      "POST /v1/approvals/{id}/decide",
      "GET /v1/accounts/{id}/entries",
      "GET /v1/statements",
    ]) {
      expect(pairs, expected).toContain(expected);
    }
  });

  it("builds an OpenAPI 3.1 document", () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(50);
    expect(doc.components.schemas.Payment).toBeDefined();
    expect(doc.components.schemas.Problem).toBeDefined();
  });

  it("accepts the example policy from the design doc", () => {
    const parsed = PolicyDocumentSchema.parse({
      agent: "agt_research_01",
      asset: "USDC",
      limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
      counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"], new_cooldown_minutes: 60 },
      velocity: { max_per_minute: 30 },
      approvals: [
        { above: "100.00", approvers: 1 },
        { above: "1000.00", approvers: 2 },
      ],
      max_balance: "500.00",
    });
    expect(parsed.counterparties.mode).toBe("allowlist");
    expect(() => PolicyDocumentSchema.parse({ limits: { per_tx: 25 } })).toThrow();
    expect(() => PolicyDocumentSchema.parse({ surprise: true })).toThrow();
  });

  it("accepts an AP2 open payment mandate", () => {
    const m = OpenPaymentMandateSchema.parse({
      vct: "mandate.payment.open.1",
      agent_id: "agt_1",
      iat: 1_790_000_000,
      exp: 1_790_086_400,
      constraints: [
        { type: "payment.amount_range", currency: "USD", max: 2500 },
        { type: "payment.budget", currency: "USDC", max: "200000000" },
        { type: "agentbank.x402_domains", allowed: ["api.example-data.com"] },
      ],
    });
    expect(m.constraints).toHaveLength(3);
    expect(() => OpenPaymentMandateSchema.parse({ ...m, exp: m.iat })).toThrow();
  });
});
