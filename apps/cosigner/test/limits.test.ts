import { describe, expect, it } from "vitest";
import { ATTACKER, DEFAULT_POLICY, PAYEE, usd, World, type WorldOptions } from "./helpers";

/** Run `body` against a fresh world and always clean up. */
async function withWorld(options: WorldOptions, body: (w: World) => Promise<void>): Promise<void> {
  const w = await World.create(options);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

const SIX_DAYS = { expires_at: new Date(Date.parse("2026-10-11T12:00:00Z") + 6 * 86_400_000).toISOString() };

function rule(
  result: { decision: { rule_hits: { rule: string; effect: string }[] } },
  id: string,
): string | undefined {
  return result.decision.rule_hits.find((h) => h.rule === id)?.effect;
}

describe("amount caps from the co-signer's own spend history", () => {
  it("enforces per-transaction and rolling daily caps, counting reserved spend", () =>
    withWorld({ scope: SIX_DAYS }, async (w) => {
      const big = (await w.pay(PAYEE, usd(150))).result;
      expect(big.signature).toBeNull();
      expect(rule(big, "limits.per_tx")).toBe("deny");
      for (let i = 0; i < 3; i++)
        expect((await w.pay(PAYEE, usd(100))).result.decision.outcome).toBe("allow");
      const over = (await w.pay(PAYEE, usd(0.01))).result;
      expect(rule(over, "limits.per_day")).toBe("deny");
      // Rolling 24 h window (ADR 0010): 23 h later it is still full, after 24 h it has rolled.
      w.clock.advanceSeconds(23 * 3600);
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("deny");
      w.clock.advanceSeconds(3600);
      expect((await w.pay(PAYEE, usd(100))).result.decision.outcome).toBe("allow");
    }));

  it("released (failed) payments stop counting; settled ones keep counting", () =>
    withWorld({ policy: { limits: { per_day: "100.00" } } }, async (w) => {
      const a = await w.pay(PAYEE, usd(60));
      const b = await w.pay(PAYEE, usd(40));
      expect(a.result.decision.outcome).toBe("allow");
      expect(b.result.decision.outcome).toBe("allow");
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("deny");
      await w.client.reportSettlement({ payment_id: a.request.payment_id, status: "failed" });
      await w.client.reportSettlement({ payment_id: b.request.payment_id, status: "settled" });
      expect((await w.pay(PAYEE, usd(60))).result.decision.outcome).toBe("allow");
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("deny");
    }));

  it("enforces the session scope, fees included, as the on-chain hook does", () =>
    withWorld(
      { policy: { limits: { per_tx: "1000.00" } }, scope: { max_per_tx: "200.00", max_per_day: "300.00" } },
      async (w) => {
        expect(rule((await w.pay(PAYEE, usd(250))).result, "session.max_per_tx")).toBe("deny");
        const withFee = (await w.pay(PAYEE, usd(199.99), usd(0.02))).result;
        expect(rule(withFee, "cosigner.session_outflow")).toBe("deny");
        const ok = await w.pay(PAYEE, usd(199.98), usd(0.02));
        expect(ok.result.decision.outcome).toBe("allow");
        expect((await w.submit(ok.prepared, ok.result.signature as `0x${string}`)).status).toBe("succeeded");
        expect(rule((await w.pay(PAYEE, usd(100.01))).result, "cosigner.session_outflow")).toBe("deny");
      },
    ));

  it("serializes concurrent co-signatures per agent so they cannot jointly exceed a cap", () =>
    withWorld({ policy: { limits: { per_day: "300.00" } } }, async (w) => {
      // Six distinct operations of ~70 USDC each (amounts differ by a micro-unit so every hash differs).
      const amounts = Array.from({ length: 6 }, (_, i) => usd(70) + BigInt(i));
      const prepared = await Promise.all(amounts.map((a) => w.prepare(w.transferCalls(PAYEE, a, 0n))));
      const requests = prepared.map((p, i) =>
        w.cosignRequest(p, { to: PAYEE, amount: amounts[i] as bigint, fee: 0n }, { payment_id: `pay_c${i}` }),
      );
      const results = await Promise.all(requests.map((r) => w.client.cosign(r)));
      const allowed = results.filter((r) => r.decision.outcome === "allow").length;
      expect(allowed).toBe(4);
      expect(results.filter((r) => r.signature !== null)).toHaveLength(4);
    }));
});

describe("velocity, counterparties and time", () => {
  it("enforces velocity limits on the co-signer's own counts", () =>
    withWorld({}, async (w) => {
      await w.putPolicy({ ...DEFAULT_POLICY, velocity: { max_per_minute: 2 } }, null);
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("allow");
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("allow");
      expect(rule((await w.pay(PAYEE, usd(1))).result, "velocity.per_minute")).toBe("deny");
      w.clock.advanceSeconds(61);
      expect((await w.pay(PAYEE, usd(1))).result.decision.outcome).toBe("allow");
    }));

  it("enforces allowlists against the decoded payee", () =>
    withWorld({}, async (w) => {
      await w.putPolicy(
        { ...DEFAULT_POLICY, counterparties: { mode: "allowlist", addresses: [PAYEE] } },
        null,
      );
      expect((await w.pay(PAYEE, usd(5))).result.decision.outcome).toBe("allow");
      expect(rule((await w.pay(ATTACKER, usd(5))).result, "counterparties.allowlist")).toBe("deny");
    }));

  it("cools down new counterparties from their first sight, including denied attempts, with retry_at", () =>
    withWorld({}, async (w) => {
      await w.putPolicy(
        { ...DEFAULT_POLICY, counterparties: { mode: "open", new_cooldown_minutes: 60 } },
        null,
      );
      const first = (await w.pay(PAYEE, usd(5))).result;
      expect(rule(first, "counterparties.cooldown")).toBe("deny");
      expect(first.decision.retry_at).toBe(new Date(w.clock.now().getTime() + 3600_000).toISOString());
      w.clock.advanceSeconds(30 * 60);
      expect((await w.pay(PAYEE, usd(5))).result.decision.retry_at).toBe(first.decision.retry_at);
      w.clock.advanceSeconds(30 * 60);
      expect((await w.pay(PAYEE, usd(5))).result.decision.outcome).toBe("allow");
    }));

  it("dry runs report the same decisions without reserving spend", () =>
    withWorld({ policy: { limits: { per_day: "50.00" } } }, async (w) => {
      const intent = {
        kind: "transfer" as const,
        amount: usd(40).toString(),
        asset: "USDC" as const,
        counterparty: { address: PAYEE },
      };
      const base = {
        org_id: w.org,
        agent_id: w.agent,
        account_id: w.accountId,
        account_address: w.account,
        chain_id: w.chain.chainId,
      };
      for (let i = 0; i < 3; i++)
        expect((await w.client.evaluate({ ...base, intent })).outcome).toBe("allow");
      expect((await w.pay(PAYEE, usd(40))).result.decision.outcome).toBe("allow");
      const after = await w.client.evaluate({ ...base, intent, session_id: w.sessionId });
      expect(after.outcome).toBe("deny");
      expect(after.rule_hits.some((h) => h.rule === "limits.per_day" && h.effect === "deny")).toBe(true);
      expect(after.rule_hits.some((h) => h.rule === "session.max_per_tx")).toBe(true);
    }));
});

describe("mandates, approvals and owner thresholds", () => {
  it("enforces a mandate's budget across payments; released spend is returned to the budget", () =>
    withWorld({}, async (w) => {
      await w.registerMandate("mdt_budget", [
        { type: "payment.budget", currency: "USDC", max: usd(50).toString() },
      ]);
      const first = await w.pay(PAYEE, usd(30), 0n, { mandate_id: "mdt_budget" });
      expect(first.result.decision.outcome).toBe("allow");
      expect(
        rule((await w.pay(PAYEE, usd(30), 0n, { mandate_id: "mdt_budget" })).result, "mandate.budget"),
      ).toBe("deny");
      await w.client.reportSettlement({ payment_id: first.request.payment_id, status: "failed" });
      expect((await w.pay(PAYEE, usd(30), 0n, { mandate_id: "mdt_budget" })).result.decision.outcome).toBe(
        "allow",
      );
      await w.client.revokeMandate("mdt_budget");
      expect(
        rule((await w.pay(PAYEE, usd(1), 0n, { mandate_id: "mdt_budget" })).result, "cosigner.mandate"),
      ).toBe("deny");
      expect(
        rule((await w.pay(PAYEE, usd(1), 0n, { mandate_id: "mdt_unknown" })).result, "cosigner.mandate"),
      ).toBe("deny");
    }));

  it("enforces a mandate's payees and occurrences", () =>
    withWorld({}, async (w) => {
      await w.registerMandate("mdt_payee", [
        { type: "payment.allowed_payees", allowed: [{ id: PAYEE, name: "Data vendor" }] },
        { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 2 },
      ]);
      expect(
        rule(
          (await w.pay(ATTACKER, usd(1), 0n, { mandate_id: "mdt_payee" })).result,
          "mandate.allowed_payees",
        ),
      ).toBe("deny");
      expect((await w.pay(PAYEE, usd(1), 0n, { mandate_id: "mdt_payee" })).result.decision.outcome).toBe(
        "allow",
      );
      expect((await w.pay(PAYEE, usd(1), 0n, { mandate_id: "mdt_payee" })).result.decision.outcome).toBe(
        "allow",
      );
      expect(
        rule((await w.pay(PAYEE, usd(1), 0n, { mandate_id: "mdt_payee" })).result, "mandate.max_occurrences"),
      ).toBe("deny");
    }));

  it("require_approval co-signs only with enough distinct approvers (ADR 0012)", () =>
    withWorld({}, async (w) => {
      await w.putPolicy(
        {
          ...DEFAULT_POLICY,
          approvals: [
            { above: "50.00", approvers: 1 },
            { above: "90.00", approvers: 2 },
          ],
        },
        null,
      );
      const pending = (await w.pay(PAYEE, usd(60))).result;
      expect(pending.decision.outcome).toBe("require_approval");
      expect(pending.decision.approvers_required).toBe(1);
      expect(pending.signature).toBeNull();
      const approved = (
        await w.pay(PAYEE, usd(60), 0n, { approval: { approval_id: "apr_1", approved_by: ["mem_1"] } })
      ).result;
      expect(approved.decision.outcome).toBe("allow");
      expect(approved.signature).not.toBeNull();
      const duplicate = (
        await w.pay(PAYEE, usd(95), 0n, {
          approval: { approval_id: "apr_2", approved_by: ["mem_1", "mem_1 "] },
        })
      ).result;
      expect(duplicate.decision.outcome).toBe("require_approval");
      expect(duplicate.signature).toBeNull();
      const two = (
        await w.pay(PAYEE, usd(95), 0n, {
          approval: { approval_id: "apr_3", approved_by: ["mem_1", "mem_2"] },
        })
      ).result;
      expect(two.decision.outcome).toBe("allow");
      // An approval never overrides a hard limit.
      const overCap = (
        await w.pay(PAYEE, usd(150), 0n, {
          approval: { approval_id: "apr_4", approved_by: ["mem_1", "mem_2"] },
        })
      ).result;
      expect(overCap.decision.outcome).toBe("deny");
    }));

  it("require_owner never co-signs: the owner signs such payments alone", () =>
    withWorld({}, async (w) => {
      await w.putPolicy({ ...DEFAULT_POLICY, require_owner_above: "80.00" }, null);
      const result = (
        await w.pay(PAYEE, usd(90), 0n, { approval: { approval_id: "apr_1", approved_by: ["a", "b", "c"] } })
      ).result;
      expect(result.decision.outcome).toBe("require_owner");
      expect(result.signature).toBeNull();
      expect((await w.pay(PAYEE, usd(80))).result.decision.outcome).toBe("allow");
    }));
});
