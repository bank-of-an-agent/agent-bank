import { LOOSENING_DELAY_SECONDS, type PolicyDocumentInput } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import {
  classifyChange,
  effectiveAt,
  requiresOwnerSignature,
  requiresOwnerSignatureForChange,
  type ChangeKind,
} from "../src";
import { ADDR, AGENT_ID, DESIGN_EXAMPLE, DOMAIN, NOW, OTHER_AGENT_ID } from "./helpers";

const base: PolicyDocumentInput = {
  limits: { per_tx: "25.00", per_day: "200.00" },
  counterparties: { mode: "allowlist", addresses: [ADDR.alice, ADDR.bob], x402_domains: [DOMAIN] },
  velocity: { max_per_minute: 10 },
  approvals: [{ above: "100.00", approvers: 1 }],
};

function kindOf(prev: PolicyDocumentInput | null, next: PolicyDocumentInput): ChangeKind {
  return classifyChange(prev, next).kind;
}

function paths(prev: PolicyDocumentInput, next: PolicyDocumentInput): string[] {
  return classifyChange(prev, next).changes.map((c) => `${c.direction}:${c.path}`);
}

describe("classifyChange", () => {
  it("classifies the first policy as initial", () => {
    expect(classifyChange(null, DESIGN_EXAMPLE)).toEqual({ kind: "initial", changes: [], neutral: [] });
  });

  it("classifies identical and equivalent documents as unchanged", () => {
    expect(kindOf(base, base)).toBe("unchanged");
    expect(
      kindOf(base, {
        ...base,
        limits: { per_tx: "25", per_day: "200.000000" },
        counterparties: {
          mode: "allowlist",
          addresses: [ADDR.bob.toUpperCase().replace("0X", "0x"), ADDR.alice],
          x402_domains: [DOMAIN],
        },
      }),
    ).toBe("unchanged");
  });

  it("treats auto_save changes as neutral", () => {
    const result = classifyChange(base, {
      ...base,
      $schema: "agentbank.policy.v1",
      auto_save: {
        income_split: { bps: 500, to: "treasury" },
        round_up: { to_nearest: "1", to: "treasury" },
      },
    });
    expect(result.kind).toBe("unchanged");
    expect(result.neutral).toEqual(["auto_save.income_split", "auto_save.round_up", "$schema"]);
  });

  it.each<[string, PolicyDocumentInput, string[]]>([
    [
      "a lower per_tx",
      { ...base, limits: { per_tx: "20.00", per_day: "200.00" } },
      ["tighten:limits.per_tx"],
    ],
    [
      "a new weekly cap",
      { ...base, limits: { ...base.limits, per_week: "500" } },
      ["tighten:limits.per_week"],
    ],
    [
      "removing an allowlisted address",
      { ...base, counterparties: { mode: "allowlist", addresses: [ADDR.alice], x402_domains: [DOMAIN] } },
      [`tighten:counterparties.allowlist.addresses[${ADDR.bob}]`],
    ],
    [
      "adding a denylist entry",
      { ...base, counterparties: { ...base.counterparties, deny: { agent_ids: [OTHER_AGENT_ID] } } },
      [`tighten:counterparties.denylist.agent_ids[${OTHER_AGENT_ID}]`],
    ],
    [
      "a longer cooling period",
      { ...base, counterparties: { ...base.counterparties, new_cooldown_minutes: 30 } },
      ["tighten:counterparties.new_cooldown_minutes"],
    ],
    [
      "a lower velocity",
      { ...base, velocity: { max_per_minute: 5, max_per_hour: 100 } },
      ["tighten:velocity.max_per_minute", "tighten:velocity.max_per_hour"],
    ],
    [
      "a lower approval threshold",
      { ...base, approvals: [{ above: "50.00", approvers: 1 }] },
      ["tighten:approvals"],
    ],
    ["more approvers", { ...base, approvals: [{ above: "100.00", approvers: 2 }] }, ["tighten:approvals"]],
    [
      "an extra approval tier",
      { ...base, approvals: [...(base.approvals ?? []), { above: "1000.00", approvers: 2 }] },
      ["tighten:approvals"],
    ],
    ["an owner threshold", { ...base, require_owner_above: "1000.00" }, ["tighten:require_owner_above"]],
    [
      "fewer allowed kinds",
      { ...base, allowed_kinds: ["transfer", "x402", "escrow", "stream", "payout"] },
      ["tighten:allowed_kinds[refill]"],
    ],
    [
      "narrower time windows",
      { ...base, time_windows: [{ days: ["mon"], start: "09:00", end: "17:00" }] },
      ["tighten:time_windows"],
    ],
    ["a lower max balance", { ...base, max_balance: "100.00" }, ["tighten:max_balance"]],
    ["binding to an agent", { ...base, agent: AGENT_ID }, ["tighten:agent"]],
    [
      "a new per-counterparty cap",
      {
        ...base,
        counterparties: { ...base.counterparties, caps: [{ match: { x402_domain: DOMAIN }, per_day: "5" }] },
      },
      [`tighten:counterparties.caps[x402_domain:${DOMAIN}].per_day`],
    ],
  ])("classifies %s as tighten", (_name, next, expected) => {
    const result = classifyChange(base, next);
    expect(result.kind).toBe("tighten");
    expect(result.changes.map((c) => `${c.direction}:${c.path}`)).toEqual(expected);
  });

  it.each<[string, PolicyDocumentInput, PolicyDocumentInput]>([
    ["a higher per_tx", base, { ...base, limits: { per_tx: "30.00", per_day: "200.00" } }],
    ["removing a cap entirely", base, { ...base, limits: { per_tx: "25.00" } }],
    [
      "adding an allowlist entry",
      base,
      { ...base, counterparties: { ...base.counterparties, addresses: [ADDR.alice, ADDR.bob, ADDR.carol] } },
    ],
    ["switching allowlist to open", base, { ...base, counterparties: { mode: "open" } }],
    ["removing velocity", base, { ...base, velocity: undefined }],
    ["fewer approvers", { ...base, approvals: [{ above: "100.00", approvers: 2 }] }, base],
    ["removing approvals", base, { ...base, approvals: undefined }],
    ["unbinding the agent", { ...base, agent: AGENT_ID }, base],
    [
      "a higher owner threshold",
      { ...base, require_owner_above: "10" },
      { ...base, require_owner_above: "20" },
    ],
    [
      "removing a denylist entry",
      { ...base, counterparties: { ...base.counterparties, deny: { addresses: [ADDR.mallory] } } },
      base,
    ],
    [
      "a shorter cooling period",
      { ...base, counterparties: { ...base.counterparties, new_cooldown_minutes: 30 } },
      base,
    ],
    [
      "removing a counterparty cap",
      {
        ...base,
        counterparties: { ...base.counterparties, caps: [{ match: { address: ADDR.alice }, per_tx: "1" }] },
      },
      base,
    ],
    ["allowing all kinds again", { ...base, allowed_kinds: ["x402"] }, base],
    [
      "wider time windows",
      { ...base, time_windows: [{ days: ["mon"], start: "09:00", end: "17:00" }] },
      base,
    ],
  ])("classifies %s as loosen", (_name, prev, next) => {
    expect(kindOf(prev, next)).toBe("loosen");
    expect(requiresOwnerSignature(kindOf(prev, next))).toBe(true);
  });

  it("classifies changes in both directions as mixed", () => {
    const next = { ...base, limits: { per_tx: "10.00", per_day: "300.00" } };
    expect(paths(base, next)).toEqual(["tighten:limits.per_tx", "loosen:limits.per_day"]);
    expect(kindOf(base, next)).toBe("mixed");
    expect(kindOf({ agent: AGENT_ID }, { agent: OTHER_AGENT_ID })).toBe("mixed");
  });

  it("classifies open → allowlist as tighten only when existing denials stay denied", () => {
    const denyBob = { counterparties: { mode: "denylist" as const, addresses: [ADDR.bob] } };
    expect(
      paths(denyBob, {
        counterparties: { mode: "allowlist", addresses: [ADDR.alice], deny: { addresses: [ADDR.bob] } },
      }),
    ).toEqual(["tighten:counterparties.mode"]);
    // Dropping the denial while allowlisting: a payee with alice's agent id and bob's address becomes payable.
    expect(paths(denyBob, { counterparties: { mode: "allowlist", addresses: [ADDR.alice] } })).toEqual([
      `loosen:counterparties.denylist.addresses[${ADDR.bob}]`,
      "tighten:counterparties.mode",
    ]);
    expect(kindOf({}, { counterparties: { mode: "allowlist", x402_domains: [DOMAIN] } })).toBe("tighten");
  });

  it("compares open and denylist modes by their effective denylists", () => {
    expect(kindOf({}, { counterparties: { mode: "denylist" } })).toBe("unchanged");
    expect(kindOf({}, { counterparties: { mode: "denylist", x402_domains: ["evil.example"] } })).toBe(
      "tighten",
    );
    expect(
      kindOf(
        { counterparties: { mode: "denylist", x402_domains: ["evil.example"] } },
        { counterparties: { mode: "open", deny: { x402_domains: ["evil.example"] } } },
      ),
    ).toBe("unchanged");
    expect(kindOf({ counterparties: { mode: "denylist", x402_domains: ["evil.example"] } }, {})).toBe(
      "loosen",
    );
  });

  it("combines repeated caps for one counterparty before comparing", () => {
    const twice: PolicyDocumentInput = {
      counterparties: {
        caps: [
          { match: { address: ADDR.alice }, per_tx: "5" },
          { match: { address: ADDR.alice.toUpperCase().replace("0X", "0x") }, per_tx: "3", per_month: "9" },
        ],
      },
    };
    const once: PolicyDocumentInput = {
      counterparties: { caps: [{ match: { address: ADDR.alice }, per_tx: "3", per_month: "9" }] },
    };
    expect(kindOf(twice, once)).toBe("unchanged");
  });

  it("detects time-window changes across zones", () => {
    const utc: PolicyDocumentInput = { time_windows: [{ days: ["mon"], start: "13:00", end: "22:00" }] };
    const ny: PolicyDocumentInput = {
      time_windows: [{ days: ["mon"], start: "09:00", end: "17:00", timezone: "America/New_York" }],
    };
    expect(kindOf(utc, ny)).toBe("tighten");
    expect(kindOf(ny, utc)).toBe("loosen");
  });

  it("rejects invalid documents", () => {
    expect(() => classifyChange(base, { limits: { per_tx: 5 } } as never)).toThrow();
    expect(() => classifyChange({ surprise: 1 } as never, base)).toThrow();
  });
});

