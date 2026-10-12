import { AgentBankError, isId, newId, type PolicyDocumentInput } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import {
  classifyPayeeId,
  compilePolicy,
  isZeroAddress,
  normalizeAddress,
  normalizeAgentId,
  normalizeDomain,
  normalizeErc8004Id,
  normalizeIdentifier,
  OUTCOME_SEVERITY,
  mostSevere,
} from "../src";
import { ADDR, AGENT_ID, DESIGN_EXAMPLE, DOMAIN, OTHER_AGENT_ID, $ } from "./helpers";

describe("normalizeAddress", () => {
  it("lowercases valid addresses", () => {
    expect(normalizeAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(
      "0x52908400098527886e0f7030069857d2e4169ee7",
    );
    expect(isZeroAddress(normalizeAddress(ADDR.zero) ?? "")).toBe(true);
    expect(isZeroAddress(ADDR.alice)).toBe(false);
  });

  it.each([
    "0X1111111111111111111111111111111111111111",
    "1111111111111111111111111111111111111111",
    "0x11111111111111111111111111111111111111111",
    "0x111111111111111111111111111111111111111",
    " 0x1111111111111111111111111111111111111111",
    "0x1111111111111111111111111111111111111111\n",
    "0x111111111111111111111111111111111111111g",
    "0x\uff11111111111111111111111111111111111111111",
    "",
  ])("rejects %j", (value) => {
    expect(normalizeAddress(value)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress(42)).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it.each([
    [DOMAIN, DOMAIN],
    ["API.Example-Data.COM", DOMAIN],
    [`${DOMAIN}.`, DOMAIN],
    ["xn--pi-7ld.example.com", "xn--pi-7ld.example.com"],
    ["localhost", "localhost"],
    ["a1.example.com", "a1.example.com"],
  ])("normalizes %j to %j", (value, expected) => {
    expect(normalizeDomain(value)).toBe(expected);
  });

  it.each([
    "192.168.0.1", // IP literals are not hosts an x402 policy can name
    "10.0.0.1.",
    "0xproject.example.com", // a label starting with 0x is IP-like to the schema
    "\u0430pi.example-data.com", // Cyrillic a
    "api.example-data.com\u200b", // zero-width space
    "\u212aey.example.com", // Kelvin sign lowercases to "k"
    "\uff41\uff50\uff49.example-data.com", // fullwidth
    `${DOMAIN}..`,
    `.${DOMAIN}`,
    `${DOMAIN}:443`,
    `user@${DOMAIN}`,
    `${DOMAIN}/path`,
    `*.${DOMAIN}`,
    ` ${DOMAIN}`,
    "-bad.example.com",
    "bad-.example.com",
    "a..b",
    "3232235521",
    "0x7f.1",
    "127.1",
    "01.2.3.4",
    "1.2.3.4.5",
    "example.0x",
    "example.123",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
    "",
    ".",
  ])("rejects %j", (value) => {
    expect(normalizeDomain(value)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeDomain(null)).toBeNull();
  });
});

describe("opaque identifiers", () => {
  it("keeps agent ids exact and lowercases ERC-8004 ids", () => {
    expect(normalizeAgentId(OTHER_AGENT_ID)).toBe(OTHER_AGENT_ID);
    expect(normalizeErc8004Id("EIP155:84532:0xABC:42")).toBe("eip155:84532:0xabc:42");
    expect(normalizeAgentId("agt_\u00e9")).toBeNull();
    expect(normalizeAgentId("agt_foo")).toBeNull();
    expect(normalizeAgentId(OTHER_AGENT_ID.toLowerCase())).toBeNull();
    expect(normalizeAgentId(`${OTHER_AGENT_ID} `)).toBeNull();
    expect(normalizeErc8004Id("4 2")).toBeNull();
    expect(normalizeErc8004Id("x".repeat(200))).toBe("x".repeat(200));
    expect(normalizeErc8004Id("x".repeat(201))).toBeNull();
    expect(normalizeErc8004Id("\u212a")).toBeNull();
  });

  it("dispatches by identifier type", () => {
    expect(normalizeIdentifier("address", ADDR.alice.toUpperCase().replace("0X", "0x"))).toBe(ADDR.alice);
    expect(normalizeIdentifier("agent_id", OTHER_AGENT_ID)).toBe(OTHER_AGENT_ID);
    expect(normalizeIdentifier("erc8004_id", "ABC")).toBe("abc");
    expect(normalizeIdentifier("x402_domain", "A.COM")).toBe("a.com");
  });

  it("classifies AP2 payee ids by shape", () => {
    expect(classifyPayeeId(ADDR.alice)).toEqual({ type: "address", value: ADDR.alice });
    expect(classifyPayeeId(OTHER_AGENT_ID)).toEqual({ type: "agent_id", value: OTHER_AGENT_ID });
    expect(classifyPayeeId("API.example.com")).toEqual({ type: "x402_domain", value: "api.example.com" });
    expect(classifyPayeeId("42")).toEqual({ type: "erc8004_id", value: "42" });
    expect(classifyPayeeId("eip155:1:0xAbC:7")).toEqual({ type: "erc8004_id", value: "eip155:1:0xabc:7" });
    expect(classifyPayeeId("a..b")).toEqual({ type: "erc8004_id", value: "a..b" });
    expect(classifyPayeeId("agt_ bad")).toBeNull();
    expect(classifyPayeeId("bad id")).toBeNull();
    expect(classifyPayeeId(7)).toBeNull();
  });
});

describe("agent id fixtures", () => {
  it("are well-formed agent ids, like the ones newId produces", () => {
    expect(isId("agent", AGENT_ID)).toBe(true);
    expect(isId("agent", OTHER_AGENT_ID)).toBe(true);
    const fresh = newId("agent");
    const p = compilePolicy({ counterparties: { mode: "allowlist", agent_ids: [fresh] } }, 1);
    expect([...(p.counterparties.allow?.agentIds ?? [])]).toEqual([fresh]);
    expect(normalizeAgentId(fresh)).toBe(fresh);
  });
});

describe("outcome severity", () => {
  it("orders deny > require_owner > require_approval > allow", () => {
    expect(OUTCOME_SEVERITY.deny).toBeGreaterThan(OUTCOME_SEVERITY.require_owner);
    expect(mostSevere("allow", "require_approval")).toBe("require_approval");
    expect(mostSevere("deny", "require_owner")).toBe("deny");
    expect(mostSevere("require_owner", "require_approval")).toBe("require_owner");
  });
});

describe("compilePolicy", () => {
  it("compiles the design example", () => {
    const p = compilePolicy(DESIGN_EXAMPLE, 3);
    expect(p.version).toBe(3);
    expect(p.asset).toBe("USDC");
    expect(p.decimals).toBe(6);
    expect(p.limits).toEqual({
      perTx: $("25.00"),
      perDay: $("200.00"),
      perWeek: null,
      perMonth: $("2000.00"),
    });
    expect(p.counterparties.mode).toBe("allowlist");
    expect([...(p.counterparties.allow?.x402Domains ?? [])]).toEqual([DOMAIN]);
    expect(p.counterparties.deny.addresses.size).toBe(0);
    expect(p.counterparties.cooldownMinutes).toBe(60);
    expect(p.velocity).toEqual({ perMinute: 30, perHour: null, perDay: null });
    expect(p.approvals).toEqual([
      { above: $("100.00"), approvers: 1 },
      { above: $("1000.00"), approvers: 2 },
    ]);
    expect(p.maxBalance).toBe($("500.00"));
    expect(p.timeWindows).toBeNull();
    expect(p.allowedKinds).toBeNull();
    expect(p.autoSave).toBeNull();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.limits)).toBe(true);
  });

  it("applies schema defaults to a minimal document", () => {
    const p = compilePolicy({}, 0);
    expect(p.counterparties.mode).toBe("open");
    expect(p.counterparties.allow).toBeNull();
    expect(p.counterparties.cooldownMinutes).toBe(0);
    expect(p.source.asset).toBe("USDC");
    expect(p.agent).toBeNull();
  });

  it("normalizes identifiers and builds the effective denylist", () => {
    const p = compilePolicy(
      {
        counterparties: {
          mode: "denylist",
          addresses: ["0x52908400098527886E0F7030069857D2E4169EE7"],
          erc8004_ids: ["ABC:1"],
          deny: { x402_domains: ["evil.example"], agent_ids: [OTHER_AGENT_ID] },
          caps: [{ match: { address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, per_day: "5" }],
        },
      },
      1,
    );
    expect([...p.counterparties.deny.addresses]).toEqual(["0x52908400098527886e0f7030069857d2e4169ee7"]);
    expect([...p.counterparties.deny.erc8004Ids]).toEqual(["abc:1"]);
    expect([...p.counterparties.deny.x402Domains]).toEqual(["evil.example"]);
    expect([...p.counterparties.deny.agentIds]).toEqual([OTHER_AGENT_ID]);
    expect(p.counterparties.caps).toEqual([
      {
        type: "address",
        value: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        perTx: null,
        perDay: $("5"),
        perMonth: null,
      },
    ]);
  });

  it("merges duplicate approval thresholds and carries approver counts upward", () => {
    const p = compilePolicy(
      {
        approvals: [
          { above: "500", approvers: 1 },
          { above: "100", approvers: 2 },
          { above: "500", approvers: 3 },
          { above: "50", approvers: 1 },
        ],
      },
      1,
    );
    expect(p.approvals).toEqual([
      { above: $("50"), approvers: 1 },
      { above: $("100"), approvers: 2 },
      { above: $("500"), approvers: 3 },
    ]);
  });

  it("compiles auto-save rules with stable keys", () => {
    const p = compilePolicy(
      {
        auto_save: {
          income_split: { bps: 1000, to: "treasury" },
          excess_sweep: { to: "vault:vlt_01JABCDEFGHJKMNPQRSTVWXYZ0" },
          round_up: { to_nearest: "1.00", to: "treasury" },
          scheduled: [
            { amount: "10", every: "day", to: "treasury" },
            { amount: "10.00", every: "day", to: "treasury" },
            { amount: "5", every: "week", to: "treasury" },
          ],
        },
      },
      1,
    );
    expect(p.autoSave?.incomeSplit).toEqual({ bps: 1000, to: "treasury" });
    expect(p.autoSave?.roundUp).toEqual({ toNearest: $("1.00"), to: "treasury" });
    expect(p.autoSave?.scheduled.map((s) => s.key)).toEqual([
      "day:10000000:treasury",
      "day:10000000:treasury#2",
      "week:5000000:treasury",
    ]);
  });

  const invalid: Array<[string, PolicyDocumentInput | unknown]> = [
    ["unknown field", { surprise: true }],
    ["number amount", { limits: { per_tx: 25 } }],
    ["amount above the ledger range", { limits: { per_tx: "999999999999999999" } }],
    [
      "unknown time zone",
      { time_windows: [{ days: ["mon"], start: "09:00", end: "17:00", timezone: "Mars/Olympus" }] },
    ],
    ["end after 24:00", { time_windows: [{ days: ["mon"], start: "09:00", end: "24:30" }] }],
    ["empty window", { time_windows: [{ days: ["mon"], start: "09:00", end: "09:00" }] }],
    ["zero round-up", { auto_save: { round_up: { to_nearest: "0", to: "treasury" } } }],
    ["bad cap match", { counterparties: { caps: [{ match: {}, per_tx: "1" }] } }],
    ["unicode agent id", { counterparties: { mode: "allowlist", agent_ids: ["agt_\u00e9"] } }],
    [
      "cap on unicode agent",
      { counterparties: { caps: [{ match: { agent_id: "agt_ \u00e9" }, per_tx: "1" }] } },
    ],
    [
      "numeric host that passes the schema",
      { counterparties: { mode: "allowlist", x402_domains: ["3232235521"] } },
    ],
  ];

  it.each(invalid)("rejects %s", (_name, doc) => {
    expect(() => compilePolicy(doc as PolicyDocumentInput, 1)).toThrow(AgentBankError);
  });

  it("names the failing path", () => {
    expect(() => compilePolicy({ limits: { per_tx: "999999999999999999" } }, 1)).toThrow(/limits\.per_tx/);
    expect(() =>
      compilePolicy({ counterparties: { mode: "allowlist", agent_ids: ["agt_\u00e9"] } }, 1),
    ).toThrow(/counterparties\.agent_ids\.0/);
    expect(() => compilePolicy("nope" as never, 1)).toThrow(/\(root\)/);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])("rejects version %s", (version) => {
    expect(() => compilePolicy({}, version)).toThrow(/version/);
  });
});
