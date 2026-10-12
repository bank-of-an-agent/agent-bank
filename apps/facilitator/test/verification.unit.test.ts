import { CHAINS, getAsset } from "@agentbank/core";
import { concat, hashTypedData, numberToHex, size, slice, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  authorizationDigest,
  authorizationTypedData,
  checkTerms,
  classifySignature,
  normalizeEcdsaSignature,
  parsePayment,
  parseRequestBody,
  recoverEcdsaSigner,
  requestFingerprint,
  type ExactAuthorization,
  type FacilitatorRequest,
  type ParsedPayment,
} from "../src/verification";
import { erc6492Wrap, otherSeller, payer, randomNonce, seller, stranger } from "./helpers";

/**
 * The viem-only layer: request parsing, every static rule and its reason code, EIP-712 hashing
 * and signature handling. No database, no chain.
 */

const served = { chain: CHAINS.simulated, asset: getAsset(CHAINS.simulated.id, "USDC") };
const NOW = 1_791_720_000n; // 2026-10-11T12:00:00Z
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function authorization(overrides: Partial<ExactAuthorization> = {}): ExactAuthorization {
  return {
    from: payer.address,
    to: seller,
    value: 10_000n,
    validAfter: NOW - 600n,
    validBefore: NOW + 60n,
    nonce: randomNonce(),
    ...overrides,
  };
}

async function request(edit: (r: FacilitatorRequest) => void = () => undefined): Promise<FacilitatorRequest> {
  const auth = authorization();
  const signature = await payer.signTypedData(authorizationTypedData(served.asset, auth));
  const requirements = {
    scheme: "exact",
    network: "eip155:1337",
    asset: served.asset.address,
    amount: "10000",
    payTo: seller,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
  const r: FacilitatorRequest = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: { ...requirements },
      payload: {
        signature,
        authorization: {
          from: auth.from,
          to: auth.to,
          value: auth.value.toString(),
          validAfter: auth.validAfter.toString(),
          validBefore: auth.validBefore.toString(),
          nonce: auth.nonce,
        },
      },
    },
    paymentRequirements: requirements,
  };
  edit(r);
  return r;
}

function parsed(r: FacilitatorRequest): ParsedPayment {
  const result = parsePayment(r, served);
  if (!result.ok) throw new Error(`expected a parsed payment, got ${result.rejection.reason}`);
  return result.value;
}

function reasonOf(r: FacilitatorRequest): string | undefined {
  const result = parsePayment(r, served);
  return result.ok ? undefined : result.rejection.reason;
}

describe("parseRequestBody (core contract)", () => {
  it("accepts an x402 v2 verify body", async () => {
    expect(parseRequestBody(await request()).ok).toBe(true);
  });

  it.each([
    ["no body", undefined],
    ["an array", []],
    [
      "a v1 payload (no accepted)",
      {
        x402Version: 1,
        paymentPayload: { x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} },
      },
    ],
  ])("refuses %s with HTTP 400 invalid_payload", (_name, body) => {
    const result = parseRequestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toMatchObject({ reason: "invalid_payload", status: 400 });
    }
  });

  it("names the requirements when they are malformed", async () => {
    const body = await request((r) => {
      (r.paymentRequirements as { payTo: string }).payTo = "not-an-address";
    });
    const result = parseRequestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("invalid_payment_requirements");
      expect(result.rejection.status).toBe(400);
      expect(result.rejection.message).toContain("paymentRequirements.payTo");
    }
  });
});

