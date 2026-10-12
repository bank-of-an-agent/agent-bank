import { CHAINS, getAsset, usdc } from "@agentbank/core";
import { routes } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { concat, numberToHex, slice } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationStore } from "../src/store";
import { authorizationDigest } from "../src/verification";
import { SandboxScreening, type ScreeningProvider } from "../src/screening";
import {
  buildPayment,
  createHarness,
  erc6492Wrap,
  otherRelayer,
  otherSeller,
  overrideGateway,
  payer,
  SANCTIONED,
  seller,
  stranger,
  tamper,
  type Harness,
} from "./helpers";

let db: SqlClient;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

function funded(options: Parameters<typeof createHarness>[1] = {}): Harness {
  const h = createHarness(db, options);
  h.chain.faucet(payer.address, usdc("100"));
  return h;
}

async function rowCount(): Promise<bigint> {
  const { rows } = await db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM x402_authorization");
  return rows[0]?.n ?? 0n;
}

async function expectInvalid(h: Harness, body: unknown, reason: string, status = 200): Promise<string> {
  const out = await h.facilitator.verify(body);
  expect(out.body.isValid).toBe(false);
  expect(out.body.invalidReason).toBe(reason);
  expect(out.status).toBe(status);
  expect(routes.x402Verify.response.safeParse(out.body).success).toBe(true);
  return out.body.invalidMessage ?? "";
}

describe("verify: a valid EOA (spend key) payment", () => {
  it("is valid, names the payer and writes nothing", async () => {
    const h = funded();
    const before = await rowCount();
    const { body } = await buildPayment(h);
    const out = await h.facilitator.verify(body);
    expect(out).toEqual({ status: 200, body: { isValid: true, payer: payer.address } });
    expect(routes.x402Verify.response.parse(out.body)).toEqual(out.body);
    expect(await rowCount()).toBe(before);
    // Verification is read-only: the same payment still verifies.
    expect((await h.facilitator.verify(body)).body.isValid).toBe(true);
  });

  it("accepts lowercase addresses and a v = 0/1 signature", async () => {
    const h = funded();
    const { body, signature } = await buildPayment(h);
    const v = Number(BigInt(slice(signature, 64, 65)));
    const lowV = concat([slice(signature, 0, 64), numberToHex(v - 27, { size: 1 })]);
    const edited = tamper(body, (b) => {
      b.paymentRequirements.payTo = seller.toLowerCase();
      b.paymentPayload.accepted.payTo = seller.toLowerCase();
      const payload = b.paymentPayload.payload as { signature: string; authorization: { from: string } };
      payload.signature = lowV;
      payload.authorization.from = payer.address.toLowerCase();
    });
    expect((await h.facilitator.verify(edited)).body).toEqual({ isValid: true, payer: payer.address });
  });
});

