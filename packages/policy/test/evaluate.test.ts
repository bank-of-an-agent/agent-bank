import { PolicyDecisionSchema } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import {
  compileTimeWindows,
  evaluate,
  isAuthorized,
  RULE_IDS,
  toPolicyDecisionWire,
  type CompiledPolicy,
  type EvaluationContext,
} from "../src";
import {
  $,
  ADDR,
  AGENT_ID,
  compile,
  context,
  deniedBy,
  DESIGN_EXAMPLE,
  DOMAIN,
  effects,
  mandate,
  mandateContext,
  NOW,
  OTHER_AGENT_ID,
  reasons,
  sessionContext,
  x402,
} from "./helpers";

const open = compile({});

describe("evaluate: the design example policy", () => {
  const policy = compile(DESIGN_EXAMPLE, 7);

  it("allows a small x402 payment to the allowlisted domain", () => {
    const d = evaluate(policy, context({ intent: x402(DOMAIN) }));
    expect(d.outcome).toBe("allow");
    expect(d.policyVersion).toBe(7);
    expect(d.approversRequired).toBe(0);
    expect(d.retryAt).toBeNull();
    expect(d.evaluatedAt).toEqual(NOW);
    expect(d.evaluatedAt).not.toBe(NOW);
    expect(effects(d, "counterparties.allowlist")).toEqual(["allow"]);
    expect(effects(d, "limits.per_tx")).toEqual(["allow"]);
    expect(effects(d, "approvals")).toEqual(["allow"]);
  });

  it("denies a transfer to an address that is not allowlisted", () => {
    const d = evaluate(policy, context());
    expect(d.outcome).toBe("deny");
    expect(deniedBy(d)).toEqual(["counterparties.allowlist"]);
  });

  it("reports every rule hit with a known rule id and effect", () => {
    const d = evaluate(policy, context({ intent: x402(DOMAIN, "30.00") }));
    for (const hit of d.ruleHits) {
      expect(RULE_IDS).toContain(hit.rule);
      expect(["allow", "deny", "require_approval", "require_owner", "info"]).toContain(hit.effect);
      expect(hit.detail.length).toBeGreaterThan(0);
    }
    expect(d.outcome).toBe("deny");
    expect(deniedBy(d)).toEqual(["limits.per_tx"]);
  });
});

