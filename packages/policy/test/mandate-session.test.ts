import { AgentBankError, SessionScopeSchema, type OpenPaymentMandate } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import {
  compileMandate,
  compileSessionScope,
  mandateToSessionScope,
  sessionScopeFromPolicy,
  UNBOUNDED_SESSION_AMOUNT,
} from "../src";
import { $, ADDR, AGENT_ID, compile, DESIGN_EXAMPLE, DOMAIN, mandate, NOW, OTHER_AGENT_ID } from "./helpers";

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentBankError);
    expect((error as AgentBankError).code).toBe(code);
    return;
  }
  throw new Error(`expected an AgentBankError with code ${code}`);
}

describe("compileMandate", () => {
  it("converts amounts to USDC minor units and intersects repeated constraints", () => {
    const m = compileMandate(
      mandate({
        constraints: [
          { type: "payment.amount_range", currency: "USD", max: 5_000, min: 100 },
          { type: "payment.amount_range", currency: "USDC", max: "30000000", min: 2_000_000 },
          { type: "payment.budget", currency: "USD", max: 20_000 },
          { type: "payment.budget", currency: "USDC", max: 150_000_000 },
          { type: "payment.agent_recurrence", frequency: "WEEKLY", max_occurrences: 10 },
          { type: "payment.agent_recurrence", frequency: "DAILY", max_occurrences: 4 },
          { type: "payment.agent_recurrence", frequency: "MONTHLY" },
          {
            type: "payment.execution_date",
            not_before: "2026-10-01T00:00:00Z",
            not_after: "2026-12-01T00:00:00Z",
          },
          {
            type: "payment.execution_date",
            not_before: "2026-10-05T00:00:00+02:00",
            not_after: "2026-11-15T00:00:00Z",
          },
          {
            type: "payment.execution_date",
            not_before: "2026-09-01T00:00:00Z",
            not_after: "2026-12-31T00:00:00Z",
          },
        ],
      }),
    );
    expect(m.amountRange).toEqual({ min: $("2.00"), max: $("30.00") });
    expect(m.budget).toBe($("150.00"));
    expect(m.recurrence).toEqual({ frequency: "MONTHLY", maxOccurrences: 4 });
    expect(m.executionWindow).toEqual({
      notBefore: new Date("2026-10-04T22:00:00Z"),
      notAfter: new Date("2026-11-15T00:00:00Z"),
    });
    expect(m.agentId).toBe(AGENT_ID);
    expect(m.issuedAt).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(m.expiresAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("classifies payees and normalizes hosts", () => {
    const m = compileMandate(
      mandate({
        constraints: [
          {
            type: "payment.allowed_payees",
            allowed: [
              { id: "0x52908400098527886E0F7030069857D2E4169EE7", name: "A" },
              { id: OTHER_AGENT_ID, name: "B" },
              { id: "API.Example-Data.com", name: "C" },
              { id: "42", name: "D" },
            ],
          },
          { type: "agentbank.x402_domains", allowed: [DOMAIN] },
        ],
      }),
    );
    const set = m.payeeSets[0];
    expect([...(set?.addresses ?? [])]).toEqual(["0x52908400098527886e0f7030069857d2e4169ee7"]);
    expect([...(set?.agentIds ?? [])]).toEqual([OTHER_AGENT_ID]);
    expect([...(set?.x402Domains ?? [])]).toEqual([DOMAIN]);
    expect([...(set?.erc8004Ids ?? [])]).toEqual(["42"]);
    expect([...(m.x402DomainSets[0] ?? [])]).toEqual([DOMAIN]);
    expect(m.amountRange).toBeNull();
    expect(m.budget).toBeNull();
    expect(m.recurrence).toBeNull();
    expect(m.executionWindow).toBeNull();
  });

  it.each<[string, Partial<OpenPaymentMandate>]>([
    ["exp before iat", { iat: 2_000, exp: 1_000 }],
    ["wrong vct", { vct: "mandate.payment.closed.1" as never }],
    ["no constraints", { constraints: [] }],
    [
      "bad payee id",
      { constraints: [{ type: "payment.allowed_payees", allowed: [{ id: "has space", name: "x" }] }] },
    ],
    [
      "bad x402 host",
      {
        constraints: [
          { type: "agentbank.x402_domains", allowed: ["ok.example"] },
          { type: "agentbank.x402_domains", allowed: ["xn--"] },
        ],
      },
    ],
    // Passes core's DomainSchema, but a numeric last label is an IPv4 spelling the engine refuses.
    ["numeric x402 host", { constraints: [{ type: "agentbank.x402_domains", allowed: ["10.0.0.256"] }] }],
    [
      "empty amount range",
      { constraints: [{ type: "payment.amount_range", currency: "USDC", max: 5, min: 10 }] },
    ],
    [
      "empty execution window",
      {
        constraints: [
          { type: "payment.execution_date", not_before: "2026-12-01T00:00:00Z" },
          { type: "payment.execution_date", not_after: "2026-11-01T00:00:00Z" },
        ],
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expectCode(() => compileMandate(mandate(overrides)), "mandate_invalid");
  });
});

describe("mandateToSessionScope", () => {
  const policy = compile({
    limits: { per_tx: "25.00", per_day: "200.00", per_week: "150.00" },
    counterparties: {
      mode: "allowlist",
      addresses: [ADDR.alice, ADDR.bob, ADDR.carol],
      deny: { addresses: [ADDR.carol] },
    },
  });

  it("intersects mandate constraints with the policy caps", () => {
    const m = mandate({
      constraints: [
        { type: "payment.amount_range", currency: "USD", max: 1_000 },
        { type: "payment.budget", currency: "USDC", max: 120_000_000 },
        {
          type: "payment.allowed_payees",
          allowed: [
            { id: ADDR.bob, name: "Bob" },
            { id: ADDR.carol, name: "Carol" },
            { id: ADDR.mallory, name: "M" },
          ],
        },
      ],
    });
    const scope = mandateToSessionScope(m, policy, NOW);
    expect(SessionScopeSchema.parse(scope)).toEqual(scope);
    expect(scope).toEqual({
      asset: "USDC",
      max_per_tx: "10.00",
      max_per_day: "120.00",
      expires_at: "2026-10-13T15:00:00.000Z",
      allowed_recipients: [ADDR.bob],
    });
  });

  it("caps at the remaining budget and the earliest end", () => {
    const m = mandate({
      exp: unix("2026-10-12T18:00:00Z"),
      constraints: [
        { type: "payment.budget", currency: "USDC", max: 50_000_000 },
        { type: "payment.execution_date", not_after: "2026-10-12T17:00:00Z" },
      ],
    });
    const scope = mandateToSessionScope(compileMandate(m), policy, NOW, { mandateSpent: $("45.00") });
    expect(scope.max_per_tx).toBe("5.00");
    expect(scope.max_per_day).toBe("5.00");
    expect(scope.expires_at).toBe("2026-10-12T17:00:00.000Z");
    const spentOut = mandateToSessionScope(m, policy, NOW, { mandateSpent: $("60.00") });
    expect(spentOut.max_per_tx).toBe("0.00");
    const short = mandateToSessionScope(mandate({ exp: unix("2026-10-20T00:00:00Z") }), policy, NOW, 600);
    expect(short.expires_at).toBe("2026-10-12T15:10:00.000Z");
  });

  it("never writes an amount above the ledger maximum", () => {
    const huge = mandate({
      constraints: [{ type: "payment.amount_range", currency: "USD", max: "9999999999999999999" }],
    });
    const scope = mandateToSessionScope(huge, compile({}), NOW);
    expect(scope.max_per_tx).toBe("9223372036854.775807");
    expect(SessionScopeSchema.parse(scope)).toEqual(scope);
  });

  it("does not narrow recipients with payee lists it cannot resolve", () => {
    const m = mandate({
      constraints: [
        {
          type: "payment.allowed_payees",
          allowed: [
            { id: ADDR.alice, name: "A" },
            { id: OTHER_AGENT_ID, name: "B" },
          ],
        },
      ],
    });
    expect(mandateToSessionScope(m, policy, NOW).allowed_recipients).toEqual([ADDR.alice, ADDR.bob]);
    const openPolicy = compile({});
    expect(mandateToSessionScope(m, openPolicy, NOW).allowed_recipients).toBeUndefined();
    const addressOnly = mandate({
      constraints: [{ type: "payment.allowed_payees", allowed: [{ id: ADDR.mallory, name: "M" }] }],
    });
    expect(mandateToSessionScope(addressOnly, openPolicy, NOW).allowed_recipients).toEqual([ADDR.mallory]);
  });

  it("refuses expired mandates and mandates for another agent", () => {
    expectCode(
      () => mandateToSessionScope(mandate({ exp: unix("2026-10-12T15:00:00Z") }), policy, NOW),
      "mandate_expired",
    );
    const ended = mandate({
      constraints: [{ type: "payment.execution_date", not_after: "2026-10-12T14:00:00Z" }],
    });
    expectCode(() => mandateToSessionScope(ended, policy, NOW), "mandate_expired");
    expectCode(
      () => mandateToSessionScope(mandate({ agent_id: OTHER_AGENT_ID }), compile({ agent: AGENT_ID }), NOW),
      "mandate_invalid",
    );
  });
});

describe("sessionScopeFromPolicy", () => {
  it("derives the default scope from the design example", () => {
    const scope = sessionScopeFromPolicy(compile(DESIGN_EXAMPLE), NOW);
    expect(scope).toEqual({
      asset: "USDC",
      max_per_tx: "25.00",
      max_per_day: "200.00",
      expires_at: "2026-10-13T15:00:00.000Z",
    });
    expect(SessionScopeSchema.parse(scope)).toEqual(scope);
  });

  it("takes the tightest cap and the owner threshold", () => {
    const scope = sessionScopeFromPolicy(
      compile({ limits: { per_tx: "500", per_week: "300", per_month: "1000" }, require_owner_above: "250" }),
      NOW,
      3600,
    );
    expect(scope.max_per_tx).toBe("250.00");
    expect(scope.max_per_day).toBe("300.00");
    expect(scope.expires_at).toBe("2026-10-12T16:00:00.000Z");
    const capped = sessionScopeFromPolicy(compile({ limits: { per_tx: "50", per_day: "20" } }), NOW);
    expect(capped.max_per_tx).toBe("20.00");
  });

  it("uses the unbounded amount when the policy sets no caps", () => {
    const scope = sessionScopeFromPolicy(compile({}), NOW);
    expect(scope.max_per_tx).toBe("9223372036854.775807");
    expect(scope.max_per_day).toBe("9223372036854.775807");
    expect(UNBOUNDED_SESSION_AMOUNT).toBe(2n ** 63n - 1n);
    expect(SessionScopeSchema.parse(scope)).toEqual(scope);
  });

  it("lists recipients only for allowlists with addresses, minus denied ones", () => {
    const domainsOnly = compile({ counterparties: { mode: "allowlist", x402_domains: [DOMAIN] } });
    expect(sessionScopeFromPolicy(domainsOnly, NOW).allowed_recipients).toBeUndefined();
    expect(
      sessionScopeFromPolicy(domainsOnly, NOW, { recipients: [ADDR.spendKey] }).allowed_recipients,
    ).toEqual([ADDR.spendKey]);
    const withAddresses = compile({
      counterparties: {
        mode: "allowlist",
        addresses: [ADDR.bob, ADDR.alice, ADDR.mallory],
        deny: { addresses: [ADDR.mallory] },
      },
    });
    expect(
      sessionScopeFromPolicy(withAddresses, NOW, {
        recipients: [ADDR.spendKey.toUpperCase().replace("0X", "0x")],
      }).allowed_recipients,
    ).toEqual([ADDR.alice, ADDR.bob, ADDR.spendKey]);
    expect(
      sessionScopeFromPolicy(compile({}), NOW, { recipients: [ADDR.alice] }).allowed_recipients,
    ).toBeUndefined();
  });

  it("leaves the on-chain recipient list open beyond 100 addresses", () => {
    const addresses = Array.from({ length: 101 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const big = compile({ counterparties: { mode: "allowlist", addresses } });
    expect(sessionScopeFromPolicy(big, NOW).allowed_recipients).toBeUndefined();
    const exactly = compile({ counterparties: { mode: "allowlist", addresses: addresses.slice(0, 100) } });
    expect(sessionScopeFromPolicy(exactly, NOW).allowed_recipients).toHaveLength(100);
  });

  it("passes allowed contracts through", () => {
    const scope = sessionScopeFromPolicy(compile({}), NOW, {
      contracts: [ADDR.stream, ADDR.escrow, ADDR.escrow],
    });
    expect(scope.allowed_contracts).toEqual([ADDR.stream, ADDR.escrow]);
    const many = Array.from({ length: 21 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    expectCode(() => sessionScopeFromPolicy(compile({}), NOW, { contracts: many }), "invalid_request");
    expectCode(() => sessionScopeFromPolicy(compile({}), NOW, { contracts: ["0x12"] }), "invalid_request");
    expectCode(() => sessionScopeFromPolicy(compile({}), NOW, { recipients: ["nope"] }), "invalid_request");
  });

  it.each([0, -5, 1.5, 7 * 24 * 3600 + 1])("rejects a lifetime of %s seconds", (ttl) => {
    expectCode(() => sessionScopeFromPolicy(compile({}), NOW, ttl), "invalid_request");
  });

  it("accepts the maximum lifetime and rejects an invalid clock", () => {
    expect(sessionScopeFromPolicy(compile({}), NOW, 7 * 24 * 3600).expires_at).toBe(
      "2026-10-19T15:00:00.000Z",
    );
    expectCode(() => sessionScopeFromPolicy(compile({}), new Date(Number.NaN)), "invalid_request");
  });
});

describe("compileSessionScope", () => {
  it("parses amounts and normalizes addresses", () => {
    const s = compileSessionScope({
      max_per_tx: "1.5",
      max_per_day: "10",
      allowed_recipients: ["0x52908400098527886E0F7030069857D2E4169EE7"],
      expires_at: "2026-10-13T00:00:00+02:00",
    });
    expect(s.asset).toBe("USDC");
    expect(s.maxPerTx).toBe($("1.50"));
    expect(s.maxPerDay).toBe($("10"));
    expect([...(s.allowedRecipients ?? [])]).toEqual(["0x52908400098527886e0f7030069857d2e4169ee7"]);
    expect(s.allowedContracts).toBeNull();
    expect(s.expiresAt).toEqual(new Date("2026-10-12T22:00:00Z"));
  });

  it("rejects invalid scopes", () => {
    expectCode(
      () => compileSessionScope({ max_per_tx: "1,5", max_per_day: "10", expires_at: "2026-10-13T00:00:00Z" }),
      "invalid_request",
    );
    expectCode(
      () => compileSessionScope({ max_per_tx: "1", max_per_day: "10", expires_at: "tomorrow" }),
      "invalid_request",
    );
    expectCode(
      () =>
        compileSessionScope({
          max_per_tx: "999999999999999999",
          max_per_day: "10",
          expires_at: "2026-10-13T00:00:00Z",
        }),
      "invalid_request",
    );
  });
});
