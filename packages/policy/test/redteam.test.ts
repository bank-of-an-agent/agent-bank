import { usdc, type PolicyDocumentInput } from "@agentbank/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  compileMandate,
  compilePolicy,
  compileSessionScope,
  evaluate,
  type CompiledPolicy,
  type Decision,
  type EvaluationContext,
  type EvaluationIntent,
  type IntentCounterparty,
  type SpendHistory,
} from "../src";
import { agentId } from "./helpers";

/**
 * Red-team generator (Phase 2 gate evidence).
 *
 * Throws thousands of adversarial payment intents at four representative
 * policies and asserts that no intent which exceeds any limit, pays a
 * counterparty that is not allowlisted (or is denylisted), or comes from a
 * frozen agent / expired session / expired mandate is ever allowed. Every
 * label comes from an oracle written independently of the engine: ground
 * truth is fixed by construction (the generator knows which identity each
 * spelling denotes), limits are re-checked from the policy documents, and
 * time windows from a hard-coded DST table rather than `Intl`.
 *
 * Benign controls are mixed in and must NOT be denied, so the evidence is
 * not satisfied by an engine that simply refuses everything.
 *
 * All randomness comes from a seeded xorshift generator: runs are
 * reproducible.
 */

// ------------------------------------------------------------------ fixtures

const AGENT = agentId(9001);
const PARTNER = agentId(9002);
const EVIL_AGENT = agentId(9666);
const PARTNER_8004 = "eip155:84532:0x8004a6090cd10a7288092483047b097295fb8847:7";
const SPEND_KEY = "0x5dc0000000000000000000000000000000000001";
const SELLER = "0x5e11e40000000000000000000000000000000001";
const VENDOR_A = "0xa11ce00000000000000000000000000000000a11";
const VENDOR_B = "0xb0b0000000000000000000000000000000000b0b";
const PARTNER_ACCOUNT = "0x9a47e40000000000000000000000000000000002";
const ALICE = "0x1111111111111111111111111111111111111111";
const EVIL_ADDR = "0xbad0000000000000000000000000000000000bad";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const ESCROW_CONTRACT = "0xe5c0000000000000000000000000000000000001";
const DATA_HOST = "api.example-data.com";
const TOOLS_HOST = "tools.example.org";
const KB_HOST = "kb.example.net";
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const DOCS = {
  research: {
    agent: AGENT,
    limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
    counterparties: {
      mode: "allowlist",
      x402_domains: [DATA_HOST, TOOLS_HOST, KB_HOST],
      new_cooldown_minutes: 60,
      caps: [{ match: { x402_domain: TOOLS_HOST }, per_day: "20.00" }],
    },
    velocity: { max_per_minute: 30 },
    approvals: [
      { above: "100.00", approvers: 1 },
      { above: "1000.00", approvers: 2 },
    ],
    max_balance: "500.00",
  },
  payouts: {
    agent: AGENT,
    limits: { per_tx: "1000.00", per_day: "5000.00", per_week: "20000.00" },
    counterparties: {
      mode: "allowlist",
      addresses: [VENDOR_A, VENDOR_B],
      agent_ids: [PARTNER],
      erc8004_ids: [PARTNER_8004],
      deny: { addresses: [EVIL_ADDR] },
      caps: [
        { match: { address: VENDOR_A }, per_day: "2000.00", per_month: "10000.00" },
        { match: { agent_id: PARTNER }, per_tx: "300.00" },
      ],
    },
    velocity: { max_per_hour: 10, max_per_day: 40 },
    time_windows: [{ days: [...WEEKDAYS], start: "09:00", end: "17:00", timezone: "America/New_York" }],
    require_owner_above: "2500.00",
    approvals: [
      { above: "500.00", approvers: 1 },
      { above: "2000.00", approvers: 2 },
    ],
    allowed_kinds: ["transfer", "payout", "escrow"],
  },
  open: {
    limits: { per_tx: "50.00", per_day: "300.00" },
    counterparties: {
      mode: "denylist",
      addresses: [EVIL_ADDR],
      x402_domains: ["evil.example.com"],
      deny: { agent_ids: [EVIL_AGENT] },
    },
    velocity: { max_per_minute: 5, max_per_day: 100 },
    time_windows: [
      { days: [...ALL_DAYS], start: "08:00", end: "20:00", timezone: "Europe/London" },
      { days: ["fri", "sat"], start: "22:00", end: "02:00", timezone: "Europe/London" },
    ],
  },
  escrow: {
    allowed_kinds: ["escrow", "stream"],
    limits: { per_tx: "300.00", per_month: "1000.00" },
    counterparties: { mode: "allowlist", agent_ids: [PARTNER] },
  },
} satisfies Record<string, PolicyDocumentInput>;

type PolicyName = keyof typeof DOCS;
const POLICIES: Record<PolicyName, CompiledPolicy> = {
  research: compilePolicy(DOCS.research, 1),
  payouts: compilePolicy(DOCS.payouts, 1),
  open: compilePolicy(DOCS.open, 1),
  escrow: compilePolicy(DOCS.escrow, 1),
};

/** Monday 12 Oct 2026 15:00Z: 11:00 in New York, 16:00 in London. */
const BASE_NOW = Date.parse("2026-10-12T15:00:00Z");
const LONG_AGO = new Date("2026-01-01T00:00:00Z");
const $ = usdc;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ PRNG

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }
  int(n: number): number {
    return this.next() % n;
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)] as T;
  }
  big(max: bigint): bigint {
    return ((BigInt(this.next()) << 32n) | BigInt(this.next())) % (max + 1n);
  }
}
const rng = new Rng(0x8a5e_2026);

// ------------------------------------------------------------------ contexts

function history(overrides: Partial<SpendHistory> = {}): SpendHistory {
  return {
    spentLastDay: 0n,
    spentLastWeek: 0n,
    spentLastMonth: 0n,
    countLastMinute: 0,
    countLastHour: 0,
    countLastDay: 0,
    counterpartySpentLastDay: 0n,
    counterpartySpentLastMonth: 0n,
    counterpartyFirstSeenAt: LONG_AGO,
    ...overrides,
  };
}

interface Spec {
  now?: number;
  intent?: Partial<EvaluationIntent>;
  history?: Partial<SpendHistory>;
  agent?: Partial<EvaluationContext["agent"]>;
  org?: EvaluationContext["org"];
  mandate?: EvaluationContext["mandate"];
  session?: EvaluationContext["session"];
}

