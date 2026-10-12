import { SimulatedChain } from "@agentbank/chain/simulated";
import { CHAINS, getAsset, systemClock, usdc } from "@agentbank/core";
import { X402PaymentPayload, X402VerifyRequest } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { x402Client } from "@x402/core/client";
import { PaymentPayloadV2Schema } from "@x402/core/schemas";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { Facilitator } from "../src/facilitator";
import { simulatedReceipts } from "../src/receipts";
import { SandboxScreening } from "../src/screening";
import { payer, relayer, seller } from "./helpers";

/**
 * Interop with the x402 reference implementation, over real HTTP: `@x402/core`'s
 * `HTTPFacilitatorClient` (what sellers configure with `…/v1/x402`), its `x402ResourceServer`,
 * and `@x402/evm`'s exact-scheme client building the EIP-3009 payload the way every x402 buyer
 * does. The chain and the facilitator run on the system clock because the reference client
 * timestamps authorizations with `Date.now()`.
 */

const NETWORK = "eip155:1337" as const;
const usdcAsset = getAsset(CHAINS.simulated.id, "USDC");

let db: SqlClient;
let chain: SimulatedChain;
let app: FastifyInstance;
let facilitatorUrl: string;
let facilitatorClient: HTTPFacilitatorClient;

function requirements(amount: bigint, payTo: string = seller): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: usdcAsset.address,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2" },
  };
}

async function buyerPays(accepts: PaymentRequirements[]): Promise<PaymentPayload> {
  const buyer = new x402Client();
  registerExactEvmScheme(buyer, { signer: payer });
  // The simulated chain's USDC is not one of x402's default assets: opt in, with a per-payment cap.
  buyer.setSpendControls({
    allowedAssets: [{ network: NETWORK, asset: usdcAsset.address, maxAmountPerPayment: "5000000" }],
  });
  return buyer.createPaymentPayload({
    x402Version: 2,
    resource: {
      url: "https://seller.example/report",
      description: "Market report",
      mimeType: "application/json",
    },
    accepts,
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  chain = new SimulatedChain({ clock: systemClock });
  chain.faucet(payer.address, usdc("100"));
  const facilitator = new Facilitator({
    db,
    gateway: chain.gateway,
    receipts: simulatedReceipts(chain),
    screening: new SandboxScreening(),
    clock: systemClock,
    relayer,
    options: { chain: CHAINS.simulated, asset: usdcAsset },
  });
  app = buildApp({ facilitator });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  facilitatorUrl = `${address}/v1/x402`;
  facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs: 10_000 });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("x402 reference HTTPFacilitatorClient against the running facilitator", () => {
  it("getSupported parses and advertises exact on the served network", async () => {
    const supported = await facilitatorClient.getSupported();
    expect(supported.kinds).toEqual([
      expect.objectContaining({ x402Version: 2, scheme: "exact", network: NETWORK }),
    ]);
    expect(supported.kinds[0]?.extra).toMatchObject({
      settleBeforeServeAbove: "1.00",
      name: "USDC",
      version: "2",
    });
    expect(supported.signers).toEqual({ "eip155:*": [relayer.address] });
  });

  it("verifies and settles a payload built by @x402/evm's exact client, then refuses the replay", async () => {
    const required = requirements(usdc("0.25"));
    const payload = await buyerPays([required]);

    // Wire-format cross-check: the reference payload parses with both schemas.
    expect(PaymentPayloadV2Schema.safeParse(payload).success).toBe(true);
    expect(X402PaymentPayload.safeParse(payload).success).toBe(true);
    expect(
      X402VerifyRequest.safeParse({ x402Version: 2, paymentPayload: payload, paymentRequirements: required })
        .success,
    ).toBe(true);

    const verified = await facilitatorClient.verify(payload, required);
    expect(verified).toMatchObject({ isValid: true, payer: payer.address });

    const before = chain.balanceOf(seller);
    const settled = await facilitatorClient.settle(payload, required);
    expect(settled).toMatchObject({
      success: true,
      payer: payer.address,
      network: NETWORK,
      amount: "250000",
    });
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.balanceOf(seller) - before).toBe(usdc("0.25"));

    const replay = await facilitatorClient.verify(payload, required);
    expect(replay).toMatchObject({ isValid: false, invalidReason: "authorization_already_used" });
    // An identical settle is idempotent: the original transaction, no second transfer.
    expect(await facilitatorClient.settle(payload, required)).toMatchObject({
      success: true,
      transaction: settled.transaction,
    });
    expect(chain.balanceOf(seller) - before).toBe(usdc("0.25"));
  });

  it("returns refusals as isValid/success false (HTTP 200) and malformed requests as VerifyError", async () => {
    const payload = await buyerPays([requirements(usdc("0.10"))]);
    const tampered = requirements(usdc("0.20"));
    const refused = await facilitatorClient.verify({ ...payload, accepted: tampered }, tampered);
    expect(refused).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_authorization_value",
    });
    const notSettled = await facilitatorClient.settle({ ...payload, accepted: tampered }, tampered);
    expect(notSettled).toMatchObject({
      success: false,
      errorReason: "invalid_exact_evm_payload_authorization_value",
      transaction: "",
    });

    // A body that breaks the core contract (payTo is not an address) is HTTP 400: the reference
    // client surfaces it as a VerifyError carrying the x402 reason.
    const broken = { ...requirements(usdc("0.10")), payTo: "not-an-address" };
    const error = await facilitatorClient.verify(payload, broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerifyError);
    expect(error).toMatchObject({ statusCode: 400, invalidReason: "invalid_payment_requirements" });
  });
});

describe("x402 reference resource server (seller) charging through Agent Bank's facilitator", () => {
  it("initializes from /supported, then verifies and settles a buyer's payment", async () => {
    const server = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());
    await server.initialize();
    expect(server.getSupportedKind(2, NETWORK, "exact")).toBeDefined();

    const accepts = await server.buildPaymentRequirements({
      scheme: "exact",
      payTo: seller,
      network: NETWORK,
      maxTimeoutSeconds: 120,
      price: {
        asset: usdcAsset.address,
        amount: usdc("0.75").toString(),
        extra: { name: "USDC", version: "2" },
      },
    });
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
      url: "https://seller.example/report",
      description: "Market report",
      mimeType: "application/json",
    });
    const payload = await buyerPays(paymentRequired.accepts);
    const matched = server.findMatchingRequirements(paymentRequired.accepts, payload);
    expect(matched).toBeDefined();

    const verified = await server.verifyPayment(payload, matched as PaymentRequirements);
    expect(verified.isValid).toBe(true);
    const before = chain.balanceOf(seller);
    const settled = await server.settlePayment(payload, matched as PaymentRequirements);
    expect(settled).toMatchObject({ success: true, network: NETWORK, payer: payer.address });
    expect(chain.balanceOf(seller) - before).toBe(usdc("0.75"));
  });
});
