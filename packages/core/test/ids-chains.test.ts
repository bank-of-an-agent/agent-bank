import { describe, expect, it } from "vitest";
import { assertTestnet, chainById, chainByName, isLockedMainnet } from "../src/chains";
import { getAsset, registerAsset } from "../src/assets";
import { idTimestamp, isId, newId } from "../src/ids";
import { AgentBankError, errorFromProblem } from "../src/errors";

describe("ids", () => {
  it("creates prefixed sortable ids", () => {
    const a = newId("payment", 1_700_000_000_000);
    const b = newId("payment", 1_700_000_000_001);
    expect(a).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId("payment", a)).toBe(true);
    expect(isId("agent", a)).toBe(false);
    expect(a < b).toBe(true);
    expect(idTimestamp(a)).toBe(1_700_000_000_000);
  });

  it("generates unique ids", () => {
    const set = new Set(Array.from({ length: 5000 }, () => newId("entry")));
    expect(set.size).toBe(5000);
  });
});

describe("chains", () => {
  it("refuses mainnets", () => {
    expect(isLockedMainnet(8453)).toBe(true);
    expect(() => assertTestnet(8453)).toThrow(AgentBankError);
    expect(() => assertTestnet(8453)).toThrow(/testnet-only/);
    expect(() => assertTestnet(1)).toThrow(/mainnet/);
  });

  it("resolves supported testnets", () => {
    expect(chainByName("base-sepolia").id).toBe(84532);
    expect(chainById(84532).caip2).toBe("eip155:84532");
    expect(() => chainByName("base")).toThrow(/Unknown chain/);
    expect(() => chainById(999)).toThrow(/not supported/);
  });

  it("knows Base Sepolia USDC and refuses mainnet registrations", () => {
    expect(getAsset(84532, "USDC").address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(() =>
      registerAsset({
        code: "USDC",
        chainId: 8453,
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        eip712: { name: "USD Coin", version: "2" },
      }),
    ).toThrow(/mainnet/);
  });
});

describe("errors", () => {
  it("renders RFC 9457 problems and parses them back", () => {
    const err = new AgentBankError("policy_denied", "per_day exceeded", { rule_hits: ["limits.per_day"] });
    const problem = err.toProblem("/v1/payments");
    expect(problem).toMatchObject({
      type: "urn:agentbank:problem:policy_denied",
      status: 422,
      code: "policy_denied",
      detail: "per_day exceeded",
      instance: "/v1/payments",
      rule_hits: ["limits.per_day"],
    });
    const back = errorFromProblem(problem);
    expect(back.code).toBe("policy_denied");
    expect(back.extensions.rule_hits).toEqual(["limits.per_day"]);
    expect(errorFromProblem({ code: "nope" as never }).code).toBe("internal");
  });
});
