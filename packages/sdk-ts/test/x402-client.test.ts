import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { describe, expect, it } from "vitest";
import type { AgentBankError } from "../src";
import {
  assertAuthorizationMatches,
  buildPaymentHeader,
  decodeHeaderValue,
  encodeHeaderValue,
  parseChallenge,
  readPaymentResponse,
  resolveX402Options,
  selectRequirement,
  X402Error,
  X402_HEADERS,
  type X402PayResponse,
} from "../src";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x7777777777777777777777777777777777777777";

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:84532",
    asset: USDC,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

function challengeResponse(accepts: unknown[], extra: Record<string, unknown> = {}) {
  const body = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: "https://seller.test/x" },
    accepts,
    ...extra,
  };
  return new Response("{}", {
    status: 402,
    headers: { [X402_HEADERS.paymentRequired]: encodeHeaderValue(body) },
  });
}

describe("x402 header encoding", () => {
  it("round-trips with the reference @x402/core encoders (including non-ASCII)", () => {
    const required = {
      x402Version: 2,
      resource: { url: "https://seller.test/é", description: "Météo ☀️" },
      accepts: [requirement()],
    };
    const ours = encodeHeaderValue(required);
    expect(ours).toBe(encodePaymentRequiredHeader(required as never));
    expect(decodePaymentRequiredHeader(ours)).toEqual(required);
    expect(decodeHeaderValue(encodePaymentRequiredHeader(required as never))).toEqual(required);

    const settle = { success: true, transaction: "0xabc", network: "eip155:84532", payer: PAY_TO };
    expect(decodeHeaderValue(encodePaymentResponseHeader(settle as never))).toEqual(settle);
    expect(decodePaymentResponseHeader(encodeHeaderValue(settle))).toEqual(settle);
    expect(readPaymentResponse(new Headers({ "PAYMENT-RESPONSE": encodeHeaderValue(settle) }))).toEqual(
      settle,
    );
    expect(readPaymentResponse(new Headers({ "X-PAYMENT-RESPONSE": encodeHeaderValue(settle) }))).toEqual(
      settle,
    );
    expect(readPaymentResponse(new Headers({ "PAYMENT-RESPONSE": "%%%" }))).toBeUndefined();
    expect(() => decodeHeaderValue("not base64!")).toThrow();
  });

  it("builds v2 PAYMENT-SIGNATURE payloads the reference decoder reads, echoing accepted/resource/extensions", async () => {
    const accepted = requirement({ extra: { name: "USDC", version: "2", custom: [1, 2] } });
    const challenge = await parseChallenge(
      challengeResponse([accepted], { extensions: { bazaar: { info: 1 } } }),
    );
    if (!challenge) throw new Error("no challenge");
    const selected = selectRequirement(challenge, resolveX402Options());
    const exact = {
      signature: "0x1234",
      authorization: {
        from: PAY_TO,
        to: PAY_TO,
        value: "10000",
        validAfter: "0",
        validBefore: "99",
        nonce: `0x${"ab".repeat(32)}`,
      },
    };
    const header = buildPaymentHeader(challenge, selected, exact);
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    const decoded = decodePaymentSignatureHeader(header.value);
    expect(decoded).toEqual({
      x402Version: 2,
      resource: { url: "https://seller.test/x" },
      accepted,
      payload: exact,
      extensions: { bazaar: { info: 1 } },
    });
  });
});