describe("verify: every rejection reason", () => {
  it("wrong scheme", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { scheme: "upto" });
    await expectInvalid(h, body, "unsupported_scheme");
  });

  it("wrong network (another testnet)", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { network: CHAINS["base-sepolia"].caip2 });
    expect(await expectInvalid(h, body, "invalid_network")).toContain("eip155:1337");
  });

  it("mainnet is refused", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { network: "eip155:8453" });
    expect(await expectInvalid(h, body, "invalid_network")).toMatch(/mainnet/);
  });

  it("wrong asset", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { asset: getAsset(84532, "USDC").address });
    await expectInvalid(h, body, "unsupported_asset");
  });

  it("wrong payTo (authorization pays someone else)", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { to: otherSeller });
    await expectInvalid(h, body, "invalid_exact_evm_payload_recipient_mismatch");
  });

  it("wrong amount (authorization for less than the price)", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { amount: usdc("0.05"), value: usdc("0.01") });
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_value");
  });

  it("wrong amount (more than the price is not accepted either)", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { amount: usdc("0.01"), value: usdc("0.05") });
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_value");
  });

  it("expired", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { validBefore: h.nowSeconds() - 1n });
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_valid_before");
  });

  it("expires within 6 seconds", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { validBefore: h.nowSeconds() + 5n });
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_valid_before");
  });

  it("expires while the seller holds it", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    expect((await h.facilitator.verify(body)).body.isValid).toBe(true);
    h.clock.advanceSeconds(55);
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_valid_before");
  });

  it("not yet valid", async () => {
    const h = funded();
    const { body } = await buildPayment(h, {
      validAfter: h.nowSeconds() + 30n,
      validBefore: h.nowSeconds() + 90n,
    });
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_valid_after");
  });

  it("too-long validity", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { maxTimeoutSeconds: 60, validBefore: h.nowSeconds() + 3600n });
    await expectInvalid(h, body, "invalid_exact_evm_payload_authorization_validity_too_long");
  });

  it("bad signature (garbage bytes)", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { signature: `0x${"11".repeat(65)}` });
    await expectInvalid(h, body, "invalid_exact_evm_payload_signature");
  });

  it("bad signature (tampered after signing)", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    const edited = tamper(body, (b) => {
      (b.paymentPayload.payload as { authorization: { validBefore: string } }).authorization.validBefore = (
        h.nowSeconds() + 59n
      ).toString();
    });
    await expectInvalid(h, edited, "invalid_exact_evm_payload_signature");
  });

  it("bad signature (high-s twin of a valid signature)", async () => {
    const h = funded();
    const { body, signature } = await buildPayment(h);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(slice(signature, 32, 64));
    const v = Number(BigInt(slice(signature, 64, 65)));
    const twin = concat([
      slice(signature, 0, 32),
      numberToHex(n - s, { size: 32 }),
      numberToHex(v === 27 ? 28 : 27, { size: 1 }),
    ]);
    const edited = tamper(body, (b) => {
      (b.paymentPayload.payload as { signature: string }).signature = twin;
    });
    await expectInvalid(h, edited, "invalid_exact_evm_payload_signature");
  });

  it("bad signature (signed for another chain's USDC domain)", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { domain: getAsset(84532, "USDC") });
    await expectInvalid(h, body, "invalid_exact_evm_payload_signature");
  });

  it("wrong signer", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { signer: stranger, from: payer.address });
    const message = await expectInvalid(h, body, "invalid_exact_evm_payload_signature");
    expect(message).toContain(stranger.address);
  });

  it("nonce not 32 bytes", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    const edited = tamper(body, (b) => {
      (b.paymentPayload.payload as { authorization: { nonce: string } }).authorization.nonce =
        `0x${"ab".repeat(16)}`;
    });
    await expectInvalid(h, edited, "invalid_exact_evm_payload_nonce");
  });

  it("nonce used locally (already in the facilitator's authorization log)", async () => {
    const h = funded();
    const built = await buildPayment(h);
    await new AuthorizationStore(db).insertSettling({
      chainId: 1337,
      asset: h.asset.address,
      authorizer: payer.address,
      nonce: built.authorization.nonce,
      payTo: seller,
      amount: built.authorization.value,
      validAfter: built.authorization.validAfter,
      validBefore: built.authorization.validBefore,
      payeeAccountId: null,
      resourceUrl: undefined,
      requestHash: "0xother",
      relayer: undefined,
      at: h.clock.now(),
    });
    // On-chain the nonce is still unused: only the local single-use log knows it.
    expect(
      await h.chain.gateway.authorizationState(h.asset.address, payer.address, built.authorization.nonce),
    ).toBe(false);
    expect(await expectInvalid(h, built.body, "authorization_already_used")).toContain("settling");
  });

  it("nonce used on-chain (relayed elsewhere)", async () => {
    const h = funded();
    const built = await buildPayment(h);
    await h.chain.gateway.settleAuthorization({
      token: h.asset.address,
      ...built.authorization,
      signature: built.signature,
      relayer: otherRelayer,
    });
    await expectInvalid(h, built.body, "invalid_exact_evm_nonce_already_used");
  });

  it("insufficient balance", async () => {
    const h = createHarness(db);
    h.chain.faucet(payer.address, usdc("0.005"));
    const { body } = await buildPayment(h, { amount: usdc("0.01") });
    expect(await expectInvalid(h, body, "insufficient_funds")).toContain("0.005");
  });

  it("screened payer", async () => {
    const h = funded({ screening: new SandboxScreening([payer.address]) });
    const { body } = await buildPayment(h);
    await expectInvalid(h, body, "payer_blocked_by_screening");
  });

  it("screened payee", async () => {
    const h = funded();
    const { body } = await buildPayment(h, { payTo: SANCTIONED });
    await expectInvalid(h, body, "payee_blocked_by_screening");
  });

  it("screening errors fail closed (503)", async () => {
    const broken: ScreeningProvider = { screen: async () => Promise.reject(new Error("vendor down")) };
    const h = funded({ screening: broken });
    const { body } = await buildPayment(h);
    await expectInvalid(h, body, "screening_unavailable", 503);
  });

  it("malformed screening answers fail closed (503)", async () => {
    const odd = {
      screen: async () => ({ risk: "unknown", sanctioned: false, provider: "x" }),
    } as unknown as ScreeningProvider;
    const h = funded({ screening: odd });
    const { body } = await buildPayment(h);
    await expectInvalid(h, body, "screening_unavailable", 503);
  });

  it("chain RPC errors fail closed (502)", async () => {
    const h = funded({
      gateway: (gateway) =>
        overrideGateway(gateway, { getTokenBalance: async () => Promise.reject(new Error("rpc timeout")) }),
    });
    const { body } = await buildPayment(h);
    await expectInvalid(h, body, "chain_unavailable", 502);
  });

  it("database errors fail closed (503)", async () => {
    const brokenDb: SqlClient = {
      driver: "pglite",
      query: async () => Promise.reject(new Error("connection refused")),
      transaction: async () => Promise.reject(new Error("connection refused")),
      exec: async () => Promise.reject(new Error("connection refused")),
      close: async () => undefined,
    };
    const h = createHarness(brokenDb);
    h.chain.faucet(payer.address, usdc("1"));
    const { body } = await buildPayment(h);
    await expectInvalid(h, body, "facilitator_unavailable", 503);
  });

  it("amount above MAX_SETTLEMENT", async () => {
    const h = funded({ options: { maxSettlement: usdc("5") } });
    const { body } = await buildPayment(h, { amount: usdc("5.01") });
    await expectInvalid(h, body, "amount_exceeds_max_settlement");
    const { body: atCap } = await buildPayment(h, { amount: usdc("5") });
    expect((await h.facilitator.verify(atCap)).body.isValid).toBe(true);
  });

  it("undeployed contract wallet (ERC-6492 signature)", async () => {
    const h = funded();
    const counterfactual = privateKeyToAccount(generatePrivateKey()).address;
    const { body } = await buildPayment(h, {
      from: counterfactual,
      signature: async (auth) =>
        erc6492Wrap(
          otherSeller,
          "0xdeadbeef",
          await payer.sign({ hash: authorizationDigest(h.asset, auth) }),
        ),
    });
    expect(await expectInvalid(h, body, "payer_not_deployed")).toMatch(/ERC-6492/);
  });

  it("undeployed contract wallet (non-ECDSA signature)", async () => {
    const h = funded();
    const counterfactual = privateKeyToAccount(generatePrivateKey()).address;
    const { body } = await buildPayment(h, { from: counterfactual, signature: `0x${"22".repeat(85)}` });
    await expectInvalid(h, body, "payer_not_deployed");
  });

  it("Permit2 payloads are not supported", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    const edited = tamper(body, (b) => {
      b.paymentPayload.payload = { signature: "0x00", permit2Authorization: { from: payer.address } };
    });
    await expectInvalid(h, edited, "unsupported_payload_type");
  });

  it("accepted differs from the requirements", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    const edited = tamper(body, (b) => {
      b.paymentPayload.accepted.payTo = otherSeller;
    });
    await expectInvalid(h, edited, "accepted_requirements_mismatch");
  });

  it("x402 version 1 is refused", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    await expectInvalid(
      h,
      tamper(body, (b) => (b.paymentPayload.x402Version = 1)),
      "invalid_x402_version",
    );
  });

  it.each([
    ["an empty object", {}],
    ["a string", "hello"],
    ["missing requirements", { x402Version: 2, paymentPayload: {} }],
  ])("malformed body (%s) is HTTP 400 invalid_payload", async (_name, body) => {
    const h = funded();
    await expectInvalid(h, body, "invalid_payload", 400);
  });

  it("malformed requirements are HTTP 400 invalid_payment_requirements", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    await expectInvalid(
      h,
      tamper(body, (b) => {
        b.paymentRequirements.amount = "1.5";
      }),
      "invalid_payment_requirements",
      400,
    );
  });

  it("checks run in a fixed order: the signature before state", async () => {
    // An unfunded payer AND the wrong signer: the signature is reported.
    const h = createHarness(db);
    const { body } = await buildPayment(h, { signer: stranger, from: payer.address });
    await expectInvalid(h, body, "invalid_exact_evm_payload_signature");
  });
});