/** Benign baseline payment for each policy; every control starts from it. */
const BASELINE: Record<PolicyName, EvaluationIntent> = {
  research: {
    kind: "x402",
    amount: $("0.50"),
    asset: "USDC",
    counterparty: { x402Domain: DATA_HOST, address: SELLER },
  },
  payouts: { kind: "transfer", amount: $("100.00"), asset: "USDC", counterparty: { address: VENDOR_B } },
  open: { kind: "transfer", amount: $("10.00"), asset: "USDC", counterparty: { address: ALICE } },
  escrow: {
    kind: "escrow",
    amount: $("100.00"),
    asset: "USDC",
    counterparty: { agentId: PARTNER, address: PARTNER_ACCOUNT },
    contract: ESCROW_CONTRACT,
  },
};

function ctx(policy: PolicyName, spec: Spec = {}): EvaluationContext {
  return {
    now: new Date(spec.now ?? BASE_NOW),
    agent: { id: AGENT, status: "active", spendKeyAddress: SPEND_KEY, ...spec.agent },
    org: spec.org ?? { status: "active" },
    intent: { ...BASELINE[policy], ...spec.intent },
    history: history(spec.history),
    mandate: spec.mandate ?? null,
    session: spec.session ?? null,
  };
}

// ------------------------------------------------------------------ attempts

interface Attempt {
  category: string;
  policy: PolicyName;
  why: string;
  ctx: EvaluationContext;
  /** Must the engine deny it? `false` = benign control that must not be denied. */
  mustDeny: boolean;
}

const attempts: Attempt[] = [];
const attack = (category: string, policy: PolicyName, why: string, c: EvaluationContext): void => {
  attempts.push({ category, policy, why, ctx: c, mustDeny: true });
};
const control = (category: string, policy: PolicyName, why: string, c: EvaluationContext): void => {
  attempts.push({ category, policy, why, ctx: c, mustDeny: false });
};

// ------------------------------------------------------------------ oracle (independent of the engine)

/** Limit breaches, re-derived from the policy document with plain bigint arithmetic. */
function limitBreaches(policy: PolicyName, c: EvaluationContext): string[] {
  const doc: PolicyDocumentInput = DOCS[policy];
  const out: string[] = [];
  const amount = c.intent.amount;
  const h = c.history;
  const money = [
    amount,
    h.spentLastDay,
    h.spentLastWeek,
    h.spentLastMonth,
    h.counterpartySpentLastDay,
    h.counterpartySpentLastMonth,
  ];
  const counts = [h.countLastMinute, h.countLastHour, h.countLastDay];
  if (
    typeof amount !== "bigint" ||
    amount <= 0n ||
    money.some((v) => typeof v !== "bigint" || v < 0n) ||
    counts.some((v) => !Number.isInteger(v) || v < 0)
  ) {
    return ["malformed context"];
  }
  const limits = doc.limits ?? {};
  if (limits.per_tx !== undefined && amount > $(limits.per_tx)) out.push("per_tx");
  if (limits.per_day !== undefined && h.spentLastDay + amount > $(limits.per_day)) out.push("per_day");
  if (limits.per_week !== undefined && h.spentLastWeek + amount > $(limits.per_week)) out.push("per_week");
  if (limits.per_month !== undefined && h.spentLastMonth + amount > $(limits.per_month))
    out.push("per_month");
  const cp: IntentCounterparty = c.intent.counterparty ?? {};
  for (const cap of doc.counterparties?.caps ?? []) {
    const m = cap.match;
    const hit =
      (m.address !== undefined && cp.address?.toLowerCase() === m.address.toLowerCase()) ||
      (m.agent_id !== undefined && cp.agentId === m.agent_id) ||
      (m.x402_domain !== undefined && cp.x402Domain === m.x402_domain);
    if (!hit) continue;
    if (cap.per_tx !== undefined && amount > $(cap.per_tx)) out.push("cap.per_tx");
    if (cap.per_day !== undefined && h.counterpartySpentLastDay + amount > $(cap.per_day))
      out.push("cap.per_day");
    if (cap.per_month !== undefined && h.counterpartySpentLastMonth + amount > $(cap.per_month))
      out.push("cap.per_month");
  }
  const v = doc.velocity ?? {};
  if (v.max_per_minute !== undefined && h.countLastMinute >= v.max_per_minute) out.push("velocity.minute");
  if (v.max_per_hour !== undefined && h.countLastHour >= v.max_per_hour) out.push("velocity.hour");
  if (v.max_per_day !== undefined && h.countLastDay >= v.max_per_day) out.push("velocity.day");
  return out;
}

/**
 * New York and London wall clocks from a hard-coded 2026 DST table (no Intl):
 * New York is UTC-4 from 2026-03-08T07:00Z to 2026-11-01T06:00Z, else UTC-5;
 * London is UTC+1 from 2026-03-29T01:00Z to 2026-10-25T01:00Z, else UTC+0.
 */
