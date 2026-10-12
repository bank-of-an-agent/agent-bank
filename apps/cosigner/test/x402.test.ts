import { AuthorizeX402ResultInternal, type AuthorizeX402Internal } from "@agentbank/core";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { ATTACKER, DEFAULT_POLICY, keys, PAYEE, usd, World, type WorldOptions } from "./helpers";

async function withWorld(options: WorldOptions, body: (w: World) => Promise<void>): Promise<void> {
  const w = await World.create(options);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

let counter = 0;

function x402(
  w: World,
  amount: bigint,
  overrides: Partial<AuthorizeX402Internal> = {},
): AuthorizeX402Internal {
  counter += 1;
  return {
    payment_id: `pay_x${counter}`,
    org_id: w.org,
    agent_id: w.agent,
    account_id: w.accountId,
    account_address: w.account,
    chain_id: w.chain.chainId,
    spend_key_address: keys.spendKey.address,
    x402_domain: "api.example-data.com",
    pay_to: PAYEE,
    amount: amount.toString(),
    asset: "USDC",
    ...overrides,
  };
}

describe("x402 authorization (ADR 0001: the spend key signs, the co-signer decides)", () => {
  it("authorizes within policy, reserves the spend, and shares caps with co-signed payments", () =>
    withWorld({ policy: { limits: { per_day: "10.00" } } }, async (w) => {
      const first = await w.client.authorizeX402(x402(w, usd(6)));
      expect(AuthorizeX402ResultInternal.parse(first)).toEqual(first);
      expect(first.decision.outcome).toBe("allow");
      expect((await w.pay(PAYEE, usd(5))).result.decision.outcome).toBe("deny");
      expect((await w.pay(PAYEE, usd(4))).result.decision.outcome).toBe("allow");
      expect((await w.client.authorizeX402(x402(w, usd(0.01)))).decision.outcome).toBe("deny");
      expect((await w.client.audit(0, 1000)).records.some((r) => r.action === "x402.authorized")).toBe(true);
    }));

  it("matches x402 payments by host name against domain allowlists and mandates", () =>
    withWorld({}, async (w) => {
      await w.putPolicy(
        { ...DEFAULT_POLICY, counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"] } },
        null,
      );
      expect((await w.client.authorizeX402(x402(w, usd(1)))).decision.outcome).toBe("allow");
      const other = await w.client.authorizeX402(x402(w, usd(1), { x402_domain: "evil.example.net" }));
      expect(other.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "counterparties.allowlist", effect: "deny" }),
      );
      await w.registerMandate("mdt_x402", [
        { type: "agentbank.x402_domains", allowed: ["api.example-data.com"] },
      ]);
      expect(
        (await w.client.authorizeX402(x402(w, usd(1), { mandate_id: "mdt_x402" }))).decision.outcome,
      ).toBe("allow");
      const transfer = await w.pay(PAYEE, usd(1), 0n, { mandate_id: "mdt_x402" });
      expect(transfer.result.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "mandate.x402_domains", effect: "deny" }),
      );
    }));

  it("is idempotent per payment, refuses a different request under the same id, and pins the spend key", () =>
    withWorld({}, async (w) => {
      const request = x402(w, usd(2));
      const first = await w.client.authorizeX402(request);
      expect(await w.client.authorizeX402(request)).toEqual(first);
      const changed = await w.client.authorizeX402({ ...request, amount: usd(3).toString() });
      expect(changed.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "cosigner.payment_replay", effect: "deny" }),
      );
      const otherKey = await w.client.authorizeX402(x402(w, usd(1), { spend_key_address: ATTACKER }));
      expect(otherKey.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "cosigner.spend_key", effect: "deny" }),
      );
    }));

  it("needs no human approval path: payments needing approval are not authorized", () =>
    withWorld({}, async (w) => {
      await w.putPolicy({ ...DEFAULT_POLICY, approvals: [{ above: "5.00", approvers: 1 }] }, null);
      const result = await w.client.authorizeX402(x402(w, usd(6)));
      expect(result.decision.outcome).toBe("require_approval");
    }));
});

describe("refills of the spend key", () => {
  it("are co-signed only toward the account's pinned spend key", () =>
    withWorld({}, async (w) => {
      const refill = async (to: Address) => {
        const prepared = await w.prepareOrCraft(w.transferCalls(to, usd(5), 0n));
        return w.client.cosign(w.cosignRequest(prepared, { to, amount: usd(5), fee: 0n, kind: "refill" }));
      };
      // No spend key known yet: a refill cannot be verified.
      expect((await refill(keys.spendKey.address)).decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "refill.target", effect: "deny" }),
      );
      await w.client.authorizeX402(x402(w, usd(1)));
      const ok = await refill(keys.spendKey.address);
      expect(ok.decision.outcome).toBe("allow");
      const elsewhere = await refill(ATTACKER);
      expect(elsewhere.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "refill.target", effect: "deny" }),
      );
    }));
});

describe("settlements", () => {
  it("settles (optionally for less), releases failures, and never releases settled spend", () =>
    withWorld({ policy: { limits: { per_day: "10.00" } } }, async (w) => {
      const a = x402(w, usd(4));
      const b = x402(w, usd(4));
      await w.client.authorizeX402(a);
      await w.client.authorizeX402(b);
      await w.client.reportSettlement({
        payment_id: a.payment_id,
        status: "settled",
        amount: usd(1).toString(),
      });
      await w.client.reportSettlement({
        payment_id: a.payment_id,
        status: "settled",
        amount: usd(1).toString(),
      }); // idempotent
      await expect(
        w.client.reportSettlement({ payment_id: a.payment_id, status: "settled", amount: usd(2).toString() }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        w.client.reportSettlement({ payment_id: a.payment_id, status: "failed" }),
      ).rejects.toMatchObject({ code: "invalid_state" });
      await expect(
        w.client.reportSettlement({ payment_id: b.payment_id, status: "settled", amount: usd(5).toString() }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await w.client.reportSettlement({ payment_id: b.payment_id, status: "failed" });
      await w.client.reportSettlement({ payment_id: b.payment_id, status: "failed" }); // idempotent
      // 1 settled + 0 released: 9 of the 10 daily remain.
      expect((await w.client.authorizeX402(x402(w, usd(9)))).decision.outcome).toBe("allow");
      expect((await w.client.authorizeX402(x402(w, usd(0.01)))).decision.outcome).toBe("deny");
      // A late settlement of released spend counts it again.
      await w.client.reportSettlement({ payment_id: b.payment_id, status: "settled" });
      // Unknown payments are recorded and ignored.
      await w.client.reportSettlement({ payment_id: "pay_unknown", status: "failed" });
      const actions = (await w.client.audit(0, 1000)).records.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining(["spend.settled", "spend.released", "settlement.unknown_payment"]),
      );
    }));
});
