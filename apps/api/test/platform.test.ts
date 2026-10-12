import { ROUTE_LIST } from "@agentbank/core/api";
import { verifyAuditChain } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAuditChain } from "../src/domain/audit";
import { toFastifyPath } from "../src/http/registry";
import {
  call,
  createAgent,
  createHarness,
  signupOrg,
  TEST_STAFF_TOKEN,
  type Harness,
  type TestOrg,
} from "./support/harness";

let h: Harness;
let acme: TestOrg;

beforeAll(async () => {
  h = await createHarness();
  acme = await signupOrg(h.app);
  // Lift the free plan's 3-agent limit for the shared org.
  await h.db.query("UPDATE subscription SET plan_code = 'business' WHERE org_id = $1", [acme.org.id]);
});
afterAll(async () => h.close());

describe("route registry", () => {
  it("registers every API route and no facilitator route", () => {
    const api = ROUTE_LIST.filter((r) => (r.service ?? "api") === "api");
    const facilitator = ROUTE_LIST.filter((r) => r.service === "facilitator");
    expect(api.length).toBeGreaterThan(70);
    expect(facilitator.length).toBe(3);
    for (const route of api) {
      expect(
        h.app.hasRoute({ method: route.method, url: toFastifyPath(route.path) }),
        route.operationId,
      ).toBe(true);
    }
    for (const route of facilitator) {
      expect(
        h.app.hasRoute({ method: route.method, url: toFastifyPath(route.path) }),
        route.operationId,
      ).toBe(false);
    }
  });

  it("serves the OpenAPI document for the api service and a docs page", async () => {
    const res = await call(h.app, "GET", "/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/v1/payments"]).toBeDefined();
    expect(res.body.paths["/v1/x402/verify"]).toBeUndefined();
    const docs = await call(h.app, "GET", "/docs");
    expect(docs.status).toBe(200);
    expect(String(docs.headers["content-type"])).toContain("text/html");
  });

  it("answers unknown routes with RFC 9457 problem details", async () => {
    const res = await call(h.app, "GET", "/v1/nope");
    expect(res.status).toBe(404);
    expect(String(res.headers["content-type"])).toContain("application/problem+json");
    expect(res.body).toMatchObject({
      type: "urn:agentbank:problem:not_found",
      status: 404,
      code: "not_found",
    });
  });
});

