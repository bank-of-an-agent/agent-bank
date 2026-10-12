import type { PolicyDocumentInput } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import { diffPolicy, explainDiff } from "@/lib/policy/diff";
import { getIn, prune, setIn, validateDraft } from "@/lib/policy/draft";

const NOW = new Date("2026-10-11T12:00:00Z");

const base: PolicyDocumentInput = {
  asset: "USDC",
  limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
  counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"], new_cooldown_minutes: 60 },
  velocity: { max_per_minute: 30 },
  approvals: [{ above: "100.00", approvers: 1 }],
};

function change(patch: (doc: PolicyDocumentInput) => PolicyDocumentInput) {
  return patch(structuredClone(base));
}

describe("diffPolicy", () => {
  it("labels a lower limit as a tightening that applies immediately without the owner key", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, limits: { ...d.limits, per_day: "150.00" } })),
      NOW,
    );
    expect(diff.kind).toBe("tighten");
    expect(diff.requiresOwner).toBe(false);
    expect(diff.delayed).toBe(false);
    expect(diff.effectiveAt).toEqual(NOW);
    expect(diff.items).toEqual([
      expect.objectContaining({
        path: "limits.per_day",
        direction: "tighten",
        label: "Daily limit (rolling 24 h)",
        before: "200.00 USDC",
        after: "150.00 USDC",
      }),
    ]);
  });

  it("labels a higher limit as a loosening: owner key and a 1-hour delay", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, limits: { ...d.limits, per_tx: "1000.00" } })),
      NOW,
    );
    expect(diff.kind).toBe("loosen");
    expect(diff.requiresOwner).toBe(true);
    expect(diff.delayed).toBe(true);
    expect(diff.effectiveAt.getTime() - NOW.getTime()).toBe(60 * 60 * 1000);
    expect(diff.items[0]).toMatchObject({
      direction: "loosen",
      label: "Per-payment limit",
      after: "1,000.00 USDC",
    });
    expect(explainDiff(diff)).toMatch(/owner key/);
    expect(explainDiff(diff)).toMatch(/60 minutes/);
  });

  it("treats removing a cap as loosening", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, limits: { per_tx: "25.00", per_day: "200.00" } })),
      NOW,
    );
    expect(diff.kind).toBe("loosen");
    expect(diff.items[0]).toMatchObject({
      path: "limits.per_month",
      before: "2,000.00 USDC",
      after: "No limit",
    });
  });

  it("labels each allowlist entry: adding one loosens, removing one tightens", () => {
    const added = diffPolicy(
      base,
      change((d) => ({
        ...d,
        counterparties: { ...d.counterparties, x402_domains: ["api.example-data.com", "api.new.com"] },
      })),
      NOW,
    );
    expect(added.kind).toBe("loosen");
    expect(added.items[0]).toMatchObject({
      label: "Allowlist: x402 domain api.new.com",
      direction: "loosen",
      before: "Not listed",
      after: "Listed",
    });
    const removed = diffPolicy(
      base,
      change((d) => ({ ...d, counterparties: { ...d.counterparties, x402_domains: [] } })),
      NOW,
    );
    expect(removed.kind).toBe("tighten");
    expect(removed.items[0]).toMatchObject({ direction: "tighten", before: "Listed", after: "Not listed" });
  });

  it("classifies a change that tightens and loosens as mixed, which is delayed as a whole", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, limits: { ...d.limits, per_tx: "10.00", per_day: "500.00" } })),
      NOW,
    );
    expect(diff.kind).toBe("mixed");
    expect(diff.requiresOwner).toBe(true);
    expect(diff.delayed).toBe(true);
    expect(diff.items.map((i) => i.direction).sort()).toEqual(["loosen", "tighten"]);
    expect(explainDiff(diff)).toMatch(/treated as a loosening/);
  });

  it("needs the owner for the first policy but applies it immediately", () => {
    const diff = diffPolicy(null, base, NOW);
    expect(diff.kind).toBe("initial");
    expect(diff.requiresOwner).toBe(true);
    expect(diff.delayed).toBe(false);
  });

  it("owner-signs auto-save edits without delaying them", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, auto_save: { excess_sweep: { to: "treasury" } } })),
      NOW,
    );
    expect(diff.kind).toBe("unchanged");
    expect(diff.autoSaveChanged).toBe(true);
    expect(diff.requiresOwner).toBe(true);
    expect(diff.delayed).toBe(false);
    expect(diff.items[0]).toMatchObject({ path: "auto_save.excess_sweep", direction: "neutral" });
  });

  it("counts more approvers or a lower threshold as tightening", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, approvals: [{ above: "50.00", approvers: 2 }] })),
      NOW,
    );
    expect(diff.kind).toBe("tighten");
    expect(diff.items[0]).toMatchObject({ path: "approvals", label: "Approval thresholds" });
  });

  it("reports no changes for an equivalent document", () => {
    const diff = diffPolicy(
      base,
      change((d) => ({ ...d, limits: { ...d.limits, per_tx: "25.000" } })),
      NOW,
    );
    expect(diff.kind).toBe("unchanged");
    expect(diff.items).toHaveLength(0);
    expect(diff.requiresOwner).toBe(false);
  });

  it("refuses an invalid draft like the server", () => {
    expect(() => diffPolicy(base, { limits: { per_tx: 25 } } as unknown as PolicyDocumentInput)).toThrow();
  });
});

describe("policy drafts", () => {
  it("sets and deletes nested values immutably", () => {
    const draft = { limits: { per_tx: "1.00" } };
    const next = setIn(draft, ["limits", "per_day"], "5.00");
    expect(next).toEqual({ limits: { per_tx: "1.00", per_day: "5.00" } });
    expect(draft).toEqual({ limits: { per_tx: "1.00" } });
    expect(setIn(next, ["limits", "per_tx"], undefined)).toEqual({ limits: { per_day: "5.00" } });
    const withRow = setIn({}, ["approvals", 0], { above: "1.00", approvers: 1 });
    expect(getIn(withRow, ["approvals", 0, "approvers"])).toBe(1);
    expect(setIn(withRow, ["approvals", 0], undefined)).toEqual({ approvals: [] });
  });

  it("prunes empty optional sections", () => {
    expect(
      prune({
        velocity: {},
        approvals: [],
        counterparties: { mode: "open", addresses: [], deny: { addresses: [] } },
      }),
    ).toEqual({ counterparties: { mode: "open" } });
  });

  it("validates with the schema and the engine's semantic checks", () => {
    expect(validateDraft({ limits: { per_tx: "25." } })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "limits.per_tx" })],
    });
    const badZone = validateDraft({
      time_windows: [{ days: ["mon"], start: "09:00", end: "17:00", timezone: "Mars/Olympus" }],
    });
    expect(badZone.ok).toBe(false);
    const ok = validateDraft({ limits: { per_tx: "25.00" } });
    expect(ok.ok).toBe(true);
    expect(ok.document).toMatchObject({ asset: "USDC", counterparties: { mode: "open" } });
  });
});