function wallClock(zone: "ny" | "london", t: number): { day: number; minute: number } {
  const offset =
    zone === "ny"
      ? t >= Date.parse("2026-03-08T07:00:00Z") && t < Date.parse("2026-11-01T06:00:00Z")
        ? -4 * HOUR
        : -5 * HOUR
      : t >= Date.parse("2026-03-29T01:00:00Z") && t < Date.parse("2026-10-25T01:00:00Z")
        ? HOUR
        : 0;
  const local = new Date(t + offset);
  return { day: (local.getUTCDay() + 6) % 7, minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

function insideWindows(policy: "payouts" | "open", t: number): boolean {
  if (policy === "payouts") {
    const { day, minute } = wallClock("ny", t);
    return day <= 4 && minute >= 9 * 60 && minute < 17 * 60;
  }
  const { day, minute } = wallClock("london", t);
  if (minute >= 8 * 60 && minute < 20 * 60) return true;
  if ((day === 4 || day === 5) && minute >= 22 * 60) return true; // Fri/Sat 22:00-24:00
  return (day === 5 || day === 6) && minute < 2 * 60; // Sat/Sun 00:00-02:00
}

// ------------------------------------------------------------------ generators

// 1. Amounts just over (and exactly at) every cap, including split-payment boundaries.
{
  type Dim = { name: string; build: (delta: bigint) => Spec };
  const base = (p: PolicyName) => BASELINE[p].amount;
  const dims: Record<PolicyName, Dim[]> = {
    research: [
      { name: "per_tx", build: (d) => ({ intent: { amount: $("25.00") + d } }) },
      {
        name: "per_day",
        build: (d) => ({
          history: { spentLastDay: $("200.00") - base("research") + d, spentLastMonth: $("200.00") },
        }),
      },
      {
        name: "per_month",
        build: (d) => ({ history: { spentLastMonth: $("2000.00") - base("research") + d } }),
      },
      {
        name: "cap tools per_day",
        build: (d) => ({
          intent: { counterparty: { x402Domain: TOOLS_HOST, address: SELLER } },
          history: { counterpartySpentLastDay: $("20.00") - base("research") + d },
        }),
      },
      { name: "velocity minute", build: (d) => ({ history: { countLastMinute: 30 + Number(d % 7n) - 1 } }) },
    ],
    payouts: [
      { name: "per_tx", build: (d) => ({ intent: { amount: $("1000.00") + d } }) },
      {
        name: "per_day",
        build: (d) => ({
          history: { spentLastDay: $("5000.00") - base("payouts") + d, spentLastWeek: $("5000.00") },
        }),
      },
      {
        name: "per_week",
        build: (d) => ({ history: { spentLastWeek: $("20000.00") - base("payouts") + d } }),
      },
      {
        name: "cap vendor A per_day",
        build: (d) => ({
          intent: { counterparty: { address: VENDOR_A } },
          history: { counterpartySpentLastDay: $("2000.00") - base("payouts") + d },
        }),
      },
      {
        name: "cap vendor A per_month",
        build: (d) => ({
          intent: { counterparty: { address: VENDOR_A } },
          history: { counterpartySpentLastMonth: $("10000.00") - base("payouts") + d },
        }),
      },
      {
        name: "cap partner per_tx",
        build: (d) => ({
          intent: { amount: $("300.00") + d, counterparty: { agentId: PARTNER, address: PARTNER_ACCOUNT } },
        }),
      },
      { name: "velocity hour", build: (d) => ({ history: { countLastHour: 10 + Number(d % 5n) - 1 } }) },
      { name: "velocity day", build: (d) => ({ history: { countLastDay: 40 + Number(d % 5n) - 1 } }) },
    ],
    open: [
      { name: "per_tx", build: (d) => ({ intent: { amount: $("50.00") + d } }) },
      { name: "per_day", build: (d) => ({ history: { spentLastDay: $("300.00") - base("open") + d } }) },
      { name: "velocity minute", build: (d) => ({ history: { countLastMinute: 5 + Number(d % 4n) - 1 } }) },
      { name: "velocity day", build: (d) => ({ history: { countLastDay: 100 + Number(d % 4n) - 1 } }) },
    ],
    escrow: [
      { name: "per_tx", build: (d) => ({ intent: { amount: $("300.00") + d } }) },
      {
        name: "per_month",
        build: (d) => ({ history: { spentLastMonth: $("1000.00") - base("escrow") + d } }),
      },
    ],
  };
  for (const policy of Object.keys(dims) as PolicyName[]) {
    for (const dim of dims[policy]) {
      const deltas = [
        -1n,
        0n,
        1n,
        2n,
        10_000n,
        1_000_000n,
        ...Array.from({ length: 24 }, () => 1n + rng.big(500_000_000n)),
      ];
      for (const delta of deltas) {
        const c = ctx(policy, dim.build(delta));
        if (c.intent.amount <= 0n || Object.values(c.history).some((v) => typeof v === "bigint" && v < 0n))
          continue;
        const breaches = limitBreaches(policy, c);
        const why = `${dim.name} with delta ${delta}: ${breaches.join(", ") || "within"}`;
        if (breaches.length > 0) attack("amount over cap", policy, why, c);
        else control("amount over cap", policy, why, c);
      }
    }
  }
}

// 2. Host-name tricks against the x402 allowlist. Aliases denote the same host.
{
  const aliases = (h: string) => [
    h.toUpperCase(),
    `${h}.`,
    h.replace(/^./, (c) => c.toUpperCase()),
    `${h.toUpperCase()}.`,
  ];
  const lookalikes = (h: string) => [
    h.replace("a", "\u0430"), // Cyrillic a
    h.replace("e", "\u0435"), // Cyrillic e
    h.replace("o", "\u03bf"), // Greek omicron
    h.replace(/^[a-z]+/, (w) => [...w].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("")), // fullwidth
    h.replace("k", "\u212a"), // Kelvin sign
    h.replace(".", "\u3002"), // ideographic full stop
    h.replace(".", "\uff0e"), // fullwidth full stop
    `${h}\u200b`,
    h.replace(".", "\u200d."),
    `\ufeff${h}`,
    h.replace(".", "\u00ad."),
    h.replace(/^./, (c) => `${c}\u0301`),
    `\u202e${h}`,
    `evil.${h}`,
    `${h}.evil.com`,
    `${h}.co`,
    `x${h}`,
    h.replace(".", "-"),
    h.replace(".", ""),
    h.slice(h.indexOf(".") + 1),
    h.replace("-", "_"),
    `${h}m`,
    `xn--${h.replace(/\./g, "-")}.com`,
    `${h}/`,
    `${h}:443`,
    `${h}:8080`,
    `user@${h}`,
    `${h}@evil.com`,
    `evil.com#${h}`,
    `evil.com?${h}`,
    `${h}\\evil.com`,
    `https://${h}`,
    `//${h}`,
    ` ${h}`,
    `${h} `,
    `${h}\n`,
    `\t${h}`,
    `${h}..`,
    `.${h}`,
    h.replace(".", ".."),
    h.replace(".", "%2e"),
    `%61${h.slice(1)}`,
    `*.${h.slice(h.indexOf(".") + 1)}`,
    `${h}\u0000.evil.com`,
    "[::1]",
    "127.0.0.1",
    "",
    ".",
  ];
  for (const host of [DATA_HOST, TOOLS_HOST, KB_HOST]) {
    for (const amount of ["0.01", "1.00", "9.99"]) {
      for (const alias of aliases(host)) {
        control(
          "host-name tricks",
          "research",
          `alias ${JSON.stringify(alias)}`,
          ctx("research", {
            intent: { amount: $(amount), counterparty: { x402Domain: alias, address: SELLER } },
          }),
        );
      }
      for (const fake of new Set(lookalikes(host))) {
        if (fake === host) continue;
        attack(
          "host-name tricks",
          "research",
          `lookalike ${JSON.stringify(fake)}`,
          ctx("research", {
            intent: { amount: $(amount), counterparty: { x402Domain: fake, address: SELLER } },
          }),
        );
      }
    }
  }
}

// 3a. IP-literal hosts: policies can only name DNS hosts, so an x402 payment
// to an IP literal (in any spelling) is refused whatever the mode; otherwise
// an endpoint could dodge a denylist by being addressed by IP.
{
  const ipHosts = [
    "192.168.0.1",
    "192.168.0.1.",
    "3232235521",
    "0xc0a80001",
    "0300.0250.0.1",
    "192.168.1",
    "192.168.0.01",
    "192.168.000.001",
    "0xc0.0xa8.0.1",
    "0x00c0a80001",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "10.0.0.1",
    "1.1.1.1",
    "8.8.8.8",
    "[::1]",
    "::1",
    "[2001:db8::1]",
  ];
  for (const policy of ["open", "research"] as const) {
    for (const host of ipHosts) {
      attack(
        "IP-literal hosts",
        policy,
        `x402 to the IP-literal host ${JSON.stringify(host)}`,
        ctx(policy, { intent: { kind: "x402", counterparty: { x402Domain: host, address: SELLER } } }),
      );
    }
  }
  control(
    "IP-literal hosts",
    "open",
    "x402 to an ordinary host",
    ctx("open", {
      intent: { kind: "x402", counterparty: { x402Domain: "fine.example.com", address: SELLER } },
    }),
  );
}

// 3b. Denylist evasion: every alias of a denylisted identity must stay denied.
{
  const denied = [
    "EVIL.example.com",
    "evil.example.com.",
    "Evil.Example.Com.",
    "evil.example.com",
    "EVIL.EXAMPLE.COM.",
  ];
  for (const host of denied) {
    attack(
      "denylist evasion",
      "open",
      `x402 to denylisted host spelled ${JSON.stringify(host)}`,
      ctx("open", { intent: { kind: "x402", counterparty: { x402Domain: host, address: SELLER } } }),
    );
  }
  const checksummed = `0x${EVIL_ADDR.slice(2).toUpperCase()}`;
  for (const address of [
    EVIL_ADDR,
    checksummed,
    `0x${EVIL_ADDR.slice(2, 22).toUpperCase()}${EVIL_ADDR.slice(22)}`,
  ]) {
    for (const kind of ["transfer", "payout", "escrow", "stream"] as const) {
      attack(
        "denylist evasion",
        "open",
        `${kind} to denylisted address spelled ${address}`,
        ctx("open", { intent: { kind, counterparty: { address } } }),
      );
    }
    attack(
      "denylist evasion",
      "open",
      `x402 whose payTo is denylisted (${address})`,
      ctx("open", { intent: { kind: "x402", counterparty: { x402Domain: "fine.example.com", address } } }),
    );
    attack(
      "denylist evasion",
      "payouts",
      `denylisted address ${address} inside an allowlist policy`,
      ctx("payouts", { intent: { counterparty: { address } } }),
    );
  }
  attack(
    "denylist evasion",
    "open",
    "denylisted agent id with an innocent address",
    ctx("open", { intent: { counterparty: { agentId: EVIL_AGENT, address: ALICE } } }),
  );
  attack(
    "denylist evasion",
    "open",
    "denylisted agent id alone",
    ctx("open", { intent: { counterparty: { agentId: EVIL_AGENT } } }),
  );
  control("denylist evasion", "open", "an unrelated payee", ctx("open"));
}

// 4. Lookalike and malformed addresses against an address allowlist.
{
  const hexDigits = "0123456789abcdef";
  for (const target of [VENDOR_A, VENDOR_B]) {
    for (let i = 2; i < 42; i++) {
      const current = target[i] ?? "0";
      const replacement = hexDigits[(hexDigits.indexOf(current) + 1 + rng.int(15)) % 16] ?? "f";
      const fake = `${target.slice(0, i)}${replacement}${target.slice(i + 1)}`;
      attack(
        "lookalike addresses",
        "payouts",
        `one nibble off at ${i}: ${fake}`,
        ctx("payouts", { intent: { counterparty: { address: fake } } }),
      );
    }
    for (let n = 0; n < 15; n++) {
      // Address poisoning: same first 6 and last 4 characters.
      let middle = "";
      for (let k = 0; k < 32; k++) middle += hexDigits[rng.int(16)];
      const fake = `${target.slice(0, 8)}${middle}${target.slice(38)}`;
      if (fake === target) continue;
      attack(
        "lookalike addresses",
        "payouts",
        `poisoned lookalike ${fake}`,
        ctx("payouts", { intent: { counterparty: { address: fake } } }),
      );
    }
    const malformed = [
      `0X${target.slice(2)}`,
      target.slice(2),
      target.slice(0, 41),
      `${target}0`,
      ` ${target}`,
      `${target}\n`,
      target.replace(/1/g, "l"),
      target.replace(/0/g, "o"),
      target.replace(/1/, "\uff11"),
      target.replace(/0/, "\u0660"),
      `${target.slice(0, 20)}\u200b${target.slice(20)}`,
      "0x0000000000000000000000000000000000000000",
    ];
    for (const fake of malformed) {
      if (fake === target) continue;
      attack(
        "lookalike addresses",
        "payouts",
        `malformed ${JSON.stringify(fake)}`,
        ctx("payouts", { intent: { counterparty: { address: fake } } }),
      );
    }
    control(
      "lookalike addresses",
      "payouts",
      "upper-case hex alias",
      ctx("payouts", { intent: { counterparty: { address: `0x${target.slice(2).toUpperCase()}` } } }),
    );
    control(
      "lookalike addresses",
      "payouts",
      "exact address",
      ctx("payouts", { intent: { counterparty: { address: target } } }),
    );
  }
}

// 5. Identifier confusion: the wrong kind of identifier never satisfies an allowlist.
{
  const cases: Array<[PolicyName, string, Partial<EvaluationIntent>]> = [
    [
      "research",
      "transfer to an address under an x402-only allowlist",
      { kind: "transfer", counterparty: { address: SELLER } },
    ],
    [
      "research",
      "transfer naming an allowlisted host",
      { kind: "transfer", counterparty: { x402Domain: DATA_HOST, address: ATTACKER } },
    ],
    [
      "research",
      "payout naming an allowlisted host",
      { kind: "payout", counterparty: { x402Domain: DATA_HOST, address: ATTACKER } },
    ],
    ["research", "x402 without a host", { kind: "x402", counterparty: { address: SELLER } }],
    ["research", "x402 naming only an agent", { kind: "x402", counterparty: { agentId: PARTNER } }],
    [
      "research",
      "escrow naming an allowlisted host",
      { kind: "escrow", counterparty: { x402Domain: DATA_HOST }, contract: ESCROW_CONTRACT },
    ],
    ["payouts", "agent id with upper-case prefix", { counterparty: { agentId: PARTNER.toUpperCase() } }],
    ["payouts", "agent id with lower-case body", { counterparty: { agentId: PARTNER.toLowerCase() } }],
    ["payouts", "agent id with trailing space", { counterparty: { agentId: `${PARTNER} ` } }],
    ["payouts", "agent id with zero-width space", { counterparty: { agentId: `${PARTNER}\u200b` } }],
    ["payouts", "agent id prefix", { counterparty: { agentId: PARTNER.slice(0, -1) } }],
    ["payouts", "agent id extended", { counterparty: { agentId: `${PARTNER}0` } }],
    ["payouts", "ERC-8004 id of another token", { counterparty: { erc8004Id: `${PARTNER_8004}0` } }],
    ["payouts", "ERC-8004 id with a space", { counterparty: { erc8004Id: `${PARTNER_8004} ` } }],
    [
      "payouts",
      "ERC-8004 id on another chain",
      { counterparty: { erc8004Id: PARTNER_8004.replace("84532", "8453") } },
    ],
    [
      "payouts",
      "x402 to an allowlisted vendor address (kind not allowed)",
      { kind: "x402", counterparty: { x402Domain: DATA_HOST, address: VENDOR_A } },
    ],
    ["payouts", "payee with no identifiers", { counterparty: {} }],
    ["payouts", "payee missing", { counterparty: null as unknown as IntentCounterparty }],
    [
      "escrow",
      "escrow to an address not on the agent allowlist",
      { counterparty: { address: PARTNER_ACCOUNT } },
    ],
    ["escrow", "escrow to another agent", { counterparty: { agentId: EVIL_AGENT } }],
  ];
  for (const [policy, why, intent] of cases) {
    for (const amount of ["1.00", "10.00"]) {
      attack("identifier confusion", policy, why, ctx(policy, { intent: { amount: $(amount), ...intent } }));
    }
  }
  control(
    "identifier confusion",
    "payouts",
    "allowlisted agent id",
    ctx("payouts", { intent: { counterparty: { agentId: PARTNER, address: PARTNER_ACCOUNT } } }),
  );
  control(
    "identifier confusion",
    "payouts",
    "allowlisted ERC-8004 id, other case",
    ctx("payouts", { intent: { counterparty: { erc8004Id: PARTNER_8004.toUpperCase() } } }),
  );
}

// 6. Refill abuse: refills may only top up the agent's own spend key.
{
  const lookalikeKey = `${SPEND_KEY.slice(0, 41)}2`;
  const cases: Array<[string, Spec]> = [
    ["refill to an attacker", { intent: { kind: "refill", counterparty: { address: ATTACKER } } }],
    [
      "refill to a spend-key lookalike",
      { intent: { kind: "refill", counterparty: { address: lookalikeKey } } },
    ],
    ["refill naming only an agent", { intent: { kind: "refill", counterparty: { agentId: AGENT } } }],
    [
      "refill without a registered spend key",
      { agent: { spendKeyAddress: null }, intent: { kind: "refill", counterparty: { address: SPEND_KEY } } },
    ],
    [
      "refill with a malformed registered key",
      {
        agent: { spendKeyAddress: "0x5dc0" },
        intent: { kind: "refill", counterparty: { address: SPEND_KEY } },
      },
    ],
  ];
  for (const [why, spec] of cases) {
    for (const policy of ["research", "open"] as const)
      attack("refill abuse", policy, why, ctx(policy, spec));
  }
  for (const policy of ["research", "open"] as const) {
    const limits = DOCS[policy].limits;
    const refill = (amount: bigint, spentLastDay = 0n) =>
      ctx(policy, {
        intent: { kind: "refill", amount, counterparty: { address: SPEND_KEY } },
        history: { spentLastDay },
      });
    attack("refill abuse", policy, "refill above per_tx", refill($(limits.per_tx) + 1n));
    attack(
      "refill abuse",
      policy,
      "refill beyond the day",
      refill($("20.00"), $(limits.per_day) - $("19.99")),
    );
  }
  attack(
    "refill abuse",
    "escrow",
    "refill when refills are not an allowed kind",
    ctx("escrow", { intent: { kind: "refill", counterparty: { address: SPEND_KEY } } }),
  );
  control(
    "refill abuse",
    "research",
    "refill of the own spend key",
    ctx("research", {
      intent: {
        kind: "refill",
        amount: $("5.00"),
        counterparty: { address: SPEND_KEY.toUpperCase().replace("0X", "0x") },
      },
    }),
  );
}

// 7. Frozen agents and orgs.
{
  const statuses: Array<[string, Partial<EvaluationContext["agent"]>, EvaluationContext["org"]]> = [
    ["agent frozen", { status: "frozen" }, { status: "active" }],
    ["org frozen", {}, { status: "frozen" }],
    ["both frozen", { status: "frozen" }, { status: "frozen" }],
    ["agent status paused", { status: "paused" as never }, { status: "active" }],
    ["agent status Active", { status: "Active" as never }, { status: "active" }],
    ["agent status missing", { status: undefined as never }, { status: "active" }],
    ["org status ACTIVE", {}, { status: "ACTIVE" as never }],
  ];
  for (const policy of Object.keys(DOCS) as PolicyName[]) {
    for (const [why, agent, org] of statuses) {
      for (const amount of ["0.01", "1.00", "5.00"]) {
        attack(
          "frozen agent or org",
          policy,
          why,
          ctx(policy, { agent, org, intent: { amount: $(amount) } }),
        );
      }
    }
    control("frozen agent or org", policy, "active agent and org", ctx(policy));
  }
}

// 8. Expired, revoked or exceeded sessions and mandates.
{
  const scope = {
    max_per_tx: "10.00",
    max_per_day: "50.00",
    allowed_recipients: [SELLER],
    expires_at: "2026-10-12T16:00:00Z",
  };
  const session = (spentToday = 0n, revokedAt: Date | null = null) => ({
    scope: compileSessionScope(scope),
    spentToday,
    revokedAt,
  });
  const expiresAt = Date.parse(scope.expires_at);
  const sessionCases: Array<[string, Spec]> = [
    ["session expired exactly now", { now: expiresAt, session: session() }],
    ["session expired 1 ms ago", { now: expiresAt + 1, session: session() }],
    ["session expired a day ago", { now: expiresAt + DAY, session: session() }],
    ["session revoked a second ago", { session: session(0n, new Date(BASE_NOW - 1000)) }],
    ["session revoked now", { session: session(0n, new Date(BASE_NOW)) }],
    ["over the session max_per_tx", { intent: { amount: $("10.000001") }, session: session() }],
    ["over the session max_per_day", { intent: { amount: $("5.00") }, session: session($("45.000001")) }],
    [
      "recipient outside the session",
      { intent: { counterparty: { x402Domain: DATA_HOST, address: ATTACKER } }, session: session() },
    ],
    [
      "recipient unknown to the session",
      { intent: { counterparty: { x402Domain: DATA_HOST } }, session: session() },
    ],
  ];
  for (const [why, spec] of sessionCases) {
    for (const extra of [0, 1, 2]) {
      const now = (spec.now ?? BASE_NOW) + extra * 1000;
      attack(
        "expired session or mandate",
        "research",
        why,
        ctx("research", { ...spec, now: Math.max(now, spec.now ?? BASE_NOW) }),
      );
    }
  }
  control(
    "expired session or mandate",
    "research",
    "valid session",
    ctx("research", { session: session($("40.00")) }),
  );

  const iat = Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000);
  const exp = Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000);
  const m = compileMandate({
    vct: "mandate.payment.open.1",
    agent_id: AGENT,
    iat,
    exp,
    constraints: [
      { type: "agentbank.x402_domains", allowed: [DATA_HOST] },
      { type: "payment.amount_range", currency: "USD", max: 500 },
      { type: "payment.budget", currency: "USDC", max: 20_000_000 },
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 10 },
      {
        type: "payment.execution_date",
        not_before: "2026-10-05T00:00:00Z",
        not_after: "2026-10-15T00:00:00Z",
      },
    ],
  });
  const other = compileMandate({
    vct: "mandate.payment.open.1",
    agent_id: PARTNER,
    iat,
    exp,
    constraints: [{ type: "payment.budget", currency: "USDC", max: 20_000_000 }],
  });
  const mc = (spent = 0n, occurrences = 0) => ({ mandate: m, spent, occurrences, lastOccurrenceAt: null });
  const mandateCases: Array<[string, Spec]> = [
    ["mandate expired exactly now", { now: exp * 1000, mandate: mc() }],
    ["mandate expired long ago", { now: exp * 1000 + 30 * DAY, mandate: mc() }],
    ["mandate not yet issued", { now: iat * 1000 - 10 * MIN, mandate: mc() }],
    ["after the execution window", { now: Date.parse("2026-10-15T00:00:00.001Z"), mandate: mc() }],
    ["before the execution window", { now: Date.parse("2026-10-04T23:59:59.999Z"), mandate: mc() }],
    ["above the mandate's amount range", { intent: { amount: $("5.000001") }, mandate: mc() }],
    ["mandate budget exhausted", { intent: { amount: $("1.00") }, mandate: mc($("19.000001")) }],
    ["mandate occurrences used up", { mandate: mc(0n, 10) }],
    [
      "host allowlisted by policy but not by the mandate",
      { intent: { counterparty: { x402Domain: TOOLS_HOST, address: SELLER } }, mandate: mc() },
    ],
    [
      "transfer under an x402-only mandate",
      {
        intent: { kind: "transfer", counterparty: { x402Domain: DATA_HOST, address: SELLER } },
        mandate: mc(),
      },
    ],
    ["mandate granted to another agent", { mandate: { mandate: other, spent: 0n, occurrences: 0 } }],
  ];
  for (const [why, spec] of mandateCases) {
    for (const amount of ["0.25", "1.00", "4.99"]) {
      const intent = { amount: $(amount), ...spec.intent };
      attack("expired session or mandate", "research", why, ctx("research", { ...spec, intent }));
    }
  }
  control(
    "expired session or mandate",
    "research",
    "valid mandate",
    ctx("research", { mandate: mc($("10.00"), 3) }),
  );
}