describe("evaluate: fail closed", () => {
  it("denies when there is no policy", () => {
    const d = evaluate(null, context());
    expect(d.outcome).toBe("deny");
    expect(deniedBy(d)).toEqual(["policy.missing"]);
    expect(d.policyVersion).toBe(0);
  });

  it("denies a policy object that did not come from compilePolicy", () => {
    const fake = { ...open, format: "something else" } as unknown as CompiledPolicy;
    const d = evaluate(fake, context());
    expect(deniedBy(d)).toEqual(["policy.invalid"]);
    const raw = { limits: {} } as unknown as CompiledPolicy;
    expect(deniedBy(evaluate(raw, context()))).toEqual(["policy.invalid"]);
  });

  it("still evaluates mandate and session rules without a policy", () => {
    const d = evaluate(null, context({ session: sessionContext({ max_per_tx: "1.00" }) }));
    expect(deniedBy(d)).toEqual(["policy.missing", "session.max_per_tx"]);
  });

  it("turns an unexpected exception into an engine.error denial", () => {
    const hostile = new Proxy(open, {
      get(target, prop, receiver) {
        if (prop === "limits") throw new Error("boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    const d = evaluate(hostile, context());
    expect(d.outcome).toBe("deny");
    expect(d.ruleHits).toHaveLength(1);
    expect(d.ruleHits[0]?.rule).toBe("engine.error");
    expect(d.ruleHits[0]?.detail).toContain("boom");
    expect(d.evaluatedAt).toEqual(NOW);
    expect(d.policyVersion).toBe(1);
    const nonError = new Proxy(open, {
      get(target, prop, receiver) {
        if (prop === "limits") throw "plain string";
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(evaluate(nonError, context()).ruleHits[0]?.detail).toContain("plain string");
    const broken = evaluate(open, null as unknown as EvaluationContext);
    expect(broken.outcome).toBe("deny");
    expect(broken.evaluatedAt.getTime()).toBe(0);
  });

  it("reports version 0 for a malformed policy version", () => {
    const hostile = new Proxy(
      { ...open, version: -1 },
      {
        get(target, prop, receiver) {
          if (prop === "limits") throw new Error("boom");
          return Reflect.get(target, prop, receiver);
        },
      },
    ) as CompiledPolicy;
    expect(evaluate(hostile, context()).policyVersion).toBe(0);
  });

  it("denies an invalid clock", () => {
    const d = evaluate(open, context({ now: new Date(Number.NaN) }));
    expect(deniedBy(d)).toEqual(["context.invalid"]);
    expect(d.evaluatedAt.getTime()).toBe(0);
    expect(deniedBy(evaluate(open, context({ now: "2026-10-12" as unknown as Date })))).toEqual([
      "context.invalid",
    ]);
  });

  const invalidContexts: Array<[string, EvaluationContext]> = [
    ["zero amount", context({ intent: { amount: 0n } })],
    ["negative amount", context({ intent: { amount: -1n } })],
    ["number amount", context({ intent: { amount: 10 as unknown as bigint } })],
    ["amount above the ledger range", context({ intent: { amount: 2n ** 63n } })],
    ["unknown kind", context({ intent: { kind: "Transfer" as never } })],
    ["non-string asset", context({ intent: { asset: 1 as unknown as string } })],
    ["malformed contract", context({ intent: { contract: "0x1234" } })],
    ["negative day spend", context({ history: { spentLastDay: -1n } })],
    ["number spend", context({ history: { spentLastMonth: 5 as unknown as bigint } })],
    ["negative counterparty spend", context({ history: { counterpartySpentLastDay: -5n } })],
    ["fractional count", context({ history: { countLastMinute: 1.5 } })],
    ["negative count", context({ history: { countLastDay: -1 } })],
    ["invalid first-seen", context({ history: { counterpartyFirstSeenAt: new Date(Number.NaN) } })],
    ["missing agent id", context({ agent: { id: "" } })],
    ["missing intent", { ...context(), intent: undefined as never }],
    ["missing history", { ...context(), history: null as never }],
    ["uncompiled mandate", context({ mandate: { mandate: mandate() as never, spent: 0n, occurrences: 0 } })],
    ["negative mandate spend", context({ mandate: { ...mandateContext(mandate()), spent: -1n } })],
    ["fractional occurrences", context({ mandate: { ...mandateContext(mandate()), occurrences: 0.5 } })],
    [
      "invalid last occurrence",
      context({ mandate: { ...mandateContext(mandate()), lastOccurrenceAt: new Date(Number.NaN) } }),
    ],
    ["uncompiled session", context({ session: { scope: {} as never, spentToday: 0n } })],
    ["negative session spend", context({ session: { ...sessionContext(), spentToday: -1n } })],
    ["invalid revocation", context({ session: { ...sessionContext(), revokedAt: new Date(Number.NaN) } })],
  ];

  it.each(invalidContexts)("denies a malformed context: %s", (_name, ctx) => {
    const d = evaluate(open, ctx);
    expect(d.outcome).toBe("deny");
    expect(deniedBy(d)).toContain("context.invalid");
  });

  it("freezes the decision", () => {
    const d = evaluate(open, context());
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.ruleHits)).toBe(true);
  });
});

describe("evaluate: status, binding, kinds and asset", () => {
  it("denies a frozen agent or org and keeps evaluating every rule", () => {
    const policy = compile({ limits: { per_tx: "5.00" } });
    const d = evaluate(policy, context({ agent: { status: "frozen" } }));
    expect(deniedBy(d)).toEqual(["agent.frozen", "limits.per_tx"]);
    const org = evaluate(policy, context({ org: { status: "frozen" }, intent: { amount: $("1.00") } }));
    expect(deniedBy(org)).toEqual(["org.frozen"]);
    const weird = evaluate(open, context({ agent: { status: "suspended" as never } }));
    expect(deniedBy(weird)).toEqual(["agent.frozen"]);
  });

  it("denies when the policy is bound to another agent", () => {
    const policy = compile({ agent: AGENT_ID });
    expect(evaluate(policy, context()).outcome).toBe("allow");
    expect(deniedBy(evaluate(policy, context({ agent: { id: OTHER_AGENT_ID } })))).toEqual(["policy.agent"]);
  });

  it("enforces allowed kinds", () => {
    const policy = compile({ allowed_kinds: ["x402"] });
    expect(effects(evaluate(policy, context({ intent: x402(DOMAIN) })), "kinds.allowed")).toEqual(["allow"]);
    expect(deniedBy(evaluate(policy, context()))).toEqual(["kinds.allowed"]);
    expect(() => compile({ allowed_kinds: [] })).toThrow(/allowed_kinds/);
  });

  it("denies an asset other than the policy asset, including case variants", () => {
    expect(deniedBy(evaluate(open, context({ intent: { asset: "usdc" } })))).toEqual(["asset"]);
    expect(deniedBy(evaluate(open, context({ intent: { asset: "EURC" } })))).toEqual(["asset"]);
  });
});

describe("evaluate: counterparty identity", () => {
  it.each([
    ["uppercase 0X prefix", { address: "0X1111111111111111111111111111111111111111" }],
    ["short address", { address: "0x111111111111111111111111111111111111111" }],
    ["address with whitespace", { address: ` ${ADDR.alice}` }],
    ["zero address", { address: ADDR.zero }],
    ["no identifiers", {}],
    ["non-string agent id", { agentId: 42 as unknown as string }],
    ["agent id with a space", { agentId: "agt_ 1" }],
    ["unicode ERC-8004 id", { erc8004Id: "\uff14\uff12" }],
  ])("denies a transfer to a malformed payee: %s", (_name, counterparty) => {
    const d = evaluate(open, context({ intent: { counterparty } }));
    expect(deniedBy(d)).toContain("counterparty.invalid");
  });

  it("requires x402 payments to name the host", () => {
    const d = evaluate(open, context({ intent: { kind: "x402", counterparty: { address: ADDR.bob } } }));
    expect(deniedBy(d)).toEqual(["counterparty.invalid"]);
    const bad = evaluate(open, context({ intent: x402("\u0430pi.example-data.com") }));
    expect(deniedBy(bad)).toEqual(["counterparty.invalid"]);
    expect(bad.ruleHits[0]?.detail).toContain("\\u0430");
  });

  it.each(["192.168.0.1", "127.0.0.1", "3232235521", "0x7f.0.0.1", "0xc0.0xa8.0.1", "[::1]", "10.0.0.1."])(
    "denies x402 to the IP-literal host %j even in open mode (a policy could not name it)",
    (host) => {
      const d = evaluate(open, context({ intent: x402(host) }));
      expect(deniedBy(d)).toEqual(["counterparty.invalid"]);
    },
  );

  it("denies agent ids that are not well formed", () => {
    for (const agentId of ["agt_foo", AGENT_ID.toLowerCase(), `${AGENT_ID}0`, AGENT_ID.slice(0, -1)]) {
      expect(deniedBy(evaluate(open, context({ intent: { counterparty: { agentId } } })))).toEqual([
        "counterparty.invalid",
      ]);
    }
  });

  it("denies a missing counterparty object", () => {
    const d = evaluate(open, context({ intent: { counterparty: null as never } }));
    expect(deniedBy(d)).toContain("counterparty.invalid");
  });

  it("accepts an EIP-55 checksummed address", () => {
    const policy = compile({
      counterparties: { mode: "allowlist", addresses: ["0x52908400098527886E0F7030069857D2E4169EE7"] },
    });
    const d = evaluate(
      policy,
      context({ intent: { counterparty: { address: "0x52908400098527886e0f7030069857d2e4169ee7" } } }),
    );
    expect(d.outcome).toBe("allow");
  });
});

describe("evaluate: refills of the spend key", () => {
  const strict = compile({
    counterparties: { mode: "allowlist", x402_domains: [DOMAIN], new_cooldown_minutes: 60 },
  });

  it("allows a refill of the agent's own spend key without counterparty rules", () => {
    const d = evaluate(
      strict,
      context({
        intent: {
          kind: "refill",
          counterparty: { address: ADDR.spendKey.toUpperCase().replace("0X", "0x") },
        },
        history: { counterpartyFirstSeenAt: null },
      }),
    );
    expect(d.outcome).toBe("allow");
    expect(effects(d, "refill.target")).toEqual(["allow"]);
    expect(effects(d, "counterparties.allowlist")).toEqual([]);
    expect(effects(d, "counterparties.cooldown")).toEqual([]);
  });

  it("denies a refill to any other address, or when no spend key is registered", () => {
    const other = evaluate(
      strict,
      context({ intent: { kind: "refill", counterparty: { address: ADDR.mallory } } }),
    );
    expect(deniedBy(other)).toEqual(["refill.target", "counterparties.allowlist"]);
    const none = evaluate(
      strict,
      context({
        agent: { spendKeyAddress: null },
        intent: { kind: "refill", counterparty: { address: ADDR.spendKey } },
      }),
    );
    expect(deniedBy(none)).toEqual(["refill.target", "counterparties.allowlist"]);
    const noAddress = evaluate(
      open,
      context({ intent: { kind: "refill", counterparty: { agentId: AGENT_ID } } }),
    );
    expect(deniedBy(noAddress)).toEqual(["refill.target"]);
  });

  it("still applies amount limits to refills", () => {
    const policy = compile({ limits: { per_tx: "5.00" } });
    const d = evaluate(
      policy,
      context({ intent: { kind: "refill", counterparty: { address: ADDR.spendKey } } }),
    );
    expect(deniedBy(d)).toEqual(["limits.per_tx"]);
  });
});

describe("evaluate: denylists and allowlists", () => {
  it("denies denylisted counterparties in open mode by any identifier", () => {
    const policy = compile({
      counterparties: { deny: { addresses: [ADDR.bob], x402_domains: ["evil.example"] } },
    });
    expect(deniedBy(evaluate(policy, context({ intent: { counterparty: { address: ADDR.bob } } })))).toEqual([
      "counterparties.denylist",
    ]);
    // An x402 seller whose payTo address is denylisted is denied even on a fine host.
    expect(deniedBy(evaluate(policy, context({ intent: x402(DOMAIN) })))).toEqual([
      "counterparties.denylist",
    ]);
    expect(deniedBy(evaluate(policy, context({ intent: x402("EVIL.example.") })))).toEqual([
      "counterparties.denylist",
    ]);
    const ok = evaluate(policy, context());
    expect(ok.outcome).toBe("allow");
    expect(effects(ok, "counterparties.denylist")).toEqual(["allow"]);
  });

  it("treats the top-level lists as the denylist in denylist mode", () => {
    const policy = compile({ counterparties: { mode: "denylist", agent_ids: [OTHER_AGENT_ID] } });
    expect(
      deniedBy(
        evaluate(
          policy,
          context({ intent: { counterparty: { address: ADDR.carol, agentId: OTHER_AGENT_ID } } }),
        ),
      ),
    ).toEqual(["counterparties.denylist"]);
    expect(evaluate(policy, context()).outcome).toBe("allow");
  });

  it("rejects top-level lists in open mode, where they would have no effect", () => {
    expect(() => compile({ counterparties: { mode: "open", addresses: [ADDR.alice] } })).toThrow(/open/);
    expect(compile({ counterparties: { mode: "open", addresses: [] } }).counterparties.allow).toBeNull();
  });

  it("matches transfers by address, agent id or ERC-8004 id and x402 by host only", () => {
    const policy = compile({
      counterparties: {
        mode: "allowlist",
        addresses: [ADDR.alice],
        agent_ids: [OTHER_AGENT_ID],
        erc8004_ids: ["eip155:84532:0xABC:42"],
        x402_domains: [DOMAIN],
      },
    });
    const allow = (counterparty: object, kind: "transfer" | "x402" = "transfer") =>
      evaluate(policy, context({ intent: { kind, counterparty } })).outcome;
    expect(allow({ address: ADDR.alice })).toBe("allow");
    expect(allow({ agentId: OTHER_AGENT_ID })).toBe("allow");
    expect(allow({ erc8004Id: "EIP155:84532:0xabc:42" })).toBe("allow");
    expect(allow({ address: ADDR.bob })).toBe("deny");
    // An allowlisted host does not admit a transfer; an allowlisted address does not admit an x402 payment.
    expect(allow({ address: ADDR.bob, x402Domain: DOMAIN })).toBe("deny");
    expect(allow({ address: ADDR.alice, x402Domain: "other.example" }, "x402")).toBe("deny");
    expect(allow({ x402Domain: "API.Example-Data.COM." }, "x402")).toBe("allow");
    expect(allow({ x402Domain: `sub.${DOMAIN}` }, "x402")).toBe("deny");
  });

  it("lets the denylist win over the allowlist", () => {
    const policy = compile({
      counterparties: { mode: "allowlist", addresses: [ADDR.alice], deny: { addresses: [ADDR.alice] } },
    });
    expect(deniedBy(evaluate(policy, context()))).toEqual(["counterparties.denylist"]);
  });

  it("explains which identifier type x402 allowlists use", () => {
    const policy = compile({ counterparties: { mode: "allowlist", addresses: [ADDR.bob] } });
    const d = evaluate(policy, context({ intent: x402("other.example") }));
    expect(d.ruleHits.find((h) => h.rule === "counterparties.allowlist")?.detail).toContain("host name");
  });
});

describe("evaluate: cooling period for new counterparties", () => {
  const policy = compile({ counterparties: { new_cooldown_minutes: 60 } });

  it("denies a never-seen counterparty and says when it opens", () => {
    const d = evaluate(policy, context({ history: { counterpartyFirstSeenAt: null } }));
    expect(deniedBy(d)).toEqual(["counterparties.cooldown"]);
    expect(d.retryAt).toEqual(new Date(NOW.getTime() + 3_600_000));
  });

  it("denies until N minutes after first sight, then allows", () => {
    const first = new Date(NOW.getTime() - 59 * 60_000);
    const d = evaluate(policy, context({ history: { counterpartyFirstSeenAt: first } }));
    expect(deniedBy(d)).toEqual(["counterparties.cooldown"]);
    expect(d.retryAt).toEqual(new Date(first.getTime() + 3_600_000));
    const exactly = evaluate(
      policy,
      context({ history: { counterpartyFirstSeenAt: new Date(NOW.getTime() - 3_600_000) } }),
    );
    expect(exactly.outcome).toBe("allow");
    expect(effects(exactly, "counterparties.cooldown")).toEqual(["allow"]);
  });

  it("gives no retry time when another rule also denies", () => {
    const strict = compile({ limits: { per_tx: "1.00" }, counterparties: { new_cooldown_minutes: 60 } });
    const d = evaluate(strict, context({ history: { counterpartyFirstSeenAt: null } }));
    expect(deniedBy(d)).toEqual(["counterparties.cooldown", "limits.per_tx"]);
    expect(d.retryAt).toBeNull();
  });
});

describe("evaluate: per-counterparty caps", () => {
  const policy = compile({
    counterparties: {
      caps: [
        { match: { address: ADDR.alice }, per_tx: "20.00", per_day: "50.00", per_month: "100.00" },
        { match: { x402_domain: DOMAIN }, per_day: "1.00" },
        { match: { agent_id: OTHER_AGENT_ID }, per_tx: "5.00" },
      ],
    },
  });

  it("applies caps that match the counterparty", () => {
    expect(evaluate(policy, context()).outcome).toBe("allow");
    expect(deniedBy(evaluate(policy, context({ intent: { amount: $("20.000001") } })))).toEqual([
      "counterparties.caps.per_tx",
    ]);
    expect(
      deniedBy(evaluate(policy, context({ history: { counterpartySpentLastDay: $("40.01") } }))),
    ).toEqual(["counterparties.caps.per_day"]);
    expect(
      deniedBy(evaluate(policy, context({ history: { counterpartySpentLastMonth: $("90.01") } }))),
    ).toEqual(["counterparties.caps.per_month"]);
    expect(evaluate(policy, context({ history: { counterpartySpentLastMonth: $("90.00") } })).outcome).toBe(
      "allow",
    );
  });

  it("matches caps by any identifier and ignores unrelated caps", () => {
    const viaAgent = context({
      intent: { amount: $("6.00"), counterparty: { address: ADDR.carol, agentId: OTHER_AGENT_ID } },
    });
    expect(deniedBy(evaluate(policy, viaAgent))).toEqual(["counterparties.caps.per_tx"]);
    const d = evaluate(
      policy,
      context({ intent: x402(DOMAIN, "0.50"), history: { counterpartySpentLastDay: $("0.60") } }),
    );
    expect(deniedBy(d)).toEqual(["counterparties.caps.per_day"]);
    const unrelated = evaluate(policy, context({ intent: { counterparty: { address: ADDR.carol } } }));
    expect(unrelated.ruleHits.filter((h) => h.rule.startsWith("counterparties.caps"))).toEqual([]);
  });
});

describe("evaluate: time windows", () => {
  const business = compile({
    time_windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "17:00",
        timezone: "America/New_York",
      },
    ],
  });

  it("allows inside and denies outside the window, with the next opening", () => {
    // 15:00 UTC Monday = 11:00 in New York (EDT).
    expect(evaluate(business, context()).outcome).toBe("allow");
    const evening = new Date("2026-10-12T21:30:00Z"); // 17:30 EDT
    const d = evaluate(business, context({ now: evening }));
    expect(deniedBy(d)).toEqual(["time_windows"]);
    expect(d.retryAt).toEqual(new Date("2026-10-13T13:00:00Z"));
    const friday = evaluate(business, context({ now: new Date("2026-10-16T21:00:00Z") }));
    expect(friday.retryAt).toEqual(new Date("2026-10-19T13:00:00Z"));
  });

  it("treats the window end as exclusive and the start as inclusive", () => {
    expect(evaluate(business, context({ now: new Date("2026-10-12T13:00:00Z") })).outcome).toBe("allow");
    expect(evaluate(business, context({ now: new Date("2026-10-12T12:59:59.999Z") })).outcome).toBe("deny");
    expect(evaluate(business, context({ now: new Date("2026-10-12T20:59:59.999Z") })).outcome).toBe("allow");
    expect(evaluate(business, context({ now: new Date("2026-10-12T21:00:00Z") })).outcome).toBe("deny");
  });

  it("rejects an empty list of windows, and denies everything if windows allow no minute", () => {
    expect(() => compile({ time_windows: [] })).toThrow(/time_windows/);
    // Defense in depth: windows that allow no time at all deny with no retry time.
    const none = { ...business, timeWindows: compileTimeWindows([]) } as CompiledPolicy;
    const d = evaluate(none, context());
    expect(deniedBy(d)).toEqual(["time_windows"]);
    expect(d.retryAt).toBeNull();
    expect(d.ruleHits[0]?.detail).toContain("no time window");
  });
});

describe("evaluate: amount limits and velocity", () => {
  const policy = compile({
    limits: { per_tx: "25.00", per_day: "200.00", per_week: "500.00", per_month: "2000.00" },
    velocity: { max_per_minute: 3, max_per_hour: 10, max_per_day: 20 },
  });

  it("allows amounts exactly at the caps and denies one minor unit more", () => {
    expect(evaluate(policy, context({ intent: { amount: $("25.00") } })).outcome).toBe("allow");
    expect(deniedBy(evaluate(policy, context({ intent: { amount: $("25.000001") } })))).toEqual([
      "limits.per_tx",
    ]);
    const day = { spentLastDay: $("190.00") };
    expect(evaluate(policy, context({ history: day })).outcome).toBe("allow");
    expect(deniedBy(evaluate(policy, context({ history: { spentLastDay: $("190.000001") } })))).toEqual([
      "limits.per_day",
    ]);
    expect(deniedBy(evaluate(policy, context({ history: { spentLastWeek: $("490.01") } })))).toEqual([
      "limits.per_week",
    ]);
    expect(deniedBy(evaluate(policy, context({ history: { spentLastMonth: $("1990.01") } })))).toEqual([
      "limits.per_month",
    ]);
  });

  it("denies when the window already holds the maximum number of payments", () => {
    expect(evaluate(policy, context({ history: { countLastMinute: 2 } })).outcome).toBe("allow");
    expect(deniedBy(evaluate(policy, context({ history: { countLastMinute: 3 } })))).toEqual([
      "velocity.per_minute",
    ]);
    expect(deniedBy(evaluate(policy, context({ history: { countLastHour: 10 } })))).toEqual([
      "velocity.per_hour",
    ]);
    expect(deniedBy(evaluate(policy, context({ history: { countLastDay: 25 } })))).toEqual([
      "velocity.per_day",
    ]);
  });

  it("collects every breached rule", () => {
    const d = evaluate(
      policy,
      context({
        intent: { amount: $("30.00") },
        history: {
          spentLastDay: $("199.00"),
          spentLastWeek: $("499.00"),
          spentLastMonth: $("1999.00"),
          countLastMinute: 9,
        },
      }),
    );
    expect(deniedBy(d)).toEqual([
      "limits.per_tx",
      "limits.per_day",
      "limits.per_week",
      "limits.per_month",
      "velocity.per_minute",
    ]);
  });
});

describe("evaluate: approvals and owner threshold", () => {
  const policy = compile({
    approvals: [
      { above: "100.00", approvers: 1 },
      { above: "1000.00", approvers: 2 },
    ],
    require_owner_above: "5000.00",
  });

  it("requires approvers of the highest threshold exceeded (strictly above)", () => {
    expect(evaluate(policy, context({ intent: { amount: $("100.00") } })).outcome).toBe("allow");
    const one = evaluate(policy, context({ intent: { amount: $("100.000001") } }));
    expect(one.outcome).toBe("require_approval");
    expect(one.approversRequired).toBe(1);
    expect(reasons(one)).toEqual(["approvals"]);
    const two = evaluate(policy, context({ intent: { amount: $("1000.01") } }));
    expect(two.approversRequired).toBe(2);
  });

  it("requires the owner above require_owner_above, which outranks approvals", () => {
    const d = evaluate(policy, context({ intent: { amount: $("5000.01") } }));
    expect(d.outcome).toBe("require_owner");
    expect(d.approversRequired).toBe(0);
    expect(effects(d, "approvals")).toEqual(["require_approval"]);
    expect(effects(d, "require_owner_above")).toEqual(["require_owner"]);
    expect(effects(evaluate(policy, context()), "require_owner_above")).toEqual(["allow"]);
  });

  it("lets a denial outrank both", () => {
    const strict = compile({
      limits: { per_day: "10.00" },
      approvals: [{ above: "1.00", approvers: 1 }],
      require_owner_above: "2.00",
    });
    const d = evaluate(strict, context({ intent: { amount: $("11.00") } }));
    expect(d.outcome).toBe("deny");
    expect(d.approversRequired).toBe(0);
  });

  it("carries a misconfigured larger approver count upward", () => {
    const odd = compile({
      approvals: [
        { above: "1000.00", approvers: 1 },
        { above: "100.00", approvers: 3 },
      ],
    });
    expect(evaluate(odd, context({ intent: { amount: $("500.00") } })).approversRequired).toBe(3);
    expect(evaluate(odd, context({ intent: { amount: $("5000.00") } })).approversRequired).toBe(3);
  });
});

describe("evaluate: mandates", () => {
  const m = mandate({
    constraints: [
      { type: "payment.amount_range", currency: "USD", max: 2_500, min: 100 },
      {
        type: "payment.allowed_payees",
        allowed: [
          { id: ADDR.alice, name: "Alice" },
          { id: DOMAIN, name: "Data" },
        ],
      },
      { type: "payment.budget", currency: "USDC", max: "100000000" },
      { type: "payment.agent_recurrence", frequency: "DAILY", max_occurrences: 5 },
      {
        type: "payment.execution_date",
        not_before: "2026-10-05T00:00:00Z",
        not_after: "2026-10-20T00:00:00Z",
      },
    ],
  });

  it("allows a payment inside every constraint", () => {
    const d = evaluate(
      open,
      context({ mandate: mandateContext(m, $("50.00"), 2, new Date("2026-10-11T12:00:00Z")) }),
    );
    expect(d.outcome).toBe("allow");
    for (const rule of [
      "mandate.agent",
      "mandate.expired",
      "mandate.execution_date",
      "mandate.amount_range",
      "mandate.allowed_payees",
      "mandate.budget",
      "mandate.max_occurrences",
      "mandate.recurrence",
    ]) {
      expect(effects(d, rule)).toEqual(["allow"]);
    }
  });

  it("denies each violated constraint", () => {
    const cases: Array<[string, EvaluationContext]> = [
      ["mandate.amount_range", context({ intent: { amount: $("25.01") }, mandate: mandateContext(m) })],
      ["mandate.amount_range", context({ intent: { amount: $("0.99") }, mandate: mandateContext(m) })],
      [
        "mandate.allowed_payees",
        context({ intent: { counterparty: { address: ADDR.bob } }, mandate: mandateContext(m) }),
      ],
      ["mandate.budget", context({ mandate: mandateContext(m, $("90.000001")) })],
      ["mandate.max_occurrences", context({ mandate: mandateContext(m, 0n, 5) })],
      [
        "mandate.recurrence",
        context({ mandate: mandateContext(m, 0n, 1, new Date(NOW.getTime() - 3_600_000)) }),
      ],
      [
        "mandate.execution_date",
        context({ now: new Date("2026-10-04T23:59:59Z"), mandate: mandateContext(m) }),
      ],
      [
        "mandate.execution_date",
        context({ now: new Date("2026-10-20T00:00:01Z"), mandate: mandateContext(m) }),
      ],
      ["mandate.agent", context({ agent: { id: OTHER_AGENT_ID }, mandate: mandateContext(m) })],
      ["mandate.asset", context({ intent: { asset: "EURC" }, mandate: mandateContext(m) })],
    ];
    for (const [rule, ctx] of cases) {
      const d = evaluate(open, ctx);
      expect(d.outcome, rule).toBe("deny");
      expect(deniedBy(d), rule).toContain(rule);
    }
  });

  it("denies an expired or not yet valid mandate", () => {
    const expired = evaluate(
      open,
      context({ now: new Date("2026-11-01T00:00:00Z"), mandate: mandateContext(m) }),
    );
    expect(deniedBy(expired)).toContain("mandate.expired");
    const future = mandate({
      iat: Math.floor(NOW.getTime() / 1000) + 600,
      exp: Math.floor(NOW.getTime() / 1000) + 9_000,
    });
    const early = evaluate(open, context({ mandate: mandateContext(future) }));
    expect(deniedBy(early)).toEqual(["mandate.not_yet_valid"]);
    expect(early.retryAt).toEqual(new Date(NOW.getTime() + 300_000));
    const skewed = mandate({
      iat: Math.floor(NOW.getTime() / 1000) + 120,
      exp: Math.floor(NOW.getTime() / 1000) + 9_000,
    });
    expect(evaluate(open, context({ mandate: mandateContext(skewed) })).outcome).toBe("allow");
  });

  it("gives the next allowed time for recurrence spacing and the execution window", () => {
    const last = new Date(NOW.getTime() - 3_600_000);
    const d = evaluate(open, context({ mandate: mandateContext(m, 0n, 1, last) }));
    expect(d.retryAt).toEqual(new Date(last.getTime() + 22 * 3_600_000));
    const early = evaluate(
      open,
      context({ now: new Date("2026-10-04T00:00:00Z"), mandate: mandateContext(m) }),
    );
    expect(early.retryAt).toEqual(new Date("2026-10-05T00:00:00Z"));
  });

  it("restricts x402 payments to the mandate's hosts and refuses other kinds", () => {
    const xm = mandate({ constraints: [{ type: "agentbank.x402_domains", allowed: [DOMAIN] }] });
    expect(evaluate(open, context({ intent: x402(DOMAIN), mandate: mandateContext(xm) })).outcome).toBe(
      "allow",
    );
    expect(
      deniedBy(evaluate(open, context({ intent: x402("other.example"), mandate: mandateContext(xm) }))),
    ).toEqual(["mandate.x402_domains"]);
    const transfer = evaluate(open, context({ mandate: mandateContext(xm) }));
    expect(deniedBy(transfer)).toEqual(["mandate.x402_domains"]);
    expect(transfer.ruleHits.find((h) => h.rule === "mandate.x402_domains")?.detail).toContain(
      "only authorizes x402",
    );
  });

  it("matches x402 payees by host name", () => {
    const d = evaluate(open, context({ intent: x402(DOMAIN, "5.00"), mandate: mandateContext(m) }));
    expect(effects(d, "mandate.allowed_payees")).toEqual(["allow"]);
  });

  it("ignores recurrence spacing for ON_DEMAND mandates and without a last occurrence", () => {
    const od = mandate({ constraints: [{ type: "payment.agent_recurrence", frequency: "ON_DEMAND" }] });
    const d = evaluate(open, context({ mandate: mandateContext(od, 0n, 100, new Date(NOW.getTime() - 1)) }));
    expect(d.outcome).toBe("allow");
    expect(effects(d, "mandate.recurrence")).toEqual([]);
    expect(effects(d, "mandate.max_occurrences")).toEqual([]);
  });
});

describe("evaluate: session scope", () => {
  it("allows within the scope", () => {
    const d = evaluate(open, context({ session: sessionContext({}, $("50.00")) }));
    expect(d.outcome).toBe("allow");
    expect(effects(d, "session.max_per_tx")).toEqual(["allow"]);
    expect(effects(d, "session.max_per_day")).toEqual(["allow"]);
    expect(effects(d, "session.expired")).toEqual(["allow"]);
  });

  it("denies each violated scope rule", () => {
    const cases: Array<[string, EvaluationContext]> = [
      ["session.expired", context({ now: new Date("2026-10-13T00:00:00Z"), session: sessionContext() })],
      ["session.revoked", context({ session: sessionContext({}, 0n, new Date(NOW.getTime() - 1)) })],
      ["session.max_per_tx", context({ intent: { amount: $("50.000001") }, session: sessionContext() })],
      ["session.max_per_day", context({ session: sessionContext({}, $("90.000001")) })],
      [
        "session.allowed_recipients",
        context({ session: sessionContext({ allowed_recipients: [ADDR.bob] }) }),
      ],
      [
        "session.allowed_recipients",
        context({
          intent: { counterparty: { agentId: OTHER_AGENT_ID } },
          session: sessionContext({ allowed_recipients: [ADDR.bob] }),
        }),
      ],
      [
        "session.allowed_contracts",
        context({
          intent: { kind: "escrow", contract: ADDR.stream },
          session: sessionContext({ allowed_contracts: [ADDR.escrow] }),
        }),
      ],
      [
        "session.allowed_contracts",
        context({
          intent: { kind: "stream" },
          session: sessionContext({ allowed_contracts: [ADDR.stream] }),
        }),
      ],
    ];
    for (const [rule, ctx] of cases) {
      const d = evaluate(open, ctx);
      expect(deniedBy(d), rule).toEqual([rule]);
    }
  });

  it("allows listed recipients and contracts, case-insensitively", () => {
    const d = evaluate(
      open,
      context({
        intent: { kind: "escrow", contract: ADDR.escrow.toUpperCase().replace("0X", "0x") },
        session: sessionContext({ allowed_recipients: [ADDR.alice], allowed_contracts: [ADDR.escrow] }),
      }),
    );
    expect(d.outcome).toBe("allow");
    expect(effects(d, "session.allowed_contracts")).toEqual(["allow"]);
    expect(effects(d, "session.allowed_recipients")).toEqual(["allow"]);
  });

  it("ignores a revocation scheduled in the future", () => {
    const d = evaluate(open, context({ session: sessionContext({}, 0n, new Date(NOW.getTime() + 1)) }));
    expect(d.outcome).toBe("allow");
  });

  it("denies a session for another asset", () => {
    const ctx = context({ session: sessionContext() });
    const scope = { ...ctx.session!.scope, asset: "EURC" as never };
    expect(deniedBy(evaluate(open, { ...ctx, session: { ...ctx.session!, scope } }))).toEqual([
      "session.asset",
    ]);
  });
});

describe("wire conversion and authorization", () => {
  it("converts to the API's PolicyDecision shape", () => {
    const d = evaluate(compile(DESIGN_EXAMPLE, 3), context({ intent: x402(DOMAIN, "150.00") }));
    const wire = toPolicyDecisionWire(d, "dec_01");
    expect(PolicyDecisionSchema.parse(wire)).toEqual(wire);
    expect(wire.id).toBe("dec_01");
    expect(wire.policy_version).toBe(3);
    expect(wire.evaluated_at).toBe(NOW.toISOString());
    expect(wire.retry_at).toBeNull();
    expect("id" in toPolicyDecisionWire(d)).toBe(false);
  });

  it("puts the time a time-based denial lifts on the wire as retry_at", () => {
    const policy = compile({ counterparties: { new_cooldown_minutes: 60 } });
    const d = evaluate(policy, context({ history: { counterpartyFirstSeenAt: null } }));
    const wire = toPolicyDecisionWire(d);
    expect(wire.retry_at).toBe("2026-10-12T16:00:00.000Z");
    expect(PolicyDecisionSchema.parse(wire)).toEqual(wire);
  });

  it("decides whether collected sign-offs satisfy a decision", () => {
    const policy = compile({ approvals: [{ above: "1.00", approvers: 2 }], require_owner_above: "100.00" });
    const approval = evaluate(policy, context());
    expect(isAuthorized(approval)).toBe(false);
    expect(isAuthorized(approval, { approvals: 1 })).toBe(false);
    expect(isAuthorized(approval, { approvals: 2 })).toBe(true);
    const owner = evaluate(policy, context({ intent: { amount: $("101.00") } }));
    expect(isAuthorized(owner, { approvals: 5 })).toBe(false);
    expect(isAuthorized(owner, { ownerSigned: true })).toBe(true);
    expect(isAuthorized(evaluate(open, context()))).toBe(true);
    expect(isAuthorized(evaluate(null, context()), { approvals: 9, ownerSigned: true })).toBe(false);
  });
});

describe("determinism", () => {
  it("returns identical decisions for identical inputs", () => {
    const policy = compile(DESIGN_EXAMPLE);
    const a = evaluate(
      policy,
      context({ intent: x402(DOMAIN, "150.00"), history: { counterpartyFirstSeenAt: null } }),
    );
    const b = evaluate(
      compile(DESIGN_EXAMPLE),
      context({ intent: x402(DOMAIN, "150.00"), history: { counterpartyFirstSeenAt: null } }),
    );
    expect(b).toEqual(a);
    expect(a.ruleHits.map((h) => h.rule)).toEqual([
      "counterparties.allowlist",
      "counterparties.cooldown",
      "limits.per_tx",
      "limits.per_day",
      "limits.per_month",
      "velocity.per_minute",
      "approvals",
    ]);
  });

  it("does not depend on the system clock", () => {
    const policy = compile({ counterparties: { new_cooldown_minutes: 5 } });
    const ctx = context({ history: { counterpartyFirstSeenAt: null } });
    expect(evaluate(policy, ctx).retryAt).toEqual(new Date(NOW.getTime() + 300_000));
  });

  it("evaluates the session window only when one is given", () => {
    const d = evaluate(open, context({ session: null, mandate: null }));
    expect(d.ruleHits).toEqual([]);
    expect(d.outcome).toBe("allow");
  });
});

describe("AGENT_ID sanity", () => {
  it("uses the agent id from the context", () => {
    expect(context().agent.id).toBe(AGENT_ID);
  });
});
