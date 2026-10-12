import { CosignerHealth, PolicyStateInternal } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYEE, World } from "./helpers";

let w: World;

beforeAll(async () => {
  w = await World.create();
});

afterAll(async () => {
  await w.close();
});

const policyPath = () => `/internal/v1/policies/${w.agent}`;

function freezeBody(id = w.agent): string {
  return JSON.stringify({ scope: "agent", id, reason: "auth test" });
}

describe("internal request authentication", () => {
  it("accepts a correctly signed request", async () => {
    const res = await w.inject({ method: "GET", url: policyPath() });
    expect(res.statusCode).toBe(200);
    expect(PolicyStateInternal.parse(res.json()).current?.version).toBe(1);
  });

  it("refuses requests without the internal scheme", async () => {
    for (const authorization of [null, "Bearer abk_test_x", "AgentBank-Internal"]) {
      const res = await w.inject({ method: "GET", url: policyPath(), authorization });
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(res.json()).toMatchObject({ code: "unauthorized", status: 401 });
    }
  });

  it("refuses a request signed with the wrong secret", async () => {
    const res = await w.inject({
      method: "GET",
      url: policyPath(),
      secret: "another-secret-of-the-required-length!",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/invalid/);
  });

  it("binds the path: a signature for one route does not work on another", async () => {
    const body = freezeBody("agt_auth_path");
    const res = await w.inject({
      method: "POST",
      url: "/internal/v1/evaluate",
      body,
      signedPath: "/internal/v1/freeze",
    });
    expect(res.statusCode).toBe(401);
    const swapped = await w.inject({
      method: "GET",
      url: "/internal/v1/policies/agt_other",
      signedPath: policyPath(),
    });
    expect(swapped.statusCode).toBe(401);
  });

  it("binds the query string, the method and the body", async () => {
    const query = await w.inject({
      method: "GET",
      url: "/internal/v1/audit?after=5",
      signedPath: "/internal/v1/audit?after=0",
    });
    expect(query.statusCode).toBe(401);
    const method = await w.inject({
      method: "DELETE",
      url: "/internal/v1/sessions/ses_x",
      signedMethod: "GET",
    });
    expect(method.statusCode).toBe(401);
    const tampered = await w.inject({
      method: "POST",
      url: "/internal/v1/freeze",
      body: freezeBody(w.agent),
      signedBody: freezeBody("agt_somebody_else"),
    });
    expect(tampered.statusCode).toBe(401);
    // The tampered freeze did nothing: the agent can still pay.
    expect((await w.pay(PAYEE, 1_000_000n)).result.decision.outcome).toBe("allow");
  });

  it("enforces the ±60 s replay window against the service clock", async () => {
    const now = w.now();
    for (const t of [now - 61, now + 61, now - 3600]) {
      const res = await w.inject({ method: "GET", url: policyPath(), t });
      expect(res.statusCode, `t=${t - now}`).toBe(401);
      expect(res.json().detail).toMatch(/expired/);
    }
    for (const t of [now - 60, now - 59, now + 59]) {
      expect((await w.inject({ method: "GET", url: policyPath(), t })).statusCode, `t=${t - now}`).toBe(200);
    }
    // A captured request stops working once the window has passed.
    const captured = await w.inject({ method: "GET", url: policyPath(), t: now });
    expect(captured.statusCode).toBe(200);
    w.clock.advanceSeconds(61);
    expect((await w.inject({ method: "GET", url: policyPath(), t: now })).statusCode).toBe(401);
  });

  it("refuses malformed authorization parameters", async () => {
    for (const authorization of [
      "AgentBank-Internal t=abc,v1=00",
      "AgentBank-Internal v1=00",
      `AgentBank-Internal t=${w.now()},v1=zz`,
    ]) {
      const res = await w.inject({ method: "GET", url: policyPath(), authorization });
      expect(res.statusCode).toBe(401);
    }
  });

  it("authenticates before parsing: an unsigned malformed body is a 401, a signed one a 400", async () => {
    const unsigned = await w.inject({
      method: "POST",
      url: "/internal/v1/freeze",
      body: "{not json",
      secret: "wrong-secret-wrong-secret-wrong-secret",
    });
    expect(unsigned.statusCode).toBe(401);
    const signed = await w.inject({ method: "POST", url: "/internal/v1/freeze", body: "{not json" });
    expect(signed.statusCode).toBe(400);
    expect(signed.json().code).toBe("invalid_request");
  });

  it("validates bodies with the core schemas", async () => {
    const res = await w.inject({
      method: "POST",
      url: "/internal/v1/freeze",
      body: JSON.stringify({ scope: "planet", id: "x" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request" });
    expect(res.json().issues.length).toBeGreaterThan(0);
    const ids = await w.inject({
      method: "POST",
      url: "/internal/v1/freeze",
      body: JSON.stringify({ scope: "agent", id: "agt x;--", reason: "r" }),
    });
    expect(ids.statusCode).toBe(400);
  });

  it("answers unknown routes with a problem document", async () => {
    const res = await w.inject({ method: "GET", url: "/internal/v1/nothing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });
});

describe("unauthenticated endpoints", () => {
  it("/healthz reports the co-signer address without authentication", async () => {
    const res = await w.cosigner.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const health = CosignerHealth.parse(res.json());
    expect(health).toMatchObject({
      status: "ok",
      cosigner_address: w.signer.address,
      signer: "local",
      fail_closed: false,
    });
    expect(health.checks).toMatchObject({ database: "ok", audit_chain: "ok" });
  });

  it("/metrics exposes the decision latency histogram in Prometheus text format", async () => {
    await w.pay(PAYEE, 1_000_000n);
    const res = await w.cosigner.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("# TYPE cosigner_decision_duration_seconds histogram");
    expect(res.body).toMatch(
      /cosigner_decision_duration_seconds_bucket\{route="cosign",outcome="allow",le="0\.3"\} \d+/,
    );
    expect(res.body).toMatch(/cosigner_requests_total\{route="\/internal\/v1\/cosign",status="200"\} \d+/);
    expect(res.body).toMatch(/cosigner_auth_failures_total\{reason="invalid"\} \d+/);
  });
});