describe("parsePayment: protocol, requirements and payload shape", () => {
  it("normalizes a valid payment", async () => {
    const r = await request((x) => {
      x.paymentRequirements.payTo = seller.toLowerCase();
      x.paymentPayload.accepted.payTo = seller.toLowerCase();
    });
    const p = parsed(r);
    expect(p.payTo).toBe(seller);
    expect(p.payer).toBe(payer.address);
    expect(p.chainId).toBe(1337);
    expect(p.amount).toBe(10_000n);
    expect(p.authorization.nonce).toBe(p.authorization.nonce.toLowerCase());
  });

  it("refuses x402 version 1 inside a v2-shaped body", async () => {
    expect(reasonOf(await request((r) => (r.paymentPayload.x402Version = 1)))).toBe("invalid_x402_version");
    expect(reasonOf(await request((r) => (r.x402Version = 1)))).toBe("invalid_x402_version");
  });

  it("refuses schemes other than exact", async () => {
    expect(reasonOf(await request((r) => (r.paymentRequirements.scheme = "upto")))).toBe(
      "unsupported_scheme",
    );
  });

  it.each([
    ["a v1 network name", "base-sepolia"],
    ["another testnet", "eip155:84532"],
    ["Base mainnet", "eip155:8453"],
    ["Ethereum mainnet", "eip155:1"],
    ["a non-EVM network", "solana:devnet"],
  ])("refuses %s as invalid_network", async (_name, network) => {
    const r = await request((x) => {
      x.paymentRequirements.network = network;
      x.paymentPayload.accepted.network = network;
    });
    const result = parsePayment(r, served);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("invalid_network");
      if (network === "eip155:8453" || network === "eip155:1")
        expect(result.rejection.message).toMatch(/mainnet/);
    }
  });

  it("refuses an asset that is not USDC on the served chain", async () => {
    const other = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC on Base Sepolia, not on 1337
    const r = await request((x) => {
      x.paymentRequirements.asset = other;
      x.paymentPayload.accepted.asset = other;
    });
    expect(reasonOf(r)).toBe("unsupported_asset");
  });

  it("refuses a zero amount", async () => {
    const r = await request((x) => {
      x.paymentRequirements.amount = "0";
      x.paymentPayload.accepted.amount = "0";
    });
    expect(reasonOf(r)).toBe("invalid_payment_requirements");
  });

  it.each([
    ["scheme", (r: FacilitatorRequest) => (r.paymentPayload.accepted.scheme = "upto")],
    ["network", (r: FacilitatorRequest) => (r.paymentPayload.accepted.network = "eip155:84532")],
    ["amount", (r: FacilitatorRequest) => (r.paymentPayload.accepted.amount = "1")],
    ["payTo", (r: FacilitatorRequest) => (r.paymentPayload.accepted.payTo = otherSeller)],
    ["maxTimeoutSeconds", (r: FacilitatorRequest) => (r.paymentPayload.accepted.maxTimeoutSeconds = 3600)],
  ])("refuses accepted != requirements (%s)", async (field, edit) => {
    const result = parsePayment(await request(edit), served);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("accepted_requirements_mismatch");
      expect(result.rejection.message).toContain(field);
    }
  });

  it("refuses Permit2 and other payload types", async () => {
    const permit2 = await request((r) => {
      r.paymentPayload.payload = { signature: "0x00", permit2Authorization: {} };
    });
    expect(reasonOf(permit2)).toBe("unsupported_payload_type");
    expect(reasonOf(await request((r) => (r.paymentPayload.payload = { transaction: "0x00" })))).toBe(
      "unsupported_payload_type",
    );
  });

  it("refuses a malformed exact payload", async () => {
    const r = await request((x) => {
      (x.paymentPayload.payload.authorization as { value: string }).value = "-5";
    });
    expect(reasonOf(r)).toBe("invalid_payload");
    const big = await request((x) => {
      (x.paymentPayload.payload.authorization as { validBefore: string }).validBefore = (
        2n ** 256n
      ).toString();
    });
    expect(reasonOf(big)).toBe("invalid_payload");
  });

  it.each([
    ["31 bytes", `0x${"ab".repeat(31)}`],
    ["33 bytes", `0x${"ab".repeat(33)}`],
    ["empty", "0x"],
  ])("refuses a nonce of %s", async (_name, nonce) => {
    const r = await request((x) => {
      (x.paymentPayload.payload.authorization as { nonce: string }).nonce = nonce;
    });
    expect(reasonOf(r)).toBe("invalid_exact_evm_payload_nonce");
  });
});

