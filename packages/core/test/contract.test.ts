import { describe, expect, it } from "vitest";
import {
  buildOpenApiDocument,
  CreateProofReservationRequest,
  ProofRequest,
  ROUTE_LIST,
  routes,
  UpdateProofSettingsRequest,
  type RouteDef,
} from "../src/api";
import { OWNER_ACTIONS } from "../src/eip712";
import { ownerPayloads } from "../src/owner-actions";
import { WEBHOOK_EVENT_TYPES } from "../src/webhooks";
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

  it("declares the private proofs API exactly as docs/private-proofs.md lists it", () => {
    const table: [string, string, string, string[], boolean][] = [
      ["getProofCircuit", "GET", "/v1/proofs/circuit", ["public"], false],
      ["listProofRoots", "GET", "/v1/proofs/roots", ["public"], false],
      ["getProofRoot", "GET", "/v1/proofs/roots/{root}", ["public"], false],
      ["verifyProof", "POST", "/v1/proofs/verify", ["public"], false],
      ["getProofSettings", "GET", "/v1/agents/{id}/proofs/settings", ["principal"], false],
      ["updateProofSettings", "PUT", "/v1/agents/{id}/proofs/settings", ["principal"], true],
      ["enrollProofIdentity", "PUT", "/v1/accounts/{id}/proofs/identity", ["agent"], true],
      ["getProofIdentity", "GET", "/v1/accounts/{id}/proofs/identity", ["agent", "principal"], false],
      ["getProofWitness", "GET", "/v1/accounts/{id}/proofs/witness", ["agent"], false],
      ["createProofReservation", "POST", "/v1/accounts/{id}/proofs/reservations", ["agent"], true],
      [
        "listProofReservations",
        "GET",
        "/v1/accounts/{id}/proofs/reservations",
        ["agent", "principal"],
        false,
      ],
      ["getProofReservation", "GET", "/v1/proofs/reservations/{id}", ["agent", "principal"], false],
      ["releaseProofReservation", "POST", "/v1/proofs/reservations/{id}/release", ["principal"], true],
    ];
    const proofRoutes = ROUTE_LIST.filter((r) => r.tags.includes("Proofs"));
    expect(proofRoutes.map((r) => r.operationId).sort()).toEqual(table.map(([op]) => op).sort());
    for (const [op, method, path, auth, idempotent] of table) {
      const r: RouteDef = routes[op as keyof typeof routes];
      expect({
        method: r.method,
        path: r.path,
        auth: [...r.auth],
        idempotent: r.idempotent === true,
      }).toEqual({
        method,
        path,
        auth,
        idempotent,
      });
    }
  });

  it("validates proof requests, presentations and reservations", () => {
    const request = {
      type: "agentbank.proof_request.v1",
      scope: "api.seller.example",
      request_id: "9f2c1b0e5a7d4c3b8e6f1a2b3c4d5e6f",
      nonce: `0x${"5e".repeat(31)}`,
      issued_at: 1_760_000_000,
      expires_at: 1_760_000_300,
      constraints: {
        principal_verification: { min: "2", max: "2" },
        per_tx_limit: { min: "5.00" },
        disputes_lost: { max: "0" },
      },
      max_root_age_seconds: 7200,
      min_anonymity_set: 16,
      chain_id: 84532,
      registry: null,
    };
    expect(ProofRequest.parse(request)).toEqual(request);
    expect(() => ProofRequest.parse({ ...request, constraints: { shoe_size: { min: "1" } } })).toThrow();
    expect(() => ProofRequest.parse({ ...request, expires_at: request.issued_at })).toThrow();
    expect(() => ProofRequest.parse({ ...request, nonce: `0x${"5e".repeat(32)}` })).toThrow();
    expect(() => ProofRequest.parse({ ...request, extra: true })).toThrow();
    expect(() =>
      ProofRequest.parse({ ...request, constraints: { balance: { min: "1", extra: "2" } } }),
    ).toThrow();

    const reservation = { amount: { amount: "500.00", asset: "USDC" }, expires_at: "2026-10-13T00:00:00Z" };
    expect(
      CreateProofReservationRequest.safeParse({ ...reservation, scope: "api.seller.example" }).success,
    ).toBe(true);
    expect(
      CreateProofReservationRequest.safeParse({ ...reservation, scope_tag: "1311768467463790320" }).success,
    ).toBe(true);
    expect(CreateProofReservationRequest.safeParse(reservation).success).toBe(false);
    expect(
      CreateProofReservationRequest.safeParse({ ...reservation, scope: "a", scope_tag: "1" }).success,
    ).toBe(false);
    expect(
      CreateProofReservationRequest.safeParse({ ...reservation, scope_tag: "18446744073709551616" }).success,
    ).toBe(false);
    expect(
      UpdateProofSettingsRequest.safeParse({ enabled: true, disclose: ["limits", "limits"] }).success,
    ).toBe(false);
  });

  it("hashes proof owner actions over sorted, unique classes", () => {
    const a = ownerPayloads.proofsDisclose("agt_1", {
      enabled: true,
      disclose: ["reputation", "limits", "limits"],
    });
    expect(a).toEqual({
      action: "proofs.disclose",
      subject: "agt_1",
      payload: { agent_id: "agt_1", enabled: true, disclose: ["limits", "reputation"] },
    });
    expect(ownerPayloads.proofReservationRelease("prv_1")).toEqual({
      action: "proofs.reservation.release",
      subject: "prv_1",
      payload: { reservation_id: "prv_1" },
    });
    expect(OWNER_ACTIONS).toContain("proofs.disclose");
    expect(WEBHOOK_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "proof_settings.updated",
        "proof_reservation.created",
        "proof_reservation.released",
        "proof_reservation.expired",
      ]),
    );
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