// 9. Velocity bursts and history tampering.
{
  for (const [policy, field, max] of [
    ["research", "countLastMinute", 30],
    ["payouts", "countLastHour", 10],
    ["payouts", "countLastDay", 40],
    ["open", "countLastMinute", 5],
    ["open", "countLastDay", 100],
  ] as const) {
    for (const over of [0, 1, 2, 5, 50, 1000]) {
      attack(
        "velocity burst",
        policy,
        `${field} = ${max + over}`,
        ctx(policy, { history: { [field]: max + over } }),
      );
    }
    control(
      "velocity burst",
      policy,
      `${field} = ${max - 1}`,
      ctx(policy, { history: { [field]: max - 1 } }),
    );
  }
  const tampered: Array<[string, Partial<SpendHistory>]> = [
    ["negative day spend", { spentLastDay: -$("1000.00") }],
    ["negative month spend", { spentLastMonth: -1n }],
    ["negative counterparty spend", { counterpartySpentLastDay: -$("5.00") }],
    ["negative count", { countLastMinute: -100 }],
    ["fractional count", { countLastMinute: 0.5 }],
    ["NaN count", { countLastHour: Number.NaN }],
    ["infinite count", { countLastDay: Number.POSITIVE_INFINITY }],
    ["number spend", { spentLastDay: 0 as unknown as bigint }],
    ["string spend", { spentLastWeek: "0" as unknown as bigint }],
    ["invalid first-seen", { counterpartyFirstSeenAt: new Date(Number.NaN) }],
  ];
  for (const policy of Object.keys(DOCS) as PolicyName[]) {
    for (const [why, h] of tampered) attack("history tampering", policy, why, ctx(policy, { history: h }));
  }
}