describe("requiresOwnerSignature / effectiveAt", () => {
  it("requires the owner for initial, loosen and mixed changes", () => {
    expect(requiresOwnerSignature("initial")).toBe(true);
    expect(requiresOwnerSignature("loosen")).toBe(true);
    expect(requiresOwnerSignature("mixed")).toBe(true);
    expect(requiresOwnerSignature("tighten")).toBe(false);
    expect(requiresOwnerSignature("unchanged")).toBe(false);
  });

  it("also requires the owner for any auto_save change, without delaying it", () => {
    const withSaving: PolicyDocumentInput = {
      ...base,
      auto_save: { income_split: { bps: 500, to: "treasury" } },
    };
    const saveOnly = classifyChange(base, withSaving);
    expect(saveOnly.kind).toBe("unchanged");
    expect(requiresOwnerSignature(saveOnly.kind)).toBe(false);
    expect(requiresOwnerSignatureForChange(saveOnly)).toBe(true);
    expect(effectiveAt(saveOnly.kind, NOW)).toEqual(NOW);
    const removed = classifyChange(withSaving, base);
    expect(removed.neutral).toEqual(["auto_save.income_split"]);
    expect(requiresOwnerSignatureForChange(removed)).toBe(true);
    // Tightening plus a saving change: owner-signed, still immediate.
    const tighter = classifyChange(base, { ...withSaving, limits: { per_tx: "5.00", per_day: "200.00" } });
    expect(tighter.kind).toBe("tighten");
    expect(requiresOwnerSignatureForChange(tighter)).toBe(true);
    expect(effectiveAt(tighter.kind, NOW)).toEqual(NOW);
  });

  it("requires the owner exactly when the kind does, absent auto_save changes", () => {
    expect(requiresOwnerSignatureForChange(classifyChange(null, base))).toBe(true);
    expect(requiresOwnerSignatureForChange(classifyChange(base, base))).toBe(false);
    expect(
      requiresOwnerSignatureForChange(classifyChange(base, { ...base, $schema: "agentbank.policy.v1" })),
    ).toBe(false);
    expect(requiresOwnerSignatureForChange(classifyChange(base, { ...base, max_balance: "10" }))).toBe(false);
    expect(requiresOwnerSignatureForChange(classifyChange({ ...base, max_balance: "10" }, base))).toBe(true);
    expect(
      requiresOwnerSignatureForChange(
        classifyChange(base, { ...base, limits: { per_tx: "1", per_day: "900" } }),
      ),
    ).toBe(true);
  });

  it("delays loosening by one hour and applies everything else immediately", () => {
    const later = new Date(NOW.getTime() + LOOSENING_DELAY_SECONDS * 1000);
    expect(effectiveAt("loosen", NOW)).toEqual(later);
    expect(effectiveAt("mixed", NOW)).toEqual(later);
    for (const kind of ["initial", "tighten", "unchanged"] as const) {
      const at = effectiveAt(kind, NOW);
      expect(at).toEqual(NOW);
      expect(at).not.toBe(NOW);
    }
  });
});
