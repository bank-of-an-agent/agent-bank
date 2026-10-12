import { canonicalKeccak } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import { ProofRequestError } from "../src/errors";
import { onchainScope, onchainScopeId, scopeTag, scopeTagOf } from "../src/field";
import {
  accountOlderThan,
  balanceAtLeast,
  bounds,
  canPayPerDay,
  canPayPerTx,
  checkWitness,
  checkWitnessSatisfies,
  createProofRequest,
  DEFAULT_CHAIN_ID,
  formatBoundValue,
  mergeConstraints,
  parseBoundValue,
  parseProofRequest,
  reputation,
  requestHash,
  reservedFor,
  spendingCappedAt,
  verifiedCompany,
  verifiedPrincipal,
} from "../src/request";
import { disclosureMask, MAX_U64 } from "../src/schema";
import { buildFixture, NOW, SCOPE, standardRequest } from "./fixtures";

const ctx = { scope: SCOPE, now: NOW, expiresAt: NOW + 300 };

describe("requirement builders", () => {
  it("express the design doc's statements", () => {
    expect(verifiedPrincipal()).toEqual({ principal_verification: { min: "1" } });
    expect(verifiedCompany()).toEqual({ principal_verification: { min: "2", max: "2" } });
    expect(canPayPerTx("5.00")).toEqual({ per_tx_limit: { min: "5.00" } });
    expect(canPayPerDay("50")).toEqual({ per_day_limit: { min: "50" } });
    expect(spendingCappedAt({ perTx: "25" })).toEqual({ per_tx_limit: { max: "25" } });
    expect(spendingCappedAt({ perDay: "200" })).toEqual({ per_day_limit: { max: "200" } });
    expect(balanceAtLeast("1000.00")).toEqual({ balance: { min: "1000.00" } });
    expect(
      reputation({
        paymentsSettled: 10,
        volumeSettled: "100",
        escrowsCompleted: 2n,
        disputesLostAtMost: "0",
        counterparties: 3,
      }),
    ).toEqual({
      payments_settled: { min: "10" },
      volume_settled: { min: "100" },
      escrows_completed: { min: "2" },
      disputes_lost: { max: "0" },
      counterparties: { min: "3" },
    });
  });

  it("resolves scope- and time-relative requirements against the request", () => {
    const tag = scopeTagOf(SCOPE).toString();
    const relative = reservedFor("500.00", { forSeconds: 3600 });
    expect(typeof relative === "function" && relative(ctx)).toEqual({
      reserved_amount: { min: "500.00" },
      reserved_until: { min: String(NOW + 3600) },
      reserved_for: { min: tag, max: tag },
    });
    const absolute = reservedFor("1", { until: new Date((NOW + 60) * 1000), scope: "other.example" });
    const otherTag = scopeTagOf("other.example").toString();
    expect(typeof absolute === "function" && absolute(ctx)).toMatchObject({
      reserved_until: { min: String(NOW + 60) },
      reserved_for: { min: otherTag, max: otherTag },
    });
    const older = accountOlderThan(90);
    expect(typeof older === "function" && older(ctx)).toEqual({
      account_created_on: { max: String(NOW - 90 * 86_400) },
    });
    const fixedNow = accountOlderThan(1, { now: 200_000 });
    expect(typeof fixedNow === "function" && fixedNow(ctx)).toEqual({
      account_created_on: { max: "113600" },
    });
  });

  it("rejects malformed arguments", () => {
    expect(() => canPayPerTx("5.0000001")).toThrow(ProofRequestError);
    expect(() => balanceAtLeast("1e3")).toThrow(ProofRequestError);
    expect(() => spendingCappedAt({})).toThrow(/perTx or perDay/);
    expect(() => reputation({})).toThrow(/at least one/);
    expect(() => reputation({ paymentsSettled: -1 })).toThrow(/paymentsSettled/);
    expect(() => reputation({ escrowsCompleted: 1n << 64n })).toThrow(/escrowsCompleted/);
    expect(() => reputation({ counterparties: "01" })).toThrow(/counterparties/);
    expect(() => reputation({ disputesLostAtMost: 1.5 })).toThrow(/disputesLostAtMost/);
    expect(() => reservedFor("1", {})).toThrow(/exactly one/);
    expect(() => reservedFor("1", { until: 1, forSeconds: 1 })).toThrow(/exactly one/);
    expect(() => reservedFor("1", { forSeconds: -5 })).toThrow(/unix seconds/);
    expect(() => reservedFor("1", { until: new Date(Number.NaN) })).toThrow(/unix seconds/);
    expect(() => accountOlderThan(-1)).toThrow(/days/);
    const ancient = accountOlderThan(1_000_000);
    expect(() => typeof ancient === "function" && ancient(ctx)).toThrow(/1970/);
  });
});

