import { signRequest, unixSeconds, usdc } from "@agentbank/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCall, call, createHarness, TEST_PUBLIC_BASE_URL, type Harness } from "./support/harness";
import { onboard, type World } from "./support/flows";

let h: Harness;
let w: World;

beforeAll(async () => {
  h = await createHarness();
  w = await onboard(h, { name: "signer", fund: usdc("20") });
});
afterAll(async () => h.close());

async function signed(
  method: "GET" | "POST",
  path: string,
  opts: {
    body?: string;
    created?: number;
    nonce?: string;
    url?: string;
    key?: ReturnType<typeof privateKeyToAccount>;
    keyId?: string;
    idem?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const sig = await signRequest(
    { method, url: opts.url ?? `${TEST_PUBLIC_BASE_URL}${path}`, headers, body: opts.body ?? null },
    {
      keyId: opts.keyId ?? w.session.id,
      signer: opts.key ?? w.session.key,
      created: opts.created ?? unixSeconds(h.clock.now()),
      ...(opts.nonce ? { nonce: opts.nonce } : {}),
    },
  );
  return {
    ...headers,
    ...Object.fromEntries(Object.entries(sig).filter(([, v]) => v !== undefined)),
  } as Record<string, string>;
}

describe("RFC 9421 agent signatures", () => {
  it("accepts a valid signature", async () => {
    const res = await agentCall(h, w.session, "GET", `/v1/accounts/${w.account.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(w.account.id);
  });

  it("rejects a replayed nonce", async () => {
    const headers = await signed("GET", `/v1/accounts/${w.account.id}`, { nonce: "fixed-nonce-0001" });
    const first = await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers });
    expect(first.statusCode).toBe(200);
    const replay = await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body)).toMatchObject({
      code: "signature_invalid",
      detail: expect.stringContaining("nonce"),
    });
  });

  it("rejects a tampered body (content-digest)", async () => {
    const body = JSON.stringify({
      account_id: w.account.id,
      amount: { amount: "1.00", asset: "USDC" },
      memo: "x",
      reference: "a",
    });
    const headers = await signed("POST", "/v1/payment-requests", { body, idem: "auth-tamper-0001" });
    const tampered = body.replace('"1.00"', '"9.00"');
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/payment-requests",
      headers,
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("signature_invalid");
  });

  it("requires the idempotency key to be covered", async () => {
    const body = JSON.stringify({ account_id: w.account.id, amount: { amount: "1.00", asset: "USDC" } });
    const headers = await signed("POST", "/v1/payment-requests", { body });
    headers["idempotency-key"] = "auth-added-after-0001";
    const res = await h.app.inject({ method: "POST", url: "/v1/payment-requests", headers, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it("rejects expired and future signatures", async () => {
    const old = await signed("GET", `/v1/accounts/${w.account.id}`, {
      created: unixSeconds(h.clock.now()) - 600,
    });
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers: old })).statusCode,
    ).toBe(401);
    const future = await signed("GET", `/v1/accounts/${w.account.id}`, {
      created: unixSeconds(h.clock.now()) + 120,
    });
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers: future }))
        .statusCode,
    ).toBe(401);
  });

  it("binds the signature to the target URI", async () => {
    const headers = await signed("GET", `/v1/accounts/${w.account.id}`, {
      url: `https://evil.example/v1/accounts/${w.account.id}`,
    });
    const res = await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unknown sessions and keys that are not the session's", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const wrongKey = await signed("GET", `/v1/accounts/${w.account.id}`, { key: stranger });
    expect(
      (await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers: wrongKey }))
        .statusCode,
    ).toBe(401);
    const unknown = await signed("GET", `/v1/accounts/${w.account.id}`, {
      keyId: "ses_01J00000000000000000000000",
    });
    const res = await h.app.inject({ method: "GET", url: `/v1/accounts/${w.account.id}`, headers: unknown });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("unauthorized");
  });

  it("rejects revoked and expired sessions with precise codes", async () => {
    const other = await onboard(h, { name: "revoked" });
    const revoked = await call(h.app, "DELETE", `/v1/sessions/${other.session.id}`, { token: other.apiKey });
    expect(revoked.body.status).toBe("revoked");
    expect(revoked.headers["agentbank-owner-operation-id"]).toMatch(/^oop_/);
    expect(h.cosigner.callsTo("revokeSession")).toContainEqual({ sessionId: other.session.id });
    const res = await agentCall(h, other.session, "GET", `/v1/accounts/${other.account.id}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("session_revoked");
  });

  it("separates agent and principal routes", async () => {
    const agentOnPrincipal = await agentCall(h, w.session, "POST", "/v1/agents", { body: { name: "x" } });
    expect(agentOnPrincipal.status).toBe(403);
    const keyOnAgent = await call(h.app, "POST", "/v1/payments", {
      token: w.apiKey,
      body: {
        account_id: w.account.id,
        amount: { amount: "1.00", asset: "USDC" },
        to: { address: "0x1111111111111111111111111111111111111111" },
      },
    });
    expect(keyOnAgent.status).toBe(403);
    expect(keyOnAgent.body.detail).toContain("RFC 9421");
  });

  it("never logs credentials", async () => {
    const { REDACT_PATHS } = await import("../src/logger");
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers["signature-input"]',
        "req.headers.signature",
        "req.headers.authorization",
      ]),
    );
  });
});
