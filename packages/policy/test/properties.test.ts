import {
  PAYMENT_KINDS,
  WEEKDAYS,
  formatAmount,
  type PaymentKind,
  type PolicyDocumentInput,
} from "@agentbank/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyChange,
  compilePolicy,
  evaluate,
  OUTCOME_SEVERITY,
  type Decision,
  type EvaluationContext,
  type IntentCounterparty,
} from "../src";
import { $, agentId } from "./helpers";

/**
 * Property tests. Policies and contexts are drawn from small universes of
 * identifiers and amounts so that matches, boundaries and collisions are
 * frequent rather than vanishingly rare.
 */

const ADDRESSES = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
  "0x4444444444444444444444444444444444444444",
];
const SPEND_KEY = "0x5dc0000000000000000000000000000000000001";
const AGENT_IDS = [agentId(101), agentId(102), agentId(103)];
const ERC8004_IDS = ["eip155:84532:0x8004:1", "eip155:84532:0x8004:2"];
const DOMAINS = ["a.example", "b.example", "c.example"];
const ZONES = ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe"];
const AMOUNTS = ["0", "0.000001", "1", "5", "9.99", "10", "25", "50", "100", "200", "1000"];
const NUM_RUNS = 300;
/** Property suites do thousands of evaluations; give slow (instrumented) CI runs room. */
const TIMEOUT_MS = process.env.CI ? 300_000 : 30_000;

const opt = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(arb, { nil: undefined, freq: 2 });
const amountStr = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...AMOUNTS) },
  { weight: 1, arbitrary: fc.bigInt({ min: 0n, max: 2_000_000_000n }).map((v) => formatAmount(v, 6)) },
);
const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const timeWindow = fc
  .record({
    days: fc.subarray([...WEEKDAYS], { minLength: 1 }),
    start: fc.integer({ min: 0, max: 47 }).map((h) => h * 30),
    end: fc.integer({ min: 1, max: 48 }).map((h) => h * 30),
    timezone: fc.constantFrom(...ZONES),
  })
  .filter((w) => w.start !== w.end)
  .map((w) => ({ ...w, start: clock(w.start), end: clock(w.end) }));

const lists = fc.record(
  {
    addresses: fc.subarray(ADDRESSES),
    agent_ids: fc.subarray(AGENT_IDS),
    erc8004_ids: fc.subarray(ERC8004_IDS),
    x402_domains: fc.subarray(DOMAINS),
  },
  { requiredKeys: [] },
);

const capMatch = fc.oneof(
  fc.constantFrom(...ADDRESSES).map((address) => ({ address })),
  fc.constantFrom(...AGENT_IDS).map((agent_id) => ({ agent_id })),
  fc.constantFrom(...ERC8004_IDS).map((erc8004_id) => ({ erc8004_id })),
  fc.constantFrom(...DOMAINS).map((x402_domain) => ({ x402_domain })),
);
const cap = fc.record({
  match: capMatch,
  per_tx: opt(amountStr),
  per_day: opt(amountStr),
  per_month: opt(amountStr),
});

/**
 * Present `percent`% of the time, otherwise absent (`undefined`). Most rules
 * are off in any one generated policy, so decisions vary (a policy with every
 * rule on denies nearly everything, which would make the properties weak).
 */
const sometimes = <T>(arb: fc.Arbitrary<T>, percent = 35): fc.Arbitrary<T | undefined> =>
  fc.oneof({ weight: 100 - percent, arbitrary: fc.constant(undefined) }, { weight: percent, arbitrary: arb });

const policyDoc: fc.Arbitrary<PolicyDocumentInput> = fc.record({
  agent: sometimes(fc.constantFrom(...AGENT_IDS), 20),
  limits: fc.record({
    per_tx: sometimes(amountStr),
    per_day: sometimes(amountStr),
    per_week: sometimes(amountStr),
    per_month: sometimes(amountStr),
  }),
  counterparties: fc
    .record({
      mode: fc.oneof(
        { weight: 2, arbitrary: fc.constant("open" as const) },
        { weight: 1, arbitrary: fc.constant("allowlist" as const) },
        { weight: 1, arbitrary: fc.constant("denylist" as const) },
      ),
      lists,
      deny: sometimes(lists),
      new_cooldown_minutes: sometimes(fc.integer({ min: 0, max: 120 })),
      caps: sometimes(fc.array(cap, { maxLength: 3 })),
    })
    // Top-level lists are only valid outside "open" mode (the schema rejects them there).
    .map(({ lists: l, ...rest }) => (rest.mode === "open" ? rest : { ...rest, ...l })),
  velocity: sometimes(
    fc.record({
      max_per_minute: sometimes(fc.integer({ min: 1, max: 6 })),
      max_per_hour: sometimes(fc.integer({ min: 1, max: 20 })),
      max_per_day: sometimes(fc.integer({ min: 1, max: 50 })),
    }),
  ),
  time_windows: sometimes(fc.array(timeWindow, { minLength: 1, maxLength: 3 }), 25),
  max_balance: sometimes(amountStr),
  approvals: sometimes(
    fc.array(fc.record({ above: amountStr, approvers: fc.integer({ min: 1, max: 5 }) }), { maxLength: 3 }),
  ),
  require_owner_above: sometimes(amountStr),
  allowed_kinds: sometimes(fc.subarray([...PAYMENT_KINDS], { minLength: 1 }), 25),
});