// 10. Malformed amounts, assets and kinds.
{
  const amounts: Array<[string, bigint]> = [
    ["zero", 0n],
    ["minus one minor unit", -1n],
    ["negative cap", -$("25.00")],
    ["2^63", 2n ** 63n],
    ["2^64 + 1", 2n ** 64n + 1n],
    ["number", 5 as unknown as bigint],
    ["string", "5" as unknown as bigint],
  ];
  for (const policy of Object.keys(DOCS) as PolicyName[]) {
    for (const [why, amount] of amounts)
      attack("malformed amount, asset or kind", policy, `amount ${why}`, ctx(policy, { intent: { amount } }));
    for (const asset of ["usdc", "USDC ", "EURC", "", "ETH"]) {
      attack(
        "malformed amount, asset or kind",
        policy,
        `asset ${JSON.stringify(asset)}`,
        ctx(policy, { intent: { asset } }),
      );
    }
  }
  for (const kind of [
    "transfer",
    "payout",
    "x402",
    "refill",
    "Escrow",
    "ESCROW",
    "escrow ",
    "escrow\u200b",
    "",
    "stream\n",
  ]) {
    attack(
      "malformed amount, asset or kind",
      "escrow",
      `kind ${JSON.stringify(kind)}`,
      ctx("escrow", { intent: { kind: kind as never } }),
    );
  }
  control(
    "malformed amount, asset or kind",
    "escrow",
    "stream to the partner",
    ctx("escrow", { intent: { kind: "stream" } }),
  );
}