describe("checkTerms: recipient, amount and validity window", () => {
  const context = { nowSeconds: Number(NOW) };

  async function withAuth(edit: Partial<ExactAuthorization>, maxTimeoutSeconds = 60): Promise<ParsedPayment> {
    const p = parsed(await request());
    return { ...p, maxTimeoutSeconds, authorization: { ...p.authorization, ...edit } };
  }

  it("accepts a payment inside every bound", async () => {
    expect(checkTerms(await withAuth({}), context)).toBeUndefined();
  });

  it("refuses authorization.to != payTo", async () => {
    expect(checkTerms(await withAuth({ to: otherSeller }), context)?.reason).toBe(
      "invalid_exact_evm_payload_recipient_mismatch",
    );
  });

  it("refuses a value that is not exactly the amount (more or less)", async () => {
    expect(checkTerms(await withAuth({ value: 9_999n }), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_value",
    );
    expect(checkTerms(await withAuth({ value: 10_001n }), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_value",
    );
  });

  it("enforces the optional settlement cap", async () => {
    const p = await withAuth({});
    expect(checkTerms(p, { ...context, maxSettlement: 9_999n })?.reason).toBe(
      "amount_exceeds_max_settlement",
    );
    expect(checkTerms(p, { ...context, maxSettlement: 10_000n })).toBeUndefined();
  });

  it("validAfter <= now", async () => {
    expect(checkTerms(await withAuth({ validAfter: NOW }), context)).toBeUndefined();
    expect(checkTerms(await withAuth({ validAfter: NOW + 1n }), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_valid_after",
    );
  });

  it("validBefore >= now + 6", async () => {
    expect(checkTerms(await withAuth({ validBefore: NOW + 6n }), context)).toBeUndefined();
    expect(checkTerms(await withAuth({ validBefore: NOW + 5n }), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    );
    expect(checkTerms(await withAuth({ validBefore: NOW - 1n }), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    );
  });

  it("validBefore - now <= maxTimeoutSeconds + 60", async () => {
    expect(checkTerms(await withAuth({ validBefore: NOW + 120n }, 60), context)).toBeUndefined();
    expect(checkTerms(await withAuth({ validBefore: NOW + 121n }, 60), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_validity_too_long",
    );
    expect(checkTerms(await withAuth({ validBefore: 2n ** 256n - 1n }, 60), context)?.reason).toBe(
      "invalid_exact_evm_payload_authorization_validity_too_long",
    );
  });
});

describe("EIP-712 digest and signatures", () => {
  it("hashes TransferWithAuthorization under the asset's domain", () => {
    const auth = authorization();
    const expected = hashTypedData({
      domain: { name: "USDC", version: "2", chainId: 1337, verifyingContract: served.asset.address },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: auth,
    });
    expect(authorizationDigest(served.asset, auth)).toBe(expected);
  });

  it("recovers the EOA that signed with viem signTypedData", async () => {
    const auth = authorization();
    const signature = await payer.signTypedData(authorizationTypedData(served.asset, auth));
    expect(await recoverEcdsaSigner(authorizationDigest(served.asset, auth), signature)).toBe(payer.address);
  });

  it("accepts v = 0/1 by normalizing it to 27/28", async () => {
    const auth = authorization();
    const digest = authorizationDigest(served.asset, auth);
    const signature = await payer.sign({ hash: digest });
    const v = Number(BigInt(slice(signature, 64, 65)));
    const lowV = concat([slice(signature, 0, 64), numberToHex(v - 27, { size: 1 })]);
    expect(await recoverEcdsaSigner(digest, lowV)).toBe(payer.address);
    expect(normalizeEcdsaSignature(lowV)).toBe(signature);
  });

  it("refuses the malleable high-s twin of a valid signature (FiatToken ECRecover rule)", async () => {
    const auth = authorization();
    const digest = authorizationDigest(served.asset, auth);
    const signature = await payer.sign({ hash: digest });
    const s = BigInt(slice(signature, 32, 64));
    const v = Number(BigInt(slice(signature, 64, 65)));
    const twin = concat([
      slice(signature, 0, 32),
      numberToHex(N - s, { size: 32 }),
      numberToHex(v === 27 ? 28 : 27, { size: 1 }),
    ]);
    expect(await recoverEcdsaSigner(digest, twin)).toBeUndefined();
    expect(normalizeEcdsaSignature(twin)).toBeUndefined();
  });

  it("refuses v values other than 0/1/27/28 and zero r or s", async () => {
    const auth = authorization();
    const digest = authorizationDigest(served.asset, auth);
    const signature = await payer.sign({ hash: digest });
    expect(await recoverEcdsaSigner(digest, concat([slice(signature, 0, 64), "0x1d"]))).toBeUndefined();
    expect(
      await recoverEcdsaSigner(digest, concat([numberToHex(0n, { size: 32 }), slice(signature, 32)])),
    ).toBeUndefined();
    expect(await recoverEcdsaSigner(digest, `0x${"00".repeat(65)}`)).toBeUndefined();
  });

  it("recovers a different address for the wrong signer or the wrong domain", async () => {
    const auth = authorization();
    const digest = authorizationDigest(served.asset, auth);
    expect(
      await recoverEcdsaSigner(
        digest,
        await stranger.signTypedData(authorizationTypedData(served.asset, auth)),
      ),
    ).toBe(stranger.address);
    const baseSepolia = getAsset(CHAINS["base-sepolia"].id, "USDC");
    const wrongDomain = await payer.signTypedData(authorizationTypedData(baseSepolia, auth));
    expect(await recoverEcdsaSigner(digest, wrongDomain)).not.toBe(payer.address);
  });

  it("classifies ECDSA, ERC-1271 and ERC-6492 signatures", async () => {
    const ecdsa = await payer.sign({ hash: authorizationDigest(served.asset, authorization()) });
    expect(classifySignature(ecdsa)).toEqual({ kind: "ecdsa", signature: ecdsa });
    const contract = concat([seller, ecdsa]);
    expect(size(contract)).toBe(85);
    expect(classifySignature(contract)).toEqual({ kind: "contract", signature: contract });
    const wrapped = erc6492Wrap(otherSeller, "0x1234", contract);
    expect(classifySignature(wrapped)).toEqual({ kind: "erc6492", inner: contract.toLowerCase() });
    const broken = concat(["0xdeadbeef", wrapped.slice(-64) as Hex]);
    expect(classifySignature(broken)).toEqual({ kind: "erc6492", inner: undefined });
  });
});

describe("requestFingerprint", () => {
  it("is stable across address case and differs when anything settled differs", async () => {
    const r = await request();
    const a = parsed(r);
    const lower = parsed({
      ...r,
      paymentRequirements: { ...r.paymentRequirements, payTo: seller.toLowerCase() },
      paymentPayload: {
        ...r.paymentPayload,
        accepted: { ...r.paymentPayload.accepted, payTo: seller.toLowerCase() },
      },
    });
    expect(requestFingerprint(lower)).toBe(requestFingerprint(a));
    expect(requestFingerprint({ ...a, payTo: otherSeller })).not.toBe(requestFingerprint(a));
    const otherKey = privateKeyToAccount(generatePrivateKey());
    const resigned = await otherKey.signTypedData(authorizationTypedData(served.asset, a.authorization));
    expect(requestFingerprint({ ...a, signature: resigned })).not.toBe(requestFingerprint(a));
    // The resource and maxTimeoutSeconds do not change what is settled.
    expect(requestFingerprint({ ...a, maxTimeoutSeconds: 3600, resourceUrl: "https://other.example" })).toBe(
      requestFingerprint(a),
    );
  });
});