describe("challenge parsing and requirement selection", () => {
  it("parses v2 headers and v1 bodies, ignores plain 402s and rejects garbage headers", async () => {
    const v2 = await parseChallenge(challengeResponse([requirement()]));
    expect(v2?.version).toBe(2);
    const v1 = await parseChallenge(
      Response.json(
        { x402Version: 1, accepts: [{ scheme: "exact", network: "base-sepolia" }] },
        { status: 402 },
      ),
    );
    expect(v1?.version).toBe(1);
    expect(await parseChallenge(new Response("pay up", { status: 402 }))).toBeUndefined();
    await expect(
      parseChallenge(new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": "e30=" } })),
    ).rejects.toMatchObject({ reason: "invalid_challenge" });
  });

  it("picks the cheapest exact USDC option on the configured network", async () => {
    const challenge = await parseChallenge(
      challengeResponse([
        requirement({ network: "eip155:8453", amount: "1" }),
        requirement({ scheme: "upto", amount: "2" }),
        requirement({ asset: "0x1111111111111111111111111111111111111111", amount: "3" }),
        requirement({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" }, amount: "4" }),
        { scheme: "exact", network: "solana:devnet", amount: "5" },
        requirement({ amount: "20000" }),
        requirement({ amount: "15000" }),
      ]),
    );
    if (!challenge) throw new Error("no challenge");
    const selected = selectRequirement(challenge, resolveX402Options({ maxAmountPerRequest: "0.10" }));
    expect(selected.amount).toBe(15000n);
    expect(selected.chainId).toBe(84532);
    expect(() => selectRequirement(challenge, resolveX402Options({ maxAmountPerRequest: "0.01" }))).toThrow(
      /exceeds maxAmountPerRequest 0.01/,
    );
  });

  it("maps v1 network names and fails clearly when nothing is acceptable", async () => {
    const v1 = await parseChallenge(
      Response.json(
        {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              maxAmountRequired: "5000",
              resource: "https://seller.test/v1",
              description: "d",
              mimeType: "text/plain",
              payTo: PAY_TO,
              maxTimeoutSeconds: 30,
              asset: USDC,
              extra: { name: "USDC", version: "2" },
            },
          ],
        },
        { status: 402 },
      ),
    );
    if (!v1) throw new Error("no challenge");
    const selected = selectRequirement(v1, resolveX402Options());
    expect(selected).toMatchObject({
      version: 1,
      network: "base-sepolia",
      caip2Network: "eip155:84532",
      amount: 5000n,
    });
    expect(buildPaymentHeader(v1, selected, { signature: "0x", authorization: {} as never }).name).toBe(
      "X-PAYMENT",
    );

    const none = await parseChallenge(challengeResponse([requirement({ network: "eip155:1" })]));
    if (!none) throw new Error("no challenge");
    const error = (() => {
      try {
        selectRequirement(none, resolveX402Options());
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(X402Error);
    expect((error as X402Error).reason).toBe("no_acceptable_requirement");
  });

  it("refuses mainnet networks and malformed caps", () => {
    const mainnet = (() => {
      try {
        resolveX402Options({ network: "eip155:8453" });
      } catch (e) {
        return e;
      }
    })();
    expect((mainnet as AgentBankError).code).toBe("mainnet_locked");
    expect(() => resolveX402Options({ network: "base-sepolia" })).toThrow(/CAIP-2/);
    expect(() => resolveX402Options({ maxAmountPerRequest: "1.2.3" })).toThrow();
  });
});

describe("authorization checks before signing", () => {
  const now = 1_790_000_000;
  const selected = {
    version: 2 as const,
    raw: requirement(),
    scheme: "exact" as const,
    network: "eip155:84532",
    caip2Network: "eip155:84532",
    chainId: 84532,
    asset: USDC,
    amount: 10_000n,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    resource: undefined,
  };
  const spend = "0x5555555555555555555555555555555555555555";
  function response(overrides: { authorization?: object; domain?: object } = {}): X402PayResponse {
    return {
      object: "x402_authorization",
      payment: {} as X402PayResponse["payment"],
      authorization: {
        from: spend,
        to: PAY_TO,
        value: "10000",
        validAfter: "0",
        validBefore: String(now + 60),
        nonce: `0x${"cd".repeat(32)}`,
        ...overrides.authorization,
      },
      eip712_domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC,
        ...overrides.domain,
      },
    };
  }

  it("accepts an exact match", () => {
    expect(() => assertAuthorizationMatches(response(), selected, spend, now)).not.toThrow();
  });

  it.each([
    [{ authorization: { to: "0x0000000000000000000000000000000000000001" } }, /to differs/],
    [{ authorization: { value: "10001" } }, /value differs/],
    [{ authorization: { from: PAY_TO } }, /from is not the spend key/],
    [{ authorization: { validBefore: String(now - 1) } }, /expired/],
    [{ authorization: { validBefore: String(now + 3600) } }, /exceeds maxTimeoutSeconds/],
    [{ domain: { chainId: 8453 } }, /chainId differs/],
    [{ domain: { verifyingContract: PAY_TO } }, /verifyingContract differs/],
    [{ domain: { name: "Fake USDC" } }, /name differs/],
  ])("refuses a mismatched authorization %#", (overrides, message) => {
    expect(() => assertAuthorizationMatches(response(overrides), selected, spend, now)).toThrow(message);
  });
});