// 11. Time-window edges, including both DST transitions in New York and London.
{
  const instants: number[] = [];
  const nyDays = [
    "2026-03-06",
    "2026-03-09",
    "2026-10-30",
    "2026-11-02",
    "2026-10-12",
    "2026-03-07",
    "2026-03-08",
    "2026-11-01",
  ];
  for (const day of nyDays) {
    for (const hour of [13, 14, 21, 22]) {
      const t = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
      instants.push(t - HOUR, t - MIN, t - 1, t, t + 1, t + MIN);
    }
  }
  for (const t of instants) {
    const c = ctx("payouts", { now: t });
    const why = `New York business hours at ${new Date(t).toISOString()}`;
    if (insideWindows("payouts", t)) control("time-window edges", "payouts", why, c);
    else attack("time-window edges", "payouts", why, c);
  }
  const londonInstants: number[] = [];
  for (const [day, hours] of [
    ["2026-03-27", [8, 20, 22]],
    ["2026-03-28", [0, 2, 8, 20, 22]],
    ["2026-03-29", [0, 1, 2, 7, 8, 19, 20]],
    ["2026-10-23", [7, 19, 21, 22]],
    ["2026-10-24", [0, 1, 7, 19, 21, 22]],
    ["2026-10-25", [0, 1, 2, 3, 7, 8, 19, 20]],
  ] as const) {
    for (const hour of hours) {
      const t = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
      londonInstants.push(t - 1, t, t + 1, t + 30 * MIN);
    }
  }
  for (const t of londonInstants) {
    const c = ctx("open", { now: t });
    const why = `London windows at ${new Date(t).toISOString()}`;
    if (insideWindows("open", t)) control("time-window edges", "open", why, c);
    else attack("time-window edges", "open", why, c);
  }
}

