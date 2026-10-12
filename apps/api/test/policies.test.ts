import { PolicyDocumentSchema, unixSeconds, usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentCall,
  call,
  createAgent,
  createHarness,
  ownerAuth,
  signupOrg,
  type Harness,
  type TestOrg,
} from "./support/harness";
import { onboard, payAndSign, putPolicy, type World } from "./support/flows";

let h: Harness;
let org: TestOrg;
let w: World;

beforeAll(async () => {
  h = await createHarness();
  org = await signupOrg(h.app, "Policy Co");
  await h.db.query("UPDATE subscription SET plan_code = 'business' WHERE org_id = $1", [org.org.id]);
  w = await onboard(h, { name: "mandated", fund: usdc("500") });
});
afterAll(async () => h.close());

describe("policies", () => {
  it("needs an owner authorization for the first policy, which applies at once", async () => {
    const agent = await createAgent(h.app, org.apiKey, "p1");
    const unsigned = await putPolicy(h, org, agent.id, { limits: { per_tx: "10.00" } }, false);
    expect(unsigned.status).toBe(403);
    expect(unsigned.body.code).toBe("owner_signature_required");
    const signed = await putPolicy(h, org, agent.id, { limits: { per_tx: "10.00" } });
    expect(signed.status).toBe(200);
    expect(signed.body.current).toMatchObject({ version: 1, change_kind: "initial" });
    expect(signed.body.pending).toBeNull();
  });

  it("applies tightening immediately without a signature", async () => {
    const agent = await createAgent(h.app, org.apiKey, "p2");
    await putPolicy(h, org, agent.id, { limits: { per_tx: "100.00" } });
    const tighter = await putPolicy(h, org, agent.id, { limits: { per_tx: "50.00" } }, false);
    expect(tighter.status).toBe(200);
    expect(tighter.body.current).toMatchObject({ version: 2, change_kind: "tighten" });
  });

  it("delays loosening by an hour behind an owner signature", async () => {
    const agent = await createAgent(h.app, org.apiKey, "p3");
    await putPolicy(h, org, agent.id, { limits: { per_tx: "100.00" } });
    const unsigned = await putPolicy(h, org, agent.id, { limits: { per_tx: "500.00" } }, false);
    expect(unsigned.status).toBe(403);
    const forged = await call(h.app, "PUT", `/v1/agents/${agent.id}/policy`, {
      token: org.apiKey,
      body: {
        policy: PolicyDocumentSchema.parse({ limits: { per_tx: "500.00" } }),
        owner_authorization: await ownerAuth(org.owner, h.clock, "policy.loosen", agent.id, {
          limits: { per_tx: "999.00" },
        }),
      },
    });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe("signature_invalid");
    const looser = await putPolicy(h, org, agent.id, { limits: { per_tx: "500.00" } });
    expect(looser.status).toBe(200);
    expect(looser.body.current.version).toBe(1);
    expect(looser.body.pending).toMatchObject({ version: 2, change_kind: "loosen" });
    expect(new Date(looser.body.pending.effective_at).getTime() - h.clock.now().getTime()).toBe(3_600_000);
    const events = await call(h.app, "GET", "/v1/events?type=policy.updated", { token: org.apiKey });
    expect(events.body.data.length).toBeGreaterThan(0);
  });

  it("treats auto-save changes as owner-signed", async () => {
    const agent = await createAgent(h.app, org.apiKey, "p4");
    await putPolicy(h, org, agent.id, { limits: { per_tx: "100.00" } });
    const unsigned = await putPolicy(
      h,
      org,
      agent.id,
      { limits: { per_tx: "100.00" }, auto_save: { income_split: { bps: 1000, to: "treasury" } } },
      false,
    );
    expect(unsigned.status).toBe(403);
  });

  it("rejects semantically invalid policies and agent mismatches", async () => {
    const res = await call(h.app, "PUT", `/v1/agents/${w.agent.id}/policy`, {
      token: w.apiKey,
      body: { policy: { agent: "agt_01J00000000000000000000000", limits: { per_tx: "1.00" } } },
    });
    expect(res.status).toBe(400);
  });

  it("dry-runs payments for principals and agents", async () => {
    const asAgent = await agentCall(h, w.session, "POST", "/v1/policy/check", {
      body: {
        account_id: w.account.id,
        intent: {
          amount: { amount: "2000.00", asset: "USDC" },
          to_address: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.outcome).toBe("deny");
    expect(asAgent.body.id).toMatch(/^dec_/);
    const asPrincipal = await call(h.app, "POST", "/v1/policy/check", {
      token: w.apiKey,
      body: {
        account_id: w.account.id,
        intent: {
          amount: { amount: "5.00", asset: "USDC" },
          to_address: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    expect(asPrincipal.body.outcome).toBe("allow");
    const crossOrg = await call(h.app, "POST", "/v1/policy/check", {
      token: org.apiKey,
      body: { account_id: w.account.id, intent: { amount: { amount: "5.00", asset: "USDC" } } },
    });
    expect(crossOrg.status).toBe(404);
  });

  it("lets agents read their own policy only", async () => {
    expect((await agentCall(h, w.session, "GET", `/v1/agents/${w.agent.id}/policy`)).status).toBe(200);
    const other = await createAgent(h.app, w.apiKey, "sibling");
    expect((await agentCall(h, w.session, "GET", `/v1/agents/${other.id}/policy`)).status).toBe(404);
  });
});

describe("mandates", () => {
  function mandateFor(agentId: string, budget = 2_000_000) {
    const iat = unixSeconds(h.clock.now());
    return {
      vct: "mandate.payment.open.1",
      agent_id: agentId,
      iat,
      exp: iat + 7 * 86_400,
      description: "Buy data under $2",
      constraints: [
        { type: "payment.amount_range", currency: "USDC", max: 1_000_000 },
        { type: "payment.budget", currency: "USDC", max: budget },
      ],
    };
  }

  it("issues a mandate signed by the owner and registers it with the co-signer", async () => {
    const mandate = mandateFor(w.agent.id);
    const owner_authorization = await ownerAuth(w.owner, h.clock, "mandate.issue", w.agent.id, mandate);
    const res = await call(h.app, "POST", "/v1/mandates", {
      token: w.apiKey,
      body: { agent_id: w.agent.id, mandate, owner_authorization },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "active", spent: "0.00", signer: w.owner.address });
    expect(h.cosigner.callsTo("registerMandate")).toContainEqual(
      expect.objectContaining({ mandate_id: res.body.id, agent_id: w.agent.id }),
    );

    const pay = await payAndSign(h, w, {
      amount: { amount: "0.50", asset: "USDC" },
      to: { address: "0x1111111111111111111111111111111111111111" },
      mandate_id: res.body.id,
    });
    expect(pay.body).toMatchObject({ status: "submitted", mandate_id: res.body.id });
    const over = await agentCall(h, w.session, "POST", "/v1/payments", {
      body: {
        account_id: w.account.id,
        amount: { amount: "1.50", asset: "USDC" },
        to: { address: "0x1111111111111111111111111111111111111111" },
        mandate_id: res.body.id,
      },
    });
    expect(over.body.status).toBe("denied");
    expect(over.body.decision.rule_hits.some((r: { rule: string }) => r.rule.startsWith("mandate."))).toBe(
      true,
    );

    const read = await agentCall(h, w.session, "GET", `/v1/mandates/${res.body.id}`);
    expect(read.status).toBe(200);
    const revoked = await call(h.app, "DELETE", `/v1/mandates/${res.body.id}`, { token: w.apiKey });
    expect(revoked.body.status).toBe("revoked");
    expect(h.cosigner.callsTo("revokeMandate")).toContainEqual({ mandateId: res.body.id });
    const after = await agentCall(h, w.session, "POST", "/v1/payments", {
      body: {
        account_id: w.account.id,
        amount: { amount: "0.10", asset: "USDC" },
        to: { address: "0x1111111111111111111111111111111111111111" },
        mandate_id: res.body.id,
      },
    });
    expect(after.status).toBe(422);
    expect(after.body.code).toBe("mandate_invalid");
  });

  it("rejects mandates not signed by the owner or for another agent", async () => {
    const mandate = mandateFor(w.agent.id);
    const wrongSigner = await ownerAuth(org.owner, h.clock, "mandate.issue", w.agent.id, mandate);
    const res = await call(h.app, "POST", "/v1/mandates", {
      token: w.apiKey,
      body: { agent_id: w.agent.id, mandate, owner_authorization: wrongSigner },
    });
    expect(res.status).toBe(403);
    const other = await createAgent(h.app, w.apiKey, "other-agent");
    const mismatched = mandateFor(other.id);
    const auth = await ownerAuth(w.owner, h.clock, "mandate.issue", w.agent.id, mismatched);
    const bad = await call(h.app, "POST", "/v1/mandates", {
      token: w.apiKey,
      body: { agent_id: w.agent.id, mandate: mismatched, owner_authorization: auth },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("mandate_invalid");
  });
});
