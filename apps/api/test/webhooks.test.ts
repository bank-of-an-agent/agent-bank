import {
  verifyWebhook,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "@agentbank/core";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverWebhooks } from "../src/jobs/webhooks";
import { createLogger } from "../src/logger";
import { call, createAgent, createHarness, signupOrg, type Harness, type TestOrg } from "./support/harness";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let h: Harness;
let org: TestOrg;
const logLines: string[] = [];

function fakeFetch(status: number | "timeout", sent: Sent[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    if (status === "timeout") {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }
    return new Response("ok", { status });
  }) as typeof fetch;
}

beforeAll(async () => {
  const sink = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  h = await createHarness({
    config: {
      WEBHOOK_RETRY_SCHEDULE_SECONDS: "0,10,30",
      WEBHOOK_SIGNING_KEY: "webhook-signing-key-0123456789abcdef-test",
      METRICS_NAMESPACE: "AgentBank/Api",
    },
    logger: createLogger("info", sink),
  });
  org = await signupOrg(h.app, "Hooks");
  await h.db.query("UPDATE subscription SET plan_code = 'business' WHERE org_id = $1", [org.org.id]);
});
afterAll(async () => h.close());

async function endpoint(events: string[] = ["agent.frozen"]) {
  const res = await call(h.app, "POST", "/v1/webhook-endpoints", {
    token: org.apiKey,
    body: { url: "https://hooks.example.com/agentbank", events },
  });
  return res.body as { id: string; secret: string };
}

async function freeze() {
  const agent = await createAgent(h.app, org.apiKey, "hooked");
  await call(h.app, "POST", `/v1/agents/${agent.id}/freeze`, { token: org.apiKey, body: { reason: "test" } });
  return agent;
}

describe("webhook delivery", () => {
  it("seals endpoint secrets at rest", async () => {
    const ep = await endpoint();
    const { rows } = await h.db.query<{ secret: string }>(
      "SELECT secret FROM webhook_endpoint WHERE id = $1",
      [ep.id],
    );
    expect(rows[0]?.secret.startsWith("enc:v1:")).toBe(true);
    expect(rows[0]?.secret).not.toContain(ep.secret);
    await call(h.app, "DELETE", `/v1/webhook-endpoints/${ep.id}`, { token: org.apiKey });
  });

  it("delivers the event signed with HMAC (verifiable with core verifyWebhook)", async () => {
    const ep = await endpoint();
    const agent = await freeze();
    const sent: Sent[] = [];
    expect(await deliverWebhooks(h.deps, { fetch: fakeFetch(200, sent) })).toBe(1);
    const request = sent[0] as Sent;
    expect(request.url).toBe("https://hooks.example.com/agentbank");
    expect(request.headers[WEBHOOK_EVENT_HEADER]).toBe("agent.frozen");
    expect(request.headers[WEBHOOK_ID_HEADER]).toMatch(/^whd_/);
    const now = Math.floor(h.clock.now().getTime() / 1000);
    expect(() =>
      verifyWebhook(ep.secret, request.body, request.headers[WEBHOOK_SIGNATURE_HEADER], { now }),
    ).not.toThrow();
    expect(() =>
      verifyWebhook("whsec_wrong", request.body, request.headers[WEBHOOK_SIGNATURE_HEADER], { now }),
    ).toThrow();
    const event = JSON.parse(request.body);
    expect(event).toMatchObject({
      object: "event",
      type: "agent.frozen",
      org_id: org.org.id,
      data: { id: agent.id, status: "frozen" },
    });
    expect(await deliverWebhooks(h.deps, { fetch: fakeFetch(200, sent) })).toBe(0); // nothing left
    await call(h.app, "DELETE", `/v1/webhook-endpoints/${ep.id}`, { token: org.apiKey });
  });

  it("retries on the schedule and dead-letters after the last attempt", async () => {
    const ep = await endpoint();
    await freeze();
    const sent: Sent[] = [];
    await deliverWebhooks(h.deps, { fetch: fakeFetch(500, sent) });
    expect(sent).toHaveLength(1);
    await deliverWebhooks(h.deps, { fetch: fakeFetch(500, sent) });
    expect(sent).toHaveLength(1); // not due yet
    h.clock.advanceSeconds(10);
    await deliverWebhooks(h.deps, { fetch: fakeFetch("timeout", sent) });
    expect(sent).toHaveLength(2);
    const pending = await h.db.query<{ attempt: number; last_error: string; status: string }>(
      "SELECT attempt, last_error, status FROM webhook_delivery WHERE endpoint_id = $1",
      [ep.id],
    );
    expect(pending.rows[0]).toMatchObject({ attempt: 2, last_error: "timeout", status: "pending" });
    h.clock.advanceSeconds(20);
    await deliverWebhooks(h.deps, { fetch: fakeFetch(503, sent) });
    const dead = await h.db.query<{ status: string; attempt: number }>(
      "SELECT status, attempt FROM webhook_delivery WHERE endpoint_id = $1",
      [ep.id],
    );
    expect(dead.rows[0]).toMatchObject({ status: "dead", attempt: 3 });
    const metric = logLines.find((l) => l.includes("DeadLetteredDeliveries"));
    expect(metric).toBeDefined();
    const parsed = JSON.parse(metric as string);
    expect(parsed._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: "AgentBank/Webhooks",
      Dimensions: [[]],
    });
    expect(parsed.DeadLetteredDeliveries).toBe(1);
    await call(h.app, "DELETE", `/v1/webhook-endpoints/${ep.id}`, { token: org.apiKey });
  });

  it("only delivers subscribed event types and stops for disabled endpoints", async () => {
    const ep = await endpoint(["payment.settled"]);
    await freeze();
    const { rows } = await h.db.query("SELECT id FROM webhook_delivery WHERE endpoint_id = $1", [ep.id]);
    expect(rows).toHaveLength(0);
    const frozenEp = await endpoint(["agent.frozen"]);
    await freeze();
    await call(h.app, "DELETE", `/v1/webhook-endpoints/${frozenEp.id}`, { token: org.apiKey });
    const dead = await h.db.query<{ status: string }>(
      "SELECT status FROM webhook_delivery WHERE endpoint_id = $1",
      [frozenEp.id],
    );
    expect(dead.rows.every((r) => r.status === "dead")).toBe(true);
  });

  it("never writes secrets to the logs", () => {
    const joined = logLines.join("\n");
    expect(joined).not.toMatch(/whsec_[A-Za-z0-9_-]{20,}/);
    expect(joined).not.toMatch(/abk_test_[A-Za-z0-9_-]{20,}/);
  });
});