// 12. Cooling period for first-time counterparties.
{
  for (const ago of [null, 0, 1, MIN, 30 * MIN, 59 * MIN, HOUR - 1]) {
    const firstSeen = ago === null ? null : new Date(BASE_NOW - ago);
    attack(
      "new-counterparty cooling",
      "research",
      `first seen ${ago === null ? "never" : `${ago} ms ago`}`,
      ctx("research", { history: { counterpartyFirstSeenAt: firstSeen } }),
    );
  }
  for (const ago of [HOUR, HOUR + 1, DAY]) {
    control(
      "new-counterparty cooling",
      "research",
      `first seen ${ago} ms ago`,
      ctx("research", { history: { counterpartyFirstSeenAt: new Date(BASE_NOW - ago) } }),
    );
  }
}

// ------------------------------------------------------------------ stateful simulations

interface Executed {
  at: number;
  amount: bigint;
  payee: string;
}

/**
 * Replays a stream of attempts against the engine with spend history derived
 * from what actually executed (approvals are granted adversarially: every
 * `require_approval` / `require_owner` executes). Returns the executed ledger.
 */
function simulate(
  policy: PolicyName,
  stream: Array<{ at: number; amount: bigint; counterparty: IntentCounterparty; payee: string }>,
): { executed: Executed[]; decisions: Decision[] } {
  const executed: Executed[] = [];
  const firstSeen = new Map<string, number>();
  const decisions: Decision[] = [];
  const within = (at: number, window: number, payee?: string) =>
    executed.filter((e) => e.at > at - window && e.at <= at && (payee === undefined || e.payee === payee));
  const total = (list: Executed[]) => list.reduce((sum, e) => sum + e.amount, 0n);
  for (const s of stream) {
    if (!firstSeen.has(s.payee)) firstSeen.set(s.payee, s.at - 2 * HOUR);
    const c = ctx(policy, {
      now: s.at,
      intent: { amount: s.amount, counterparty: s.counterparty },
      history: {
        spentLastDay: total(within(s.at, DAY)),
        spentLastWeek: total(within(s.at, 7 * DAY)),
        spentLastMonth: total(within(s.at, 30 * DAY)),
        countLastMinute: within(s.at, MIN).length,
        countLastHour: within(s.at, HOUR).length,
        countLastDay: within(s.at, DAY).length,
        counterpartySpentLastDay: total(within(s.at, DAY, s.payee)),
        counterpartySpentLastMonth: total(within(s.at, 30 * DAY, s.payee)),
        counterpartyFirstSeenAt: new Date(firstSeen.get(s.payee) ?? s.at),
      },
    });
    const d = evaluate(POLICIES[policy], c);
    decisions.push(d);
    if (d.outcome !== "deny") executed.push({ at: s.at, amount: s.amount, payee: s.payee });
  }
  return { executed, decisions };
}

/** Rolling-window breaches in an executed ledger, checked from the documents. */
function ledgerBreaches(policy: PolicyName, executed: Executed[]): string[] {
  const doc: PolicyDocumentInput = DOCS[policy];
  const out: string[] = [];
  const windows: Array<[string, number, string | undefined]> = [
    ["per_day", DAY, doc.limits?.per_day],
    ["per_week", 7 * DAY, doc.limits?.per_week],
    ["per_month", 30 * DAY, doc.limits?.per_month],
  ];
  for (const p of executed) {
    const inWindow = (w: number, payee?: string) =>
      executed.filter((e) => e.at > p.at - w && e.at <= p.at && (payee === undefined || e.payee === payee));
    const sum = (list: Executed[]) => list.reduce((s, e) => s + e.amount, 0n);
    if (doc.limits?.per_tx !== undefined && p.amount > $(doc.limits.per_tx)) out.push(`per_tx at ${p.at}`);
    for (const [name, w, cap] of windows)
      if (cap !== undefined && sum(inWindow(w)) > $(cap)) out.push(`${name} at ${p.at}`);
    for (const cap of doc.counterparties?.caps ?? []) {
      const key = cap.match.address ?? cap.match.agent_id ?? cap.match.x402_domain;
      if (key !== p.payee) continue;
      if (cap.per_tx !== undefined && p.amount > $(cap.per_tx)) out.push(`cap per_tx at ${p.at}`);
      if (cap.per_day !== undefined && sum(inWindow(DAY, p.payee)) > $(cap.per_day))
        out.push(`cap per_day at ${p.at}`);
      if (cap.per_month !== undefined && sum(inWindow(30 * DAY, p.payee)) > $(cap.per_month))
        out.push(`cap per_month at ${p.at}`);
    }
    const v = doc.velocity ?? {};
    if (v.max_per_minute !== undefined && inWindow(MIN).length > v.max_per_minute)
      out.push(`velocity minute at ${p.at}`);
    if (v.max_per_hour !== undefined && inWindow(HOUR).length > v.max_per_hour)
      out.push(`velocity hour at ${p.at}`);
    if (v.max_per_day !== undefined && inWindow(DAY).length > v.max_per_day)
      out.push(`velocity day at ${p.at}`);
    if ((policy === "payouts" || policy === "open") && !insideWindows(policy, p.at))
      out.push(`outside windows at ${p.at}`);
  }
  return out;
}