describe("verify: metrics", () => {
  it("emits one EMF line per verification", async () => {
    const h = funded();
    const { body } = await buildPayment(h);
    await h.facilitator.verify(body);
    await h.facilitator.verify(tamper(body, (b) => (b.paymentRequirements.scheme = "upto")));
    const lines = h.emf.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ route: "verify", outcome: "valid", Verifications: 1, Failures: 0 });
    expect(lines[1]).toMatchObject({
      route: "verify",
      outcome: "invalid",
      reason: "unsupported_scheme",
      Verifications: 1,
    });
    expect(h.metrics.counter("facilitator_verifications_total", { outcome: "valid", reason: "none" })).toBe(
      1,
    );
  });
});

describe("verify: payers with code are ERC-1271 only (FiatToken v2.2 SignatureChecker)", () => {
  // An EOA carrying an EIP-7702 delegation has code: USDC never ecrecovers its signatures, it
  // calls isValidSignature on the delegate. (The well-known Anvil development addresses carry
  // such delegations on Base Sepolia.) The simulator has no 7702, so the delegation is modeled.
  function delegated(delegateAccepts: boolean, calls: { hash: string; signature: string }[] = []): Harness {
    return funded({
      gateway: (gateway) =>
        overrideGateway(gateway, {
          isDeployed: async (address) => address === payer.address || gateway.isDeployed(address),
        }),
      contractSignatures: async ({ hash, signature }) => {
        calls.push({ hash, signature });
        return delegateAccepts;
      },
    });
  }

  it("a correct ECDSA signature of a 7702-delegated EOA is refused when its delegate rejects it", async () => {
    const calls: { hash: string; signature: string }[] = [];
    const h = delegated(false, calls);
    const built = await buildPayment(h);
    const message = await expectInvalid(h, built.body, "payer_has_code");
    expect(message).toMatch(/EIP-7702/);
    // The delegate was asked with the exact digest and bytes USDC would pass.
    expect(calls).toEqual([
      { hash: authorizationDigest(h.asset, built.authorization), signature: built.signature },
    ]);
    expect((await h.facilitator.settle(built.body)).body).toMatchObject({
      success: false,
      errorReason: "payer_has_code",
    });
    expect(h.chain.balanceOf(seller)).toBe(0n);
  });

  it("is valid when the delegate's isValidSignature accepts it", async () => {
    const h = delegated(true);
    const { body } = await buildPayment(h);
    expect((await h.facilitator.verify(body)).body).toEqual({ isValid: true, payer: payer.address });
  });

  it("a 65-byte signature with v 0/1 cannot reach isValidSignature unchanged and is refused", async () => {
    const h = delegated(true);
    const { body, signature } = await buildPayment(h);
    const v = Number(BigInt(slice(signature, 64, 65)));
    const lowV = concat([slice(signature, 0, 64), numberToHex(v - 27, { size: 1 })]);
    const edited = tamper(body, (b) => {
      (b.paymentPayload.payload as { signature: string }).signature = lowV;
    });
    expect(await expectInvalid(h, edited, "payer_has_code")).toMatch(/v 27 or 28/);
  });

  it("ERC-1271 call failures fail closed (502)", async () => {
    const h = funded({
      gateway: (gateway) => overrideGateway(gateway, { isDeployed: async () => true }),
      contractSignatures: async () => Promise.reject(new Error("rpc down")),
    });
    const { body } = await buildPayment(h);
    await expectInvalid(h, body, "chain_unavailable", 502);
  });
});