const counterparty: fc.Arbitrary<IntentCounterparty> = fc.record(
  {
    address: fc.constantFrom(...ADDRESSES, SPEND_KEY, ADDRESSES[0]?.toUpperCase().replace("0X", "0x") ?? ""),
    agentId: fc.constantFrom(...AGENT_IDS),
    erc8004Id: fc.constantFrom(...ERC8004_IDS, "EIP155:84532:0X8004:1"),
    x402Domain: fc.constantFrom(...DOMAINS, "A.Example.", "d.example"),
  },
  { requiredKeys: [] },
);

const intentAmount = fc
  .oneof(
    {
      weight: 3,
      arbitrary: fc.constantFrom(...AMOUNTS).chain((a) => fc.constantFrom($(a) - 1n, $(a), $(a) + 1n)),
    },
    { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: 2_000_000_000n }) },
  )
  .filter((v) => v > 0n);
const spent = fc.oneof(
  fc.constant(0n),
  fc.bigInt({ min: 0n, max: 3_000_000_000n }),
  fc.constantFrom(...AMOUNTS).map((a) => $(a)),
);
const NOW_MIN = Date.parse("2025-01-01T00:00:00Z");
const NOW_MAX = Date.parse("2030-12-31T00:00:00Z");

const contextArb: fc.Arbitrary<EvaluationContext> = fc
  .record({
    now: fc.integer({ min: NOW_MIN, max: NOW_MAX }),
    agentId: fc.constantFrom(...AGENT_IDS),
    kind: fc.constantFrom<PaymentKind>(...PAYMENT_KINDS),
    amount: intentAmount,
    counterparty,
    spentLastDay: spent,
    spentLastWeek: spent,
    spentLastMonth: spent,
    countLastMinute: fc.integer({ min: 0, max: 8 }),
    countLastHour: fc.integer({ min: 0, max: 25 }),
    countLastDay: fc.integer({ min: 0, max: 60 }),
    cpDay: spent,
    cpMonth: spent,
    firstSeenMinutesAgo: fc.option(fc.integer({ min: 0, max: 300 }), { nil: null }),
  })
  .map((r) => ({
    now: new Date(r.now),
    agent: { id: r.agentId, status: "active", spendKeyAddress: SPEND_KEY },
    org: { status: "active" },
    intent: { kind: r.kind, amount: r.amount, asset: "USDC", counterparty: r.counterparty },
    history: {
      spentLastDay: r.spentLastDay,
      spentLastWeek: r.spentLastWeek,
      spentLastMonth: r.spentLastMonth,
      countLastMinute: r.countLastMinute,
      countLastHour: r.countLastHour,
      countLastDay: r.countLastDay,
      counterpartySpentLastDay: r.cpDay,
      counterpartySpentLastMonth: r.cpMonth,
      counterpartyFirstSeenAt:
        r.firstSeenMinutesAgo === null ? null : new Date(r.now - r.firstSeenMinutesAgo * 60_000),
    },
  }));

/** A single-field mutation: copy one top-level field from another random document. */
const mutation = fc.record({
  key: fc.constantFrom<keyof PolicyDocumentInput>(
    "agent",
    "limits",
    "counterparties",
    "velocity",
    "time_windows",
    "max_balance",
    "approvals",
    "require_owner_above",
    "allowed_kinds",
  ),
  from: policyDoc,
  // Fine-grained edits that often produce pure tightenings or loosenings.
  edit: fc.option(
    fc.record({
      list: fc.constantFrom("allow", "deny"),
      field: fc.constantFrom("addresses", "agent_ids", "erc8004_ids", "x402_domains"),
      index: fc.nat(),
      add: fc.boolean(),
    }),
    { nil: undefined },
  ),
});

