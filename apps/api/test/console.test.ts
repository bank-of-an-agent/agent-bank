import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/http/auth";
import { SoftAuthenticator } from "./support/authenticator";
import {
  agentCall,
  call,
  createHarness,
  signupOrg,
  TEST_CONSOLE_ORIGIN,
  type Harness,
  type TestOrg,
} from "./support/harness";
import { onboard, type World } from "./support/flows";

let h: Harness;
let org: TestOrg;
let device: SoftAuthenticator;
let cookie: string;

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join("; ") : String(raw);
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
  if (!match) throw new Error(`no session cookie in ${header}`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

async function registerPasskey(
  token: { apiKey?: string; invite?: string },
  authenticator: SoftAuthenticator,
) {
  const options = await call(h.app, "POST", "/auth/passkeys/register/options", {
    ...(token.apiKey ? { token: token.apiKey } : {}),
    body: token.invite ? { invite_token: token.invite } : {},
    idempotencyKey: false,
  });
  expect(options.status).toBe(200);
  const verify = await call(h.app, "POST", "/auth/passkeys/register/verify", {
    body: { challenge_id: options.body.challenge_id, response: authenticator.register(options.body.options) },
    idempotencyKey: false,
  });
  return verify;
}

beforeAll(async () => {
  h = await createHarness();
  org = await signupOrg(h.app, "Console Co");
  await h.db.query("UPDATE subscription SET plan_code = 'business' WHERE org_id = $1", [org.org.id]);
  device = new SoftAuthenticator("console.test", TEST_CONSOLE_ORIGIN);
});
afterAll(async () => h.close());

describe("passkey registration and sign-in", () => {
  it("registers the admin's first passkey with the org's admin key and signs in", async () => {
    const res = await registerPasskey({ apiKey: org.apiKey }, device);
    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ role: "admin", passkey_count: 1 });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    cookie = sessionCookie(res);
    const session = await call(h.app, "GET", "/auth/session", { cookie });
    expect(session.status).toBe(200);
    expect(session.body.org.id).toBe(org.org.id);
    const { rows } = await h.db.query<{ token_hash: string }>("SELECT token_hash FROM console_session");
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it("rejects a replayed or forged registration", async () => {
    const options = await call(h.app, "POST", "/auth/passkeys/register/options", {
      token: org.apiKey,
      body: {},
      idempotencyKey: false,
    });
    const other = new SoftAuthenticator("evil.example", "https://evil.example");
    const forged = await call(h.app, "POST", "/auth/passkeys/register/verify", {
      body: { challenge_id: options.body.challenge_id, response: other.register(options.body.options) },
      idempotencyKey: false,
    });
    expect(forged.status).toBe(401);
    const replay = await call(h.app, "POST", "/auth/passkeys/register/verify", {
      body: { challenge_id: options.body.challenge_id, response: device.register(options.body.options) },
      idempotencyKey: false,
    });
    expect(replay.status).toBe(401); // challenge already consumed
  });

  it("signs in with the passkey", async () => {
    const options = await call(h.app, "POST", "/auth/passkeys/login/options", {
      body: {},
      idempotencyKey: false,
    });
    expect(options.status).toBe(200);
    const res = await call(h.app, "POST", "/auth/passkeys/login/verify", {
      body: { challenge_id: options.body.challenge_id, response: device.authenticate(options.body.options) },
      idempotencyKey: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.member.role).toBe("admin");
    cookie = sessionCookie(res);
  });

  it("authenticates API calls with the cookie and blocks cross-site writes", async () => {
    const me = await call(h.app, "GET", "/v1/orgs/me", { cookie });
    expect(me.status).toBe(200);
    const csrf = await call(h.app, "POST", "/v1/agents", {
      cookie,
      body: { name: "x" },
      headers: { origin: "https://evil.example" },
    });
    expect(csrf.status).toBe(403);
    const ok = await call(h.app, "POST", "/v1/agents", {
      cookie,
      body: { name: "from-console" },
      headers: { origin: TEST_CONSOLE_ORIGIN },
    });
    expect(ok.status).toBe(201);
  });

  it("allows CORS only from the console origin", async () => {
    const good = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/agents",
      headers: { origin: TEST_CONSOLE_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(good.headers["access-control-allow-origin"]).toBe(TEST_CONSOLE_ORIGIN);
    expect(good.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/agents",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("onboards invited members with a one-time token and applies their role", async () => {
    const member = await call(h.app, "POST", "/v1/members", {
      token: org.apiKey,
      body: { email: "viewer@example.com", role: "viewer" },
    });
    const invite = await call(h.app, "POST", `/auth/members/${member.body.id}/invite`, {
      token: org.apiKey,
      idempotencyKey: false,
    });
    expect(invite.status).toBe(201);
    const phone = new SoftAuthenticator("console.test", TEST_CONSOLE_ORIGIN);
    const res = await registerPasskey({ invite: invite.body.invite_token }, phone);
    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ email: "viewer@example.com", role: "viewer" });
    const viewerCookie = sessionCookie(res);
    const write = await call(h.app, "POST", "/v1/agents", {
      cookie: viewerCookie,
      body: { name: "nope" },
      headers: { origin: TEST_CONSOLE_ORIGIN },
    });
    expect(write.status).toBe(403);
    expect((await call(h.app, "GET", "/v1/agents", { cookie: viewerCookie })).status).toBe(200);
    const reuse = await call(h.app, "POST", "/auth/passkeys/register/options", {
      body: { invite_token: invite.body.invite_token },
      idempotencyKey: false,
    });
    expect(reuse.status).toBe(401);
  });

  it("logs out", async () => {
    const res = await call(h.app, "POST", "/auth/logout", {
      cookie,
      idempotencyKey: false,
      headers: { origin: TEST_CONSOLE_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect((await call(h.app, "GET", "/auth/session", { cookie })).status).toBe(401);
    expect((await call(h.app, "GET", "/v1/orgs/me", { cookie })).status).toBe(401);
  });
});

describe("approving with a passkey", () => {
  let w: World;
  beforeAll(async () => {
    w = await onboard(h, {
      name: "approvee",
      org,
      fund: usdc("100"),
      policy: { limits: { per_tx: "100.00" }, approvals: [{ above: "10.00", approvers: 1 }] },
    });
    const options = await call(h.app, "POST", "/auth/passkeys/login/options", {
      body: {},
      idempotencyKey: false,
    });
    const res = await call(h.app, "POST", "/auth/passkeys/login/verify", {
      body: { challenge_id: options.body.challenge_id, response: device.authenticate(options.body.options) },
      idempotencyKey: false,
    });
    cookie = sessionCookie(res);
  });

  it("requires a fresh assertion bound to the approval and decision", async () => {
    const created = await agentCall(h, w.session, "POST", "/v1/payments", {
      body: {
        account_id: w.account.id,
        amount: { amount: "20.00", asset: "USDC" },
        to: { address: "0x1111111111111111111111111111111111111111" },
      },
    });
    const approvalId = created.body.approval_id as string;
    const headers = { origin: TEST_CONSOLE_ORIGIN };
    const bare = await call(h.app, "POST", `/v1/approvals/${approvalId}/decide`, {
      cookie,
      headers,
      body: { decision: "approve" },
    });
    expect(bare.status).toBe(401);

    const denyChallenge = await call(h.app, "POST", `/auth/approvals/${approvalId}/options`, {
      cookie,
      headers,
      body: { decision: "deny" },
      idempotencyKey: false,
    });
    const wrongDecision = await call(h.app, "POST", `/v1/approvals/${approvalId}/decide`, {
      cookie,
      headers,
      body: { decision: "approve", webauthn_assertion: device.authenticate(denyChallenge.body.options) },
    });
    expect(wrongDecision.status).toBe(401);

    const approveChallenge = await call(h.app, "POST", `/auth/approvals/${approvalId}/options`, {
      cookie,
      headers,
      body: { decision: "approve" },
      idempotencyKey: false,
    });
    expect(approveChallenge.status).toBe(200);
    const decided = await call(h.app, "POST", `/v1/approvals/${approvalId}/decide`, {
      cookie,
      headers,
      body: { decision: "approve", webauthn_assertion: device.authenticate(approveChallenge.body.options) },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("approved");
    const { rows } = await h.db.query<{ assertion: unknown }>(
      "SELECT assertion FROM approval_decision WHERE approval_id = $1",
      [approvalId],
    );
    expect(rows[0]?.assertion).toBeTruthy();
  });
});