describe("bounds", () => {
  it("defaults every attribute to [0, 2^64 - 1] and parses each kind", () => {
    const empty = bounds({ constraints: {} });
    expect(empty.mins).toEqual(new Array(13).fill(0n));
    expect(empty.maxs).toEqual(new Array(13).fill(MAX_U64));
    const { mins, maxs } = bounds({
      constraints: {
        principal_verification: { min: "2", max: "2" },
        per_tx_limit: { min: "5", max: "5.5" },
        reserved_until: { min: "1760003600" },
        volume_settled: { min: "0.000001" },
        disputes_lost: { max: "0" },
        balance: undefined,
      },
    });
    expect(mins.slice(0, 2)).toEqual([2n, 5_000_000n]);
    expect(maxs.slice(0, 2)).toEqual([2n, 5_500_000n]);
    expect(mins[5]).toBe(1_760_003_600n);
    expect(mins[9]).toBe(1n);
    expect(maxs[11]).toBe(0n);
  });

  it("rejects unknown attributes, malformed values, out-of-range values and empty ranges", () => {
    const bad = (constraints: unknown) => () =>
      bounds({ constraints: constraints as Record<string, unknown> });
    expect(bad({ shoe_size: { min: "1" } })).toThrow(/unknown attribute/);
    expect(bad({ balance: "1" })).toThrow(/must be an object/);
    expect(bad({ balance: null })).toThrow(/must be an object/);
    expect(bad({ balance: ["1"] })).toThrow(/must be an object/);
    expect(bad({ balance: { at_least: "1" } })).toThrow(/unknown keys/);
    expect(bad({ balance: { min: "10", max: "9.99" } })).toThrow(/min is greater/);
    expect(bad({ payments_settled: { min: "1.5" } })).toThrow(/base-10 integer/);
    expect(bad({ payments_settled: { min: "18446744073709551616" } })).toThrow(/2\^64/);
    expect(bad({ balance: { min: "18446744073709.551616" } })).toThrow(/2\^64/);
    expect(bad({ balance: { min: 5 } })).toThrow(/strings/);
    expect(bad([])).toThrow(/constraints must be an object/);
    expect(bad(null)).toThrow(/constraints must be an object/);
    try {
      bounds({ constraints: { per_day_limit: { min: "1.1234567" } } });
    } catch (error) {
      expect(error).toBeInstanceOf(ProofRequestError);
      expect((error as ProofRequestError).attribute).toBe("per_day_limit");
    }
  });

  it("formats values the way requests carry them", () => {
    expect(formatBoundValue("balance", 1_000_000_000n)).toBe("1000.00");
    expect(formatBoundValue("balance", 1n)).toBe("0.000001");
    expect(formatBoundValue("payments_settled", 42n)).toBe("42");
    expect(parseBoundValue("principal_verification", "2")).toBe(2n);
  });

  it("intersects requirements", () => {
    expect(mergeConstraints([verifiedPrincipal(), verifiedCompany()])).toEqual({
      principal_verification: { min: "2", max: "2" },
    });
    expect(mergeConstraints([canPayPerTx("1"), canPayPerTx("3"), spendingCappedAt({ perTx: "10" })])).toEqual(
      {
        per_tx_limit: { min: "3.00", max: "10.00" },
      },
    );
    expect(mergeConstraints([{ balance: { min: "0" } }])).toEqual({});
    expect(() => mergeConstraints([canPayPerTx("10"), spendingCappedAt({ perTx: "5" })])).toThrow(
      /cannot all hold/,
    );
  });
});