const UNIVERSE: Record<string, readonly string[]> = {
  addresses: ADDRESSES,
  agent_ids: AGENT_IDS,
  erc8004_ids: ERC8004_IDS,
  x402_domains: DOMAINS,
};

type Lists = Partial<Record<"addresses" | "agent_ids" | "erc8004_ids" | "x402_domains", string[]>>;

type MutationValue = typeof mutation extends fc.Arbitrary<infer T> ? T : never;

function mutate(doc: PolicyDocumentInput, m: MutationValue): PolicyDocumentInput {
  const next = structuredClone(doc) as Record<string, unknown>;
  if (m.edit === undefined) {
    next[m.key] = structuredClone((m.from as Record<string, unknown>)[m.key]);
    return next as PolicyDocumentInput;
  }
  const { list, field, index, add } = m.edit;
  const cp: Record<string, unknown> = {
    mode: "open",
    ...((next.counterparties as Record<string, unknown> | undefined) ?? {}),
  };
  // In "open" mode top-level lists are invalid, so an allowlist edit lands on the denylist.
  const topLevel = list === "allow" && cp.mode !== "open";
  const target = (topLevel ? cp : ((cp.deny as Lists | undefined) ?? {})) as Lists;
  if (!topLevel) cp.deny = target;
  const universe = UNIVERSE[field] ?? [];
  const value = universe[index % universe.length] ?? "";
  const key = field as keyof Lists;
  const current = target[key] ?? [];
  target[key] = add ? [...new Set([...current, value])] : current.filter((v) => v !== value);
  next.counterparties = cp;
  return next as PolicyDocumentInput;
}

function strictness(d: Decision): [number, number] {
  return [OUTCOME_SEVERITY[d.outcome], d.approversRequired];
}

function atLeastAsStrict(b: Decision, a: Decision): boolean {
  const [rb, nb] = strictness(b);
  const [ra, na] = strictness(a);
  return rb > ra || (rb === ra && nb >= na);
}