const simulationStats: Array<{ name: string; attempts: number; executed: number; breaches: number }> = [];

// ------------------------------------------------------------------ assertions

const results = attempts.map((a) => ({ attempt: a, decision: evaluate(POLICIES[a.policy], a.ctx) }));

describe("red team: adversarial intents", () => {
  it("throws at least 1,000 adversarial intents across every category", () => {
    const adversarial = attempts.filter((a) => a.mustDeny);
    expect(adversarial.length).toBeGreaterThanOrEqual(1000);
    const categories = new Set(adversarial.map((a) => a.category));
    expect(categories.size).toBeGreaterThanOrEqual(12);
  });

  it("never allows an intent that exceeds a limit, pays a non-allowlisted counterparty, or comes from a frozen or expired authority", () => {
    const escaped = results
      .filter(({ attempt, decision }) => attempt.mustDeny && decision.outcome !== "deny")
      .map(
        ({ attempt, decision }) =>
          `[${attempt.category}/${attempt.policy}] ${attempt.why} → ${decision.outcome}`,
      );
    expect(escaped).toEqual([]);
  });

  it("does not deny the benign controls (the engine is not refusing everything)", () => {
    const controls = results.filter(({ attempt }) => !attempt.mustDeny);
    expect(controls.length).toBeGreaterThanOrEqual(150);
    const wronglyDenied = controls
      .filter(({ decision }) => decision.outcome === "deny")
      .map(
        ({ attempt, decision }) =>
          `[${attempt.category}/${attempt.policy}] ${attempt.why}: ${decision.ruleHits
            .filter((h) => h.effect === "deny")
            .map((h) => h.detail)
            .join("; ")}`,
      );
    expect(wronglyDenied).toEqual([]);
  });

  it("never escalates a limit breach to an approval instead of denying it", () => {
    const escalated = results.filter(
      ({ attempt, decision }) =>
        limitBreaches(attempt.policy, attempt.ctx).length > 0 && decision.outcome !== "deny",
    );
    expect(escalated).toEqual([]);
  });
});

describe("red team: stateful split-payment and burst simulations", () => {
  it("cannot split payments under per_tx to exceed the rolling daily and monthly caps", () => {
    // 24.99 every 2 s for 3 hours to an allowlisted host, then hourly for 35 days.
    const stream = [
      ...Array.from({ length: 5400 }, (_, i) => BASE_NOW + i * 2000),
      ...Array.from({ length: 35 * 24 }, (_, i) => BASE_NOW + 3 * HOUR + i * HOUR),
    ].map((at) => ({
      at,
      amount: $("24.99"),
      counterparty: { x402Domain: DATA_HOST, address: SELLER },
      payee: DATA_HOST,
    }));
    const { executed } = simulate("research", stream);
    expect(ledgerBreaches("research", executed)).toEqual([]);
    expect(executed.length).toBeGreaterThan(0);
    simulationStats.push({
      name: "research: 24.99 split payments",
      attempts: stream.length,
      executed: executed.length,
      breaches: 0,
    });
  });

  it("cannot burst past velocity limits", () => {
    const stream = Array.from({ length: 3000 }, (_, i) => ({
      at: Date.parse("2026-10-12T09:00:00Z") + i * 100,
      amount: $("1.00"),
      counterparty: { address: ALICE },
      payee: ALICE,
    }));
    const { executed } = simulate("open", stream);
    expect(ledgerBreaches("open", executed)).toEqual([]);
    expect(executed.length).toBeGreaterThan(0);
    simulationStats.push({
      name: "open: 1.00 burst every 100 ms",
      attempts: stream.length,
      executed: executed.length,
      breaches: 0,
    });
  });

  it("keeps a month of randomized payouts within every cap, window and business hour", () => {
    const payees: Array<[string, IntentCounterparty]> = [
      [VENDOR_A, { address: VENDOR_A }],
      [VENDOR_B, { address: VENDOR_B }],
      [PARTNER, { agentId: PARTNER, address: PARTNER_ACCOUNT }],
    ];
    const start = Date.parse("2026-02-23T00:00:00Z"); // spans the March DST change
    const stream = Array.from({ length: 4000 }, (_, i) => {
      const [payee, counterparty] = rng.pick(payees);
      return {
        at: start + i * 11 * MIN + rng.int(MIN),
        amount: 1n + rng.big($("1200.00")),
        counterparty,
        payee,
      };
    });
    const { executed, decisions } = simulate("payouts", stream);
    expect(ledgerBreaches("payouts", executed)).toEqual([]);
    expect(decisions.some((d) => d.outcome === "require_approval")).toBe(true);
    expect(executed.length).toBeGreaterThan(50);
    simulationStats.push({
      name: "payouts: random month across DST",
      attempts: stream.length,
      executed: executed.length,
      breaches: 0,
    });
  });

  it("cannot drain the escrow budget with many small locks", () => {
    const stream = Array.from({ length: 2000 }, (_, i) => ({
      at: BASE_NOW + i * 37 * MIN,
      amount: $("299.99"),
      counterparty: { agentId: PARTNER, address: PARTNER_ACCOUNT },
      payee: PARTNER,
    }));
    const { executed } = simulate("escrow", stream);
    expect(ledgerBreaches("escrow", executed)).toEqual([]);
    simulationStats.push({
      name: "escrow: 299.99 locks for 51 days",
      attempts: stream.length,
      executed: executed.length,
      breaches: 0,
    });
  });
});

afterAll(() => {
  const byCategory = new Map<
    string,
    { attacks: number; denied: number; controls: number; controlsPassed: number }
  >();
  for (const { attempt, decision } of results) {
    const row = byCategory.get(attempt.category) ?? { attacks: 0, denied: 0, controls: 0, controlsPassed: 0 };
    if (attempt.mustDeny) {
      row.attacks++;
      if (decision.outcome === "deny") row.denied++;
    } else {
      row.controls++;
      if (decision.outcome !== "deny") row.controlsPassed++;
    }
    byCategory.set(attempt.category, row);
  }
  const table = [...byCategory.entries()].map(([category, r]) => ({ category, ...r }));
  console.log("\nRed-team summary (static intents)");
  console.table(table);
  console.log(
    `total adversarial intents: ${table.reduce((n, r) => n + r.attacks, 0)}, denied: ${table.reduce((n, r) => n + r.denied, 0)}; controls: ${table.reduce((n, r) => n + r.controls, 0)}, not denied: ${table.reduce((n, r) => n + r.controlsPassed, 0)}`,
  );
  console.log("Stateful simulations");
  console.table(simulationStats);
});