describe("orgs and API keys", () => {
  it("creates an org with an admin key; KYB is auto-approved by the sandbox provider", async () => {
    expect(acme.org.id).toMatch(/^org_/);
    expect(acme.org.kyc_status).toBe("approved");
    expect(acme.apiKey).toMatch(/^abk_test_/);
    const me = await call(h.app, "GET", "/v1/orgs/me", { token: acme.apiKey });
    expect(me.status).toBe(200);
    expect(me.body.kyc_status).toBe("approved");
    expect(me.body.country).toBe("US");
    expect(me.body.tier).toBe("free");
  });

  it("requires authentication and rejects bad keys", async () => {
    const none = await call(h.app, "GET", "/v1/orgs/me");
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("unauthorized");
    const bad = await call(h.app, "GET", "/v1/orgs/me", { token: "abk_test_not-a-real-key" });
    expect(bad.status).toBe(401);
  });

  it("stores only the SHA-256 of API keys", async () => {
    const { rows } = await h.db.query<{ secret_hash: string }>("SELECT secret_hash FROM api_key");
    for (const row of rows) {
      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.secret_hash).not.toContain("abk_");
    }
  });

  it("validates bodies with field details", async () => {
    const res = await call(h.app, "POST", "/v1/agents", { token: acme.apiKey, body: { name: "" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect(res.body.errors[0].path).toBe("body.name");
  });

  it("enforces API key scopes", async () => {
    const created = await call(h.app, "POST", "/v1/api-keys", {
      token: acme.apiKey,
      body: { name: "read only", scopes: ["payments:read"] },
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^abk_test_/);
    const readOnly = created.body.secret as string;
    const write = await call(h.app, "POST", "/v1/agents", { token: readOnly, body: { name: "x" } });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("forbidden");
    const read = await call(h.app, "GET", "/v1/agents", { token: readOnly });
    expect(read.status).toBe(200);

    const revoked = await call(h.app, "DELETE", `/v1/api-keys/${created.body.id}`, { token: acme.apiKey });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked_at).not.toBeNull();
    const after = await call(h.app, "GET", "/v1/agents", { token: readOnly });
    expect(after.status).toBe(401);
  });

  it("gates open signup", async () => {
    const closed = await createHarness({ config: { ALLOW_OPEN_SIGNUP: "false" } });
    try {
      const res = await call(closed.app, "POST", "/v1/orgs", {
        body: {
          legal_name: "Nope",
          kind: "individual",
          country: "GB",
          contact_email: "a@example.com",
          owner_address: "0x1111111111111111111111111111111111111111",
        },
      });
      expect(res.status).toBe(403);
    } finally {
      await closed.close();
    }
  });
});

describe("idempotency", () => {
  it("requires an Idempotency-Key on writes", async () => {
    const res = await call(h.app, "POST", "/v1/agents", {
      token: acme.apiKey,
      body: { name: "a" },
      idempotencyKey: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("Idempotency-Key");
  });

  it("replays the original response and flags it", async () => {
    const key = "idem-agent-0001";
    const first = await call(h.app, "POST", "/v1/agents", {
      token: acme.apiKey,
      body: { name: "replay" },
      idempotencyKey: key,
    });
    const second = await call(h.app, "POST", "/v1/agents", {
      token: acme.apiKey,
      body: { name: "replay" },
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    const { rows } = await h.db.query("SELECT id FROM agent WHERE name = 'replay'");
    expect(rows).toHaveLength(1);
  });

  it("rejects key reuse with a different request", async () => {
    const key = "idem-agent-0002";
    await call(h.app, "POST", "/v1/agents", {
      token: acme.apiKey,
      body: { name: "one" },
      idempotencyKey: key,
    });
    const res = await call(h.app, "POST", "/v1/agents", {
      token: acme.apiKey,
      body: { name: "two" },
      idempotencyKey: key,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("idempotency_conflict");
  });

  it("rejects an in-flight duplicate and takes over abandoned claims", async () => {
    const scope = `org:${acme.org.id}:createMember`;
    await h.db.query(
      "INSERT INTO idempotency_record (scope, key, request_hash, created_at) VALUES ($1, $2, $3, $4)",
      [scope, "idem-inflight-1", "will-not-match", h.clock.now()],
    );
    const conflict = await call(h.app, "POST", "/v1/members", {
      token: acme.apiKey,
      body: { email: "inflight@example.com", role: "viewer" },
      idempotencyKey: "idem-inflight-1",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("idempotency_conflict");

    // Same request still in flight: 409 until the claim goes stale, then it is taken over.
    const { canonicalSha256 } = await import("@agentbank/core");
    const body = { email: "takeover@example.com", role: "viewer" };
    const hash = canonicalSha256({ method: "POST", url: "/v1/members", body });
    await h.db.query(
      "INSERT INTO idempotency_record (scope, key, request_hash, created_at) VALUES ($1, $2, $3, $4)",
      [scope, "idem-inflight-2", hash, h.clock.now()],
    );
    const busy = await call(h.app, "POST", "/v1/members", {
      token: acme.apiKey,
      body,
      idempotencyKey: "idem-inflight-2",
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("conflict");
    h.clock.advanceSeconds(121); // IDEMPOTENCY_STALE_SECONDS
    const takenOver = await call(h.app, "POST", "/v1/members", {
      token: acme.apiKey,
      body,
      idempotencyKey: "idem-inflight-2",
    });
    expect(takenOver.status).toBe(201);
    const replay = await call(h.app, "POST", "/v1/members", {
      token: acme.apiKey,
      body,
      idempotencyKey: "idem-inflight-2",
    });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.id).toBe(takenOver.body.id);
  });

  it("rate-limits per credential", async () => {
    const limited = await createHarness({ cosigner: "fake", config: { RATE_LIMIT_PER_MINUTE: "3" } });
    try {
      const one = await signupOrg(limited.app, "Busy");
      const two = await signupOrg(limited.app, "Calm");
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await call(limited.app, "GET", "/v1/orgs/me", { token: one.apiKey })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      const blocked = await call(limited.app, "GET", "/v1/orgs/me", { token: one.apiKey });
      expect(blocked.body.code).toBe("rate_limited");
      expect(blocked.headers["retry-after"]).toBe("60");
      // Another credential has its own budget.
      expect((await call(limited.app, "GET", "/v1/orgs/me", { token: two.apiKey })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("never stores secrets for replay", async () => {
    const key = "idem-apikey-0001";
    const first = await call(h.app, "POST", "/v1/api-keys", {
      token: acme.apiKey,
      body: { name: "ci" },
      idempotencyKey: key,
    });
    const replay = await call(h.app, "POST", "/v1/api-keys", {
      token: acme.apiKey,
      body: { name: "ci" },
      idempotencyKey: key,
    });
    expect(first.body.secret).toMatch(/^abk_test_/);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.secret).toBe("");
    const { rows } = await h.db.query<{ response: unknown }>("SELECT response FROM idempotency_record");
    expect(JSON.stringify(rows)).not.toContain(first.body.secret);
  });

  it("scopes keys per caller", async () => {
    const other = await signupOrg(h.app, "Other");
    const key = "idem-shared-0001";
    const a = await call(h.app, "POST", "/v1/agents", {
      token: acme.apiKey,
      body: { name: "shared" },
      idempotencyKey: key,
    });
    const b = await call(h.app, "POST", "/v1/agents", {
      token: other.apiKey,
      body: { name: "shared" },
      idempotencyKey: key,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });
});

describe("org scoping", () => {
  it("hides other orgs' resources", async () => {
    const other = await signupOrg(h.app, "Rival");
    const agent = await createAgent(h.app, acme.apiKey, "private");
    const res = await call(h.app, "GET", `/v1/agents/${agent.id}`, { token: other.apiKey });
    expect(res.status).toBe(404);
    const list = await call(h.app, "GET", "/v1/agents", { token: other.apiKey });
    expect(list.body.data.map((a: { id: string }) => a.id)).not.toContain(agent.id);
  });

  it("paginates with opaque cursors", async () => {
    const org = await signupOrg(h.app, "Pager");
    for (let i = 0; i < 3; i++) await createAgent(h.app, org.apiKey, `p${i}`);
    const page1 = await call(h.app, "GET", "/v1/agents?limit=2", { token: org.apiKey });
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.next_cursor).toEqual(expect.any(String));
    const page2 = await call(h.app, "GET", `/v1/agents?limit=2&cursor=${page1.body.next_cursor}`, {
      token: org.apiKey,
    });
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.next_cursor).toBeNull();
    const ids = [...page1.body.data, ...page2.body.data].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(3);
    const bad = await call(h.app, "GET", "/v1/agents?cursor=garbage", { token: org.apiKey });
    expect(bad.status).toBe(400);
  });

  it("enforces the plan's agent limit", async () => {
    const org = await signupOrg(h.app, "Limited");
    for (let i = 0; i < 3; i++) await createAgent(h.app, org.apiKey, `a${i}`);
    const res = await call(h.app, "POST", "/v1/agents", { token: org.apiKey, body: { name: "fourth" } });
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain("at most 3 agents");
  });
});

describe("members", () => {
  it("invites members and rejects duplicates", async () => {
    const res = await call(h.app, "POST", "/v1/members", {
      token: acme.apiKey,
      body: { email: "Ann@Example.com", role: "approver" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "ann@example.com", role: "approver", passkey_count: 0 });
    const dup = await call(h.app, "POST", "/v1/members", {
      token: acme.apiKey,
      body: { email: "ann@example.com", role: "viewer" },
    });
    expect(dup.status).toBe(409);
    const list = await call(h.app, "GET", "/v1/members", { token: acme.apiKey });
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe("webhook endpoints and events", () => {
  it("registers endpoints (secret shown once), lists and disables them", async () => {
    const created = await call(h.app, "POST", "/v1/webhook-endpoints", {
      token: acme.apiKey,
      body: { url: "https://hooks.example.com/agentbank", events: ["agent.frozen", "payment.settled"] },
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    const list = await call(h.app, "GET", "/v1/webhook-endpoints", { token: acme.apiKey });
    expect(list.body.data[0]).not.toHaveProperty("secret");
    const disabled = await call(h.app, "DELETE", `/v1/webhook-endpoints/${created.body.id}`, {
      token: acme.apiKey,
    });
    expect(disabled.body.status).toBe("disabled");
  });

  it("rejects insecure webhook URLs in production mode", async () => {
    const prod = await createHarness({ config: { WEBHOOK_ALLOW_INSECURE_URLS: "false" } });
    try {
      const org = await signupOrg(prod.app);
      for (const url of [
        "http://hooks.example.com/x",
        "https://127.0.0.1/x",
        "https://localhost/x",
        "https://user:pw@example.com/x",
      ]) {
        const res = await call(prod.app, "POST", "/v1/webhook-endpoints", {
          token: org.apiKey,
          body: { url, events: ["agent.frozen"] },
        });
        expect(res.status, url).toBe(400);
      }
    } finally {
      await prod.close();
    }
  });
});

describe("freeze and unfreeze", () => {
  it("freezes immediately, tells the co-signer and emits agent.frozen", async () => {
    const agent = await createAgent(h.app, acme.apiKey, "freezable");
    const res = await call(h.app, "POST", `/v1/agents/${agent.id}/freeze`, {
      token: acme.apiKey,
      body: { reason: "suspicious" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "frozen", frozen_reason: "suspicious" });
    expect(h.cosigner.callsTo("freeze")).toContainEqual({
      scope: "agent",
      id: agent.id,
      reason: "suspicious",
    });
    const events = await call(h.app, "GET", "/v1/events?type=agent.frozen", { token: acme.apiKey });
    expect(events.body.data.some((e: { data: { id: string } }) => e.data.id === agent.id)).toBe(true);
  });

  it("keeps the freeze and retries the co-signer later when it is down", async () => {
    const agent = await createAgent(h.app, acme.apiKey, "freeze-outage");
    h.cosigner.available = false;
    try {
      const res = await call(h.app, "POST", `/v1/agents/${agent.id}/freeze`, {
        token: acme.apiKey,
        body: { reason: "outage" },
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("frozen");
    } finally {
      h.cosigner.available = true;
    }
    const { rows } = await h.db.query<{ status: string }>(
      "SELECT status FROM cosigner_outbox WHERE payload->>'id' = $1",
      [agent.id],
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("unfreezes only with an owner authorization and after a 1-hour delay", async () => {
    const { ownerAuth } = await import("./support/harness");
    const { applyDueUnfreezes } = await import("../src/domain/freeze");
    const agent = await createAgent(h.app, acme.apiKey, "thaw");
    await call(h.app, "POST", `/v1/agents/${agent.id}/freeze`, {
      token: acme.apiKey,
      body: { reason: "test" },
    });
    // The co-signer learns agents from their policy: until then it cannot verify an unfreeze.
    const unknown = await call(h.app, "POST", `/v1/agents/${agent.id}/unfreeze`, {
      token: acme.apiKey,
      body: {
        reason: "ok",
        owner_authorization: await ownerAuth(acme.owner, h.clock, "agent.unfreeze", agent.id, {
          reason: "ok",
        }),
      },
    });
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe("invalid_state");
    const { putPolicy, DEFAULT_POLICY } = await import("./support/flows");
    expect((await putPolicy(h, acme, agent.id, DEFAULT_POLICY)).status).toBe(200);
    h.clock.advanceSeconds(1);

    const stranger = (await import("viem/accounts")).privateKeyToAccount(
      (await import("viem/accounts")).generatePrivateKey(),
    );
    const forged = await ownerAuth(stranger, h.clock, "agent.unfreeze", agent.id, { reason: "ok" });
    const rejected = await call(h.app, "POST", `/v1/agents/${agent.id}/unfreeze`, {
      token: acme.apiKey,
      body: { reason: "ok", owner_authorization: forged },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe("owner_signature_required");

    const auth = await ownerAuth(acme.owner, h.clock, "agent.unfreeze", agent.id, { reason: "ok" });
    const accepted = await call(h.app, "POST", `/v1/agents/${agent.id}/unfreeze`, {
      token: acme.apiKey,
      body: { reason: "ok", owner_authorization: auth },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("frozen");
    expect(new Date(accepted.body.pending_unfreeze_at).getTime() - h.clock.now().getTime()).toBe(3_600_000);

    h.clock.advanceSeconds(3_601);
    await applyDueUnfreezes(h.deps, h.clock.now());
    const after = await call(h.app, "GET", `/v1/agents/${agent.id}`, { token: acme.apiKey });
    expect(after.body.status).toBe("active");
  });

  it("freezes the whole org", async () => {
    const org = await signupOrg(h.app, "Freezer");
    const res = await call(h.app, "POST", "/v1/orgs/me/freeze", {
      token: org.apiKey,
      body: { reason: "incident" },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("frozen");
    expect(h.cosigner.callsTo("freeze")).toContainEqual({ scope: "org", id: org.org.id, reason: "incident" });
  });
});

describe("billing", () => {
  it("lists plans publicly", async () => {
    const res = await call(h.app, "GET", "/v1/billing/plans");
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { code: string }) => p.code)).toEqual([
      "free",
      "pro",
      "business",
      "enterprise",
    ]);
    expect(res.body.data[1].monthly_price).toEqual({ amount: "99.00", asset: "USDC" });
  });

  it("changes plan; without a treasury account the subscription is past due", async () => {
    const org = await signupOrg(h.app, "Upgrader");
    const sub = await call(h.app, "GET", "/v1/billing/subscription", { token: org.apiKey });
    expect(sub.body.plan.code).toBe("free");
    const changed = await call(h.app, "PUT", "/v1/billing/subscription", {
      token: org.apiKey,
      body: { plan: "pro" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.plan.code).toBe("pro");
    expect(changed.body.status).toBe("past_due");
    const me = await call(h.app, "GET", "/v1/orgs/me", { token: org.apiKey });
    expect(me.body.tier).toBe("pro");
  });

  it("summarizes fees for a period", async () => {
    const res = await call(h.app, "GET", "/v1/billing/fees?period=2026-10", { token: acme.apiKey });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ object: "fee_summary", total: "0.00" });
    expect(Object.keys(res.body.by_kind)).toContain("outbound_payment");
  });

  it("serves the revenue report to staff only, by business-model stream", async () => {
    const anon = await call(h.app, "GET", "/v1/admin/revenue?period=2026-10");
    expect(anon.status).toBe(401);
    const key = await call(h.app, "GET", "/v1/admin/revenue?period=2026-10", { token: acme.apiKey });
    expect(key.status).toBe(401);
    const res = await call(h.app, "GET", "/v1/admin/revenue?period=2026-10", { token: TEST_STAFF_TOKEN });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.revenue_by_stream)).toEqual([
      "subscriptions",
      "outbound",
      "x402Receive",
      "escrow",
      "streams",
      "treasurySweep",
      "partnerSavings",
    ]);
    expect(res.body.paying_orgs).toHaveProperty("enterprise");
  });
});

describe("health", () => {
  it("reports ok, and degraded when the co-signer is down", async () => {
    const ok = await call(h.app, "GET", "/healthz");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "ok", checks: { db: "ok", cosigner: "ok" } });
    h.cosigner.available = false;
    try {
      const degraded = await call(h.app, "GET", "/healthz");
      expect(degraded.status).toBe(200);
      expect(degraded.body).toMatchObject({ status: "degraded", checks: { cosigner: "unavailable" } });
    } finally {
      h.cosigner.available = true;
    }
  });
});

describe("audit log", () => {
  it("is an intact hash chain", async () => {
    const records = await loadAuditChain(h.db);
    expect(records.length).toBeGreaterThan(5);
    expect(verifyAuditChain(records)).toBe(-1);
  });
});