describe("property: determinism", () => {
  it(
    "evaluates identical inputs identically, independent of object identity",
    () => {
      fc.assert(
        fc.property(policyDoc, contextArb, (doc, ctx) => {
          const first = evaluate(compilePolicy(doc, 1), ctx);
          const second = evaluate(compilePolicy(structuredClone(doc), 1), structuredClone(ctx));
          expect(second).toEqual(first);
          expect(evaluate(compilePolicy(doc, 1), ctx)).toEqual(first);
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

describe("property: classifyChange is sound", () => {
  it(
    "never lets a tightening allow (or escalate less) anything the old policy did not",
    () => {
      let tightenings = 0;
      let unchanged = 0;
      let loosenings = 0;
      fc.assert(
        fc.property(
          policyDoc,
          fc.array(mutation, { minLength: 1, maxLength: 2 }),
          fc.array(contextArb, { minLength: 8, maxLength: 8 }),
          (a, mutations, contexts) => {
            const b = mutations.reduce((doc, m) => mutate(doc, m), a);
            const forward = classifyChange(a, b);
            const backward = classifyChange(b, a);
            const inverse: Record<string, string> = {
              tighten: "loosen",
              loosen: "tighten",
              mixed: "mixed",
              unchanged: "unchanged",
            };
            expect(backward.kind).toBe(inverse[forward.kind]);
            if (forward.kind === "tighten") tightenings++;
            if (forward.kind === "unchanged") unchanged++;
            if (forward.kind === "loosen") loosenings++;
            const pa = compilePolicy(a, 1);
            const pb = compilePolicy(b, 1);
            for (const ctx of contexts) {
              const da = evaluate(pa, ctx);
              const db = evaluate(pb, ctx);
              if (forward.kind === "tighten" || forward.kind === "unchanged") {
                expect(atLeastAsStrict(db, da), `${forward.kind}: ${da.outcome} → ${db.outcome}`).toBe(true);
                if (da.outcome === "deny") expect(db.outcome).toBe("deny");
              }
              if (forward.kind === "loosen" || forward.kind === "unchanged") {
                expect(atLeastAsStrict(da, db), `${forward.kind}: ${da.outcome} → ${db.outcome}`).toBe(true);
              }
              if (forward.kind === "unchanged") {
                expect([db.outcome, db.approversRequired]).toEqual([da.outcome, da.approversRequired]);
              }
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
      // The generator must actually exercise the interesting classes.
      expect(tightenings).toBeGreaterThan(NUM_RUNS / 20);
      expect(loosenings).toBeGreaterThan(NUM_RUNS / 20);
      expect(unchanged).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

describe("property: hard limits", () => {
  it(
    "always denies an amount above per_tx",
    () => {
      fc.assert(
        fc.property(
          policyDoc,
          contextArb,
          amountStr,
          fc.bigInt({ min: 1n, max: 10n ** 9n }),
          (doc, ctx, perTx, over) => {
            const withCap = { ...doc, limits: { ...doc.limits, per_tx: perTx } };
            const amount = $(perTx) + over;
            const d = evaluate(compilePolicy(withCap, 1), { ...ctx, intent: { ...ctx.intent, amount } });
            expect(d.outcome).toBe("deny");
            expect(d.ruleHits.some((h) => h.rule === "limits.per_tx" && h.effect === "deny")).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "always denies when the rolling day would exceed per_day",
    () => {
      fc.assert(
        fc.property(policyDoc, contextArb, amountStr, (doc, ctx, perDay) => {
          const withCap = { ...doc, limits: { ...doc.limits, per_day: perDay } };
          const day = $(perDay);
          const amount = ctx.intent.amount;
          const spentLastDay = day - amount + 1n > 0n ? day - amount + 1n : 0n;
          const d = evaluate(compilePolicy(withCap, 1), {
            ...ctx,
            history: { ...ctx.history, spentLastDay },
          });
          expect(spentLastDay + amount > day).toBe(true);
          expect(d.outcome).toBe("deny");
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "never lets an allowlist admit an unlisted counterparty",
    () => {
      const variants = fc.oneof(
        fc.constantFrom(...ADDRESSES).map((address) => ({ address })),
        fc.constantFrom(...AGENT_IDS).map((agentId) => ({ agentId })),
        fc.constantFrom(...ERC8004_IDS).map((erc8004Id) => ({ erc8004Id })),
        fc.constantFrom(...DOMAINS).map((x402Domain) => ({ x402Domain })),
        fc.constantFrom(...DOMAINS).map((d) => ({ x402Domain: `${d.toUpperCase()}.` })),
        fc.constantFrom(...DOMAINS).map((d) => ({ x402Domain: `x${d}` })),
        fc.constantFrom(...DOMAINS).map((d) => ({ x402Domain: d.replace("a", "\u0430") })),
        fc.constantFrom(...ADDRESSES).map((a) => ({ address: `${a.slice(0, 41)}9` })),
      );
      let admittedAndAllowed = 0;
      fc.assert(
        fc.property(
          policyDoc,
          lists,
          contextArb,
          fc.array(variants, { minLength: 1, maxLength: 3 }),
          (doc, allow, ctx, parts) => {
            // Exactly `allow` as the allowlist (plus the document's denylist), and no
            // other restriction, so admitted payees are actually paid.
            const deny = doc.counterparties?.deny;
            const policy = compilePolicy(
              { counterparties: { mode: "allowlist", ...allow, ...(deny === undefined ? {} : { deny }) } },
              1,
            );
            const cp: IntentCounterparty = Object.assign({}, ...parts);
            const kind = ctx.intent.kind;
            // Ground truth, computed independently of the engine's matching code.
            const listed = (
              values: readonly string[] | undefined,
              v: string | undefined | null,
              canon: (s: string) => string,
            ) => v !== undefined && v !== null && (values ?? []).some((x) => canon(x) === canon(v));
            const lower = (s: string) => s.toLowerCase();
            const host = (s: string) =>
              /^[A-Za-z0-9.-]+$/.test(s) ? s.toLowerCase().replace(/\.$/, "") : `\u0000${s}`;
            const admitted =
              kind === "refill"
                ? false
                : kind === "x402"
                  ? listed(allow.x402_domains, cp.x402Domain, host)
                  : listed(allow.addresses, cp.address, lower) ||
                    listed(allow.agent_ids, cp.agentId, (s) => s) ||
                    listed(allow.erc8004_ids, cp.erc8004Id, lower);
            const d = evaluate(policy, { ...ctx, intent: { ...ctx.intent, counterparty: cp } });
            if (!admitted && kind !== "refill") expect(d.outcome).toBe("deny");
            if (kind === "refill" && cp.address?.toLowerCase() !== SPEND_KEY) expect(d.outcome).toBe("deny");
            if (admitted && d.outcome === "allow") admittedAndAllowed++;
          },
        ),
        { numRuns: NUM_RUNS * 2 },
      );
      // Not vacuous: listed payees do get paid.
      expect(admittedAndAllowed).toBeGreaterThan(NUM_RUNS / 10);
    },
    TIMEOUT_MS,
  );
});