describe("proof requests", () => {
  it("builds valid requests with defaults", () => {
    const request = createProofRequest({ scope: SCOPE, require: [verifiedCompany()] });
    expect(request.type).toBe("agentbank.proof_request.v1");
    expect(request.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(request.nonce).toMatch(/^0x[0-9a-f]{62}$/);
    expect(request.expires_at - request.issued_at).toBe(300);
    expect(request.max_root_age_seconds).toBe(7200);
    expect(request.min_anonymity_set).toBe(16);
    expect(request.chain_id).toBe(DEFAULT_CHAIN_ID);
    expect(request.registry).toBeNull();
    expect(Math.abs(request.issued_at - Date.now() / 1000)).toBeLessThan(5);
    expect(createProofRequest({ scope: SCOPE }).constraints).toEqual({});
  });

  it("accepts on-chain scope ids, and reservations tag them like scopeOf", () => {
    const consumer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const context = `0x${"cd".repeat(32)}` as const;
    const scope = onchainScopeId(84532, consumer, context);
    const request = createProofRequest({
      scope,
      require: [verifiedCompany(), reservedFor("10.00", { forSeconds: 600 })],
      now: NOW,
    });
    expect(request.scope).toBe(scope);
    expect(parseProofRequest(request)).toEqual(request);
    const tag = scopeTag(onchainScope(84532, consumer, context)).toString();
    expect(tag).toBe(scopeTagOf(scope).toString());
    expect(request.constraints.reserved_for).toEqual({ min: tag, max: tag });
    // The longest on-chain id (a 32-digit chain id) still fits the 253-character limit.
    const longest = onchainScopeId(10n ** 32n - 1n, consumer, context);
    expect(parseProofRequest({ ...request, scope: longest }).scope).toBe(longest);
  });

  it("hashes requests as canonical keccak", () => {
    const request = standardRequest();
    expect(requestHash(request)).toBe(canonicalKeccak(request));
    expect(requestHash({ ...request, request_id: "0".repeat(32) })).not.toBe(requestHash(request));
  });

  it("refuses invalid requests", () => {
    expect(() => createProofRequest({ scope: "" })).toThrow(/scope/);
    expect(() => createProofRequest({ scope: SCOPE, ttlSeconds: 0 })).toThrow(/ttlSeconds/);
    expect(() => createProofRequest({ scope: SCOPE, nonce: "0x12" })).toThrow(/nonce/);
    expect(() => createProofRequest({ scope: SCOPE, now: -1 })).toThrow(/unix seconds/);
    const request = standardRequest();
    expect(parseProofRequest(request)).toEqual(request);
    expect(() => parseProofRequest({ ...request, type: "other" })).toThrow(ProofRequestError);
    expect(() => parseProofRequest("nope")).toThrow(/invalid proof request: request/);
    expect(() =>
      parseProofRequest({ ...request, constraints: { balance: { min: "10", max: "1" } } }),
    ).toThrow(/min is greater/);
  });
});

describe("witness satisfaction", () => {
  const { baseWitness, reservationWitness } = buildFixture();

  it("passes a satisfiable request", () => {
    expect(checkWitnessSatisfies(baseWitness, standardRequest())).toEqual([]);
    expect(checkWitness(baseWitness, standardRequest())).toEqual({
      outOfBounds: [],
      undisclosed: [],
      undisclosedClasses: [],
    });
  });

  it("names out-of-bounds and undisclosed attributes", () => {
    const greedy = standardRequest({
      require: [balanceAtLeast("5000"), reservedFor("1", { forSeconds: 60 }), verifiedCompany()],
    });
    expect(checkWitnessSatisfies(baseWitness, greedy)).toEqual([
      "balance",
      "reserved_amount",
      "reserved_until",
      "reserved_for",
    ]);
    const hidden = { ...reservationWitness, disclosure_mask: disclosureMask(["principal", "reservations"]) };
    const report = checkWitness(hidden, standardRequest());
    expect(report.outOfBounds).toEqual([]);
    expect(report.undisclosed).toEqual([
      "per_tx_limit",
      "balance",
      "account_created_on",
      "payments_settled",
      "disputes_lost",
    ]);
    expect(report.undisclosedClasses).toEqual(["limits", "balance", "account_age", "reputation"]);
    const garbled = { ...baseWitness, attributes: { ...baseWitness.attributes, balance: "x" } };
    expect(checkWitnessSatisfies(garbled, standardRequest())).toContain("balance");
  });
});
