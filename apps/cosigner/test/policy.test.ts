import {
  ownerPayloads,
  PolicyDocumentSchema,
  PolicyStateInternal,
  PolicyVersionInternal,
  type OwnerAuthorization,
  type PolicyDocumentInput,
} from "@agentbank/core";
import type { PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, keys, PAYEE, signOwnerAction, usd, World, type WorldOptions } from "./helpers";

async function withWorld(options: WorldOptions, body: (w: World) => Promise<void>): Promise<void> {
  const w = await World.create(options);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

const HOUR = 3600;

/** Sign `policy.loosen` over a document (parsed, as core's `ownerPayloads` prescribes). */
function signPolicy(
  w: World,
  policy: PolicyDocumentInput,
  signer: PrivateKeyAccount = keys.owner,
  opts: { issuedAt?: number; ttl?: number; chainId?: number } = {},
): Promise<OwnerAuthorization> {
  return signOwnerAction(
    signer,
    opts.chainId ?? w.chain.chainId,
    ownerPayloads.policyLoosen(w.agent, PolicyDocumentSchema.parse(policy)),
    opts.issuedAt ?? w.now(),
    opts.ttl,
  );
}

function put(
  w: World,
  policy: PolicyDocumentInput,
  owner_authorization?: OwnerAuthorization,
  ownerAddress = keys.owner.address,
) {
  return w.client.putPolicy({
    org_id: w.org,
    agent_id: w.agent,
    chain_id: w.chain.chainId,
    owner_address: ownerAddress,
    policy: PolicyDocumentSchema.parse(policy),
    ...(owner_authorization ? { owner_authorization } : {}),
  });
}

const LOOSER: PolicyDocumentInput = {
  limits: { per_tx: "150.00", per_day: "300.00", per_week: "1000.00", per_month: "3000.00" },
};
const TIGHTER: PolicyDocumentInput = {
  limits: { per_tx: "50.00", per_day: "300.00", per_week: "1000.00", per_month: "3000.00" },
};

describe("the first policy", () => {
  it("needs the owner's authorization and applies immediately", () =>
    withWorld({ policy: null }, async (w) => {
      expect(await w.client.getPolicy(w.agent)).toEqual({ current: null, pending: null });
      // Without a policy the agent can spend nothing.
      expect(
        (await w.pay(PAYEE, usd(1))).result.decision.rule_hits.some((h) => h.rule === "policy.missing"),
      ).toBe(true);
      await expect(put(w, DEFAULT_POLICY)).rejects.toMatchObject({
        code: "owner_signature_required",
        status: 403,
      });
      const v1 = await put(w, DEFAULT_POLICY, await signPolicy(w, DEFAULT_POLICY));
      expect(PolicyVersionInternal.parse(v1)).toEqual(v1);
      expect(v1).toMatchObject({ version: 1, change_kind: "initial", signed_by: keys.owner.address });
      expect(v1.effective_at).toBe(w.clock.now().toISOString());
      const state = PolicyStateInternal.parse(await w.client.getPolicy(w.agent));
      expect(state.current?.version).toBe(1);
      expect(state.pending).toBeNull();
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("allow");
    }));
});

describe("asymmetric changes", () => {
  it("applies a tightening immediately without a signature", () =>
    withWorld({}, async (w) => {
      const v2 = await put(w, TIGHTER);
      expect(v2).toMatchObject({ version: 2, change_kind: "tighten", signed_by: null });
      expect(v2.effective_at).toBe(w.clock.now().toISOString());
      expect((await w.pay(PAYEE, usd(60))).result.decision.outcome).toBe("deny");
    }));

  it("rejects a loosening without a valid owner authorization", () =>
    withWorld({}, async (w) => {
      await expect(put(w, LOOSER)).rejects.toMatchObject({ code: "owner_signature_required" });
      // Signed by someone else (e.g. a phished admin's key).
      await expect(put(w, LOOSER, await signPolicy(w, LOOSER, keys.attacker))).rejects.toMatchObject({
        code: "owner_signature_required",
      });
      // The owner signed a different document.
      const other = { limits: { ...(LOOSER.limits as object), per_tx: "149.00" } };
      await expect(put(w, LOOSER, await signPolicy(w, other))).rejects.toMatchObject({
        code: "signature_invalid",
      });
      // Expired, or valid for too long, or for another chain.
      await expect(
        put(w, LOOSER, await signPolicy(w, LOOSER, keys.owner, { issuedAt: w.now() - 1000 })),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      await expect(
        put(w, LOOSER, await signPolicy(w, LOOSER, keys.owner, { ttl: 3600 })),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      await expect(
        put(w, LOOSER, await signPolicy(w, LOOSER, keys.owner, { chainId: 84532 })),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      // A caller naming another "owner" for the org is refused outright: the owner key is pinned.
      await expect(
        put(w, LOOSER, await signPolicy(w, LOOSER, keys.attacker), keys.attacker.address),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await w.client.getPolicy(w.agent)).pending).toBeNull();
    }));

  it("makes a signed loosening effective after exactly one hour (pending until then)", () =>
    withWorld({}, async (w) => {
      const v2 = await put(w, LOOSER, await signPolicy(w, LOOSER));
      expect(v2).toMatchObject({ version: 2, change_kind: "loosen", signed_by: keys.owner.address });
      expect(v2.effective_at).toBe(new Date(w.clock.now().getTime() + HOUR * 1000).toISOString());
      const state = await w.client.getPolicy(w.agent);
      expect(state.current?.version).toBe(1);
      expect(state.pending?.version).toBe(2);
      expect((await w.pay(PAYEE, usd(120))).result.decision.outcome).toBe("deny");
      w.clock.advanceSeconds(HOUR - 1);
      expect((await w.pay(PAYEE, usd(120))).result.decision.outcome).toBe("deny");
      w.clock.advanceSeconds(1);
      expect((await w.pay(PAYEE, usd(120))).result.decision.outcome).toBe("allow");
      const after = await w.client.getPolicy(w.agent);
      expect(after.current?.version).toBe(2);
      expect(after.pending).toBeNull();
    }));

  it("a tightening while a loosening is pending cancels the loosening for good", () =>
    withWorld({}, async (w) => {
      await put(w, LOOSER, await signPolicy(w, LOOSER));
      w.clock.advanceSeconds(10 * 60);
      const v3 = await put(w, TIGHTER);
      expect(v3).toMatchObject({ version: 3, change_kind: "tighten" });
      expect(await w.client.getPolicy(w.agent)).toMatchObject({ current: { version: 3 }, pending: null });
      w.clock.advanceSeconds(2 * HOUR);
      expect((await w.client.getPolicy(w.agent)).current?.version).toBe(3);
      expect((await w.pay(PAYEE, usd(120))).result.decision.outcome).toBe("deny");
      expect((await w.pay(PAYEE, usd(60))).result.decision.outcome).toBe("deny");
      expect((await w.pay(PAYEE, usd(50))).result.decision.outcome).toBe("allow");
      const audit = await w.client.audit(0, 1000);
      const v3Record = audit.records.find(
        (r) => r.action === "policy.version" && (r.payload as { version: number }).version === 3,
      );
      expect(
        (v3Record?.payload as { cancelled_pending_versions: number[] }).cancelled_pending_versions,
      ).toEqual([2]);
    }));

  it("re-submitting the pending document changes nothing; re-asserting the policy in force cancels the pending one", () =>
    withWorld({}, async (w) => {
      const pending = await put(w, LOOSER, await signPolicy(w, LOOSER));
      w.clock.advanceSeconds(20 * 60);
      // Same document again (even unsigned): the scheduled version, delay not restarted.
      expect(await put(w, LOOSER)).toEqual(pending);
      const reassert = await put(w, DEFAULT_POLICY);
      expect(reassert).toMatchObject({ version: 3, change_kind: "unchanged", signed_by: null });
      expect((await w.client.getPolicy(w.agent)).pending).toBeNull();
      // With nothing pending, re-submitting the policy in force is a no-op.
      expect(await put(w, DEFAULT_POLICY)).toEqual(reassert);
    }));

  it("mixed changes need the owner's signature and the delay", () =>
    withWorld({}, async (w) => {
      const mixed: PolicyDocumentInput = {
        ...DEFAULT_POLICY,
        limits: { per_tx: "150.00", per_day: "200.00", per_week: "1000.00", per_month: "3000.00" },
      };
      await expect(put(w, mixed)).rejects.toMatchObject({ code: "owner_signature_required" });
      const v2 = await put(w, mixed, await signPolicy(w, mixed));
      expect(v2.change_kind).toBe("mixed");
      expect(Date.parse(v2.effective_at) - w.clock.now().getTime()).toBe(HOUR * 1000);
    }));

  it("auto-save changes are owner-signed but take effect immediately", () =>
    withWorld({}, async (w) => {
      const saving: PolicyDocumentInput = {
        ...DEFAULT_POLICY,
        auto_save: { income_split: { bps: 1000, to: "treasury" } },
      };
      await expect(put(w, saving)).rejects.toMatchObject({
        code: "owner_signature_required",
        message: expect.stringMatching(/Auto-save/),
      });
      const v2 = await put(w, saving, await signPolicy(w, saving));
      expect(v2).toMatchObject({ change_kind: "unchanged", signed_by: keys.owner.address });
      expect(v2.effective_at).toBe(w.clock.now().toISOString());
    }));

  it("owner authorizations are single-use", () =>
    withWorld({}, async (w) => {
      const auth = await signPolicy(w, LOOSER);
      await put(w, LOOSER, auth);
      await put(w, TIGHTER); // cancels the pending loosening
      await expect(put(w, LOOSER, auth)).rejects.toMatchObject({ code: "conflict" });
      // Re-signing the very same message is the same authorization (same EIP-712 digest)...
      await expect(put(w, LOOSER, await signPolicy(w, LOOSER))).rejects.toMatchObject({ code: "conflict" });
      // ...a new authorization (new issue time) works.
      w.clock.advanceSeconds(1);
      await put(w, LOOSER, await signPolicy(w, LOOSER));
      expect((await w.client.getPolicy(w.agent)).pending?.change_kind).toBe("loosen");
    }));

  it("rejects documents naming another agent and invalid documents", () =>
    withWorld({}, async (w) => {
      await expect(put(w, { ...TIGHTER, agent: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0" })).rejects.toMatchObject({
        code: "invalid_request",
      });
      const invalid = await w.inject({
        method: "POST",
        url: "/internal/v1/policies",
        body: JSON.stringify({
          org_id: w.org,
          agent_id: w.agent,
          chain_id: w.chain.chainId,
          owner_address: keys.owner.address,
          policy: {
            ...TIGHTER,
            time_windows: [{ days: ["mon"], start: "09:00", end: "17:00", timezone: "Mars/Olympus" }],
          },
        }),
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: "invalid_request" });
    }));
});
