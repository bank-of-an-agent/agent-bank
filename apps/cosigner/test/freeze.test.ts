import { EffectiveAtResponse } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import { keys, PAYEE, usd, World } from "./helpers";

async function withWorld(body: (w: World) => Promise<void>): Promise<void> {
  const w = await World.create();
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

const HOUR_MS = 3600_000;

async function canPay(w: World): Promise<boolean> {
  return (await w.pay(PAYEE, usd(1))).result.decision.outcome === "allow";
}

describe("freezes", () => {
  it("freezing an agent refuses everything immediately, dry runs included", () =>
    withWorld(async (w) => {
      expect(await canPay(w)).toBe(true);
      await w.client.freeze({ scope: "agent", id: w.agent, reason: "anomaly" });
      await w.client.freeze({ scope: "agent", id: w.agent, reason: "anomaly again" }); // idempotent
      const refused = (await w.pay(PAYEE, usd(1))).result;
      expect(refused.signature).toBeNull();
      expect(refused.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "agent.frozen", effect: "deny" }),
      );
      const dryRun = await w.client.evaluate({
        org_id: w.org,
        agent_id: w.agent,
        account_id: w.accountId,
        account_address: w.account,
        chain_id: w.chain.chainId,
        intent: { kind: "transfer", amount: "1000000", asset: "USDC", counterparty: { address: PAYEE } },
      });
      expect(dryRun.outcome).toBe("deny");
      const actions = (await w.client.audit(0, 1000)).records.map((r) => r.action);
      expect(actions).toContain("freeze");
      expect(actions).toContain("freeze.repeated");
    }));

  it("unfreezing needs the owner's agent.unfreeze authorization and takes effect after one hour", () =>
    withWorld(async (w) => {
      await w.client.freeze({ scope: "agent", id: w.agent, reason: "anomaly" });
      // Wrong signer, wrong action or subject, wrong payload: all refused.
      await expect(
        w.client.unfreeze(await w.unfreezeRequest("agent", w.agent, "ok", keys.attacker)),
      ).rejects.toMatchObject({ code: "owner_signature_required" });
      const orgAction = await w.unfreezeRequest("org", w.org);
      await expect(w.client.unfreeze({ ...orgAction, scope: "agent", id: w.agent })).rejects.toMatchObject({
        code: "signature_invalid",
      });
      const forOther = await w.unfreezeRequest("agent", w.agent, "ok");
      await expect(w.client.unfreeze({ ...forOther, reason: "different reason" })).rejects.toMatchObject({
        code: "signature_invalid",
      });

      const scheduled = EffectiveAtResponse.parse(
        await w.client.unfreeze(await w.unfreezeRequest("agent", w.agent)),
      );
      expect(Date.parse(scheduled.effective_at) - w.clock.now().getTime()).toBe(HOUR_MS);
      expect(await canPay(w)).toBe(false);
      w.clock.advance(HOUR_MS - 1000);
      expect(await canPay(w)).toBe(false);
      w.clock.advance(1000);
      expect(await canPay(w)).toBe(true);
    }));

  it("freezing again while an unfreeze is pending cancels the unfreeze", () =>
    withWorld(async (w) => {
      await w.client.freeze({ scope: "agent", id: w.agent, reason: "anomaly" });
      const request = await w.unfreezeRequest("agent", w.agent);
      const first = await w.client.unfreeze(request);
      expect(await w.client.unfreeze(request)).toEqual(first); // identical retry
      w.clock.advance(2 * 60_000);
      await w.client.freeze({ scope: "agent", id: w.agent, reason: "new anomaly" });
      // The cancelled authorization cannot be replayed to lift the new freeze, even while still valid.
      await expect(w.client.unfreeze(request)).rejects.toMatchObject({ code: "conflict" });
      w.clock.advance(2 * HOUR_MS);
      expect(await canPay(w)).toBe(false);
      const fresh = await w.client.unfreeze(await w.unfreezeRequest("agent", w.agent, "reviewed again"));
      w.clock.set(Date.parse(fresh.effective_at));
      expect(await canPay(w)).toBe(true);
      expect((await w.client.audit(0, 1000)).records.map((r) => r.action)).toContain(
        "freeze.unfreeze_cancelled",
      );
    }));

  it("an org freeze stops every agent of the org; lifting it takes org.unfreeze and an hour", () =>
    withWorld(async (w) => {
      await w.client.freeze({ scope: "org", id: w.org, reason: "mass freeze" });
      const refused = (await w.pay(PAYEE, usd(1))).result;
      expect(refused.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "org.frozen", effect: "deny" }),
      );
      await expect(
        w.client.unfreeze({ ...(await w.unfreezeRequest("agent", w.org)), scope: "org" }),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      const { effective_at } = await w.client.unfreeze(await w.unfreezeRequest("org", w.org));
      w.clock.set(Date.parse(effective_at));
      expect(await canPay(w)).toBe(true);
    }));

  it("a session freeze stops that session; it is lifted like an agent's", () =>
    withWorld(async (w) => {
      await w.client.freeze({ scope: "session", id: w.sessionId, reason: "leaked key?" });
      const refused = (await w.pay(PAYEE, usd(1))).result;
      expect(refused.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "cosigner.session_frozen", effect: "deny" }),
      );
      const { effective_at } = await w.client.unfreeze(await w.unfreezeRequest("session", w.sessionId));
      w.clock.set(Date.parse(effective_at));
      expect(await canPay(w)).toBe(true);
    }));

  it("freezes unknown targets; refuses to unfreeze unknown or unfrozen ones", () =>
    withWorld(async (w) => {
      await w.client.freeze({ scope: "agent", id: "agt_01JZZZZZZZZZZZZZZZZZZZZZZZ", reason: "pre-emptive" });
      await expect(
        w.client.unfreeze(await w.unfreezeRequest("agent", "agt_01JZZZZZZZZZZZZZZZZZZZZZZZ")),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(w.client.unfreeze(await w.unfreezeRequest("agent", w.agent))).rejects.toMatchObject({
        code: "invalid_state",
      });
      await expect(
        w.client.unfreeze({ ...(await w.unfreezeRequest("agent", w.agent)), chain_id: 84532 }),
      ).rejects.toMatchObject({ code: "unsupported_chain" });
    }));
});
