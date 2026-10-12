import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirementsV1 } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import express from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentClient, PolicyDeniedError, readPaymentResponse, X402Error } from "../src";
import { createPaywall, expressPaywall } from "../src/x402-server";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";
import { createLocalFacilitator, USDC_BASE_SEPOLIA } from "./helpers/x402-facilitator";

/**
 * Interop with the reference x402 implementation (`@x402/core`,
 * `@x402/evm`, `@x402/express` 2.28.0):
 *
 * 1. our buyer (`AgentClient.fetch`) pays a seller running the official
 *    Express middleware, verified and settled by the official `exact` EVM
 *    facilitator logic (v2);
 * 2. our buyer answers a v1 challenge with an `X-PAYMENT` payload that the
 *    official v1 facilitator scheme verifies;
 * 3. the official buyer (`x402Client` + `ExactEvmScheme`) pays our paywall.
 */

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SELLER = "0x7777777777777777777777777777777777777777";

const sessionKey = privateKeyToAccount(generatePrivateKey());
const spendKey = privateKeyToAccount(generatePrivateKey());

let api: FakeApi;
const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  api = await startFakeApi({
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    spendAddress: spendKey.address,
    denyAbove: "5.00",
  });
});

afterAll(async () => {
  await api.close();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

function buyer(maxAmountPerRequest = "0.05"): AgentClient {
  return new AgentClient({
    baseUrl: api.url,
    accountId: ACCT,
    session: { id: SES, signer: sessionKey },
    spendKey,
    validateResponses: true,
    x402: { maxAmountPerRequest },
  });
}

describe("our x402 client against the official @x402/express resource server", () => {
  let base: string;
  const local = createLocalFacilitator();

  beforeAll(async () => {
    const resourceServer = new x402ResourceServer(local.client).register(
      "eip155:84532",
      new ExactEvmServerScheme(),
    );
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: SELLER },
            description: "Weather report",
            mimeType: "application/json",
          },
          "GET /premium": {
            accepts: { scheme: "exact", price: "$2.00", network: "eip155:84532", payTo: SELLER },
            description: "Premium report",
          },
          "GET /expensive": {
            accepts: { scheme: "exact", price: "$6.00", network: "eip155:84532", payTo: SELLER },
            description: "Above the agent's policy limit",
          },
        },
        resourceServer,
      ),
    );
    app.get("/weather", (_req, res) => {
      res.json({ city: "Lisbon", temp: 21 });
    });
    app.get("/premium", (_req, res) => {
      res.json({ premium: true });
    });
    app.get("/expensive", (_req, res) => {
      res.json({ expensive: true });
    });
    base = await listen(app);
  });

  it("pays the 402 with a PAYMENT-SIGNATURE the official facilitator verifies and settles", async () => {
    const result = await buyer().fetchWithPayment(`${base}/weather?units=metric`);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ city: "Lisbon", temp: 21 });
    expect(result.paid).toBe(true);
    expect(result.amount).toBe("0.01");
    expect(result.payment?.kind).toBe("x402");
    expect(result.settlement).toMatchObject({ success: true, network: "eip155:84532" });
    expect(result.settlement?.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(local.verifications.at(-1)).toEqual({ valid: true, reason: undefined });
    expect(local.settled.at(-1)).toMatchObject({ to: SELLER, value: 10_000n });
    expect(local.settled.at(-1)?.from.toLowerCase()).toBe(spendKey.address.toLowerCase());

    // Agent Bank was asked about the real URL (policy checks the true domain).
    const pay = api.requests.findLast((r) => r.url === "/v1/x402/pay");
    const sent = JSON.parse(pay?.body ?? "{}");
    expect(sent.resource.url).toBe(`${base}/weather?units=metric`);
    expect(sent.requirements).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      payTo: SELLER,
    });
  });

  it("pays (and has policy check) the origin that issued the 402 after a redirect", async () => {
    const redirector = express();
    redirector.get("/go", (_req, res) => {
      res.redirect(302, `${base}/weather`);
    });
    const front = await listen(redirector);
    const result = await buyer().fetchWithPayment(`${front}/go`);
    expect(result.response.status).toBe(200);
    expect(result.paid).toBe(true);
    const pay = api.requests.findLast((r) => r.url === "/v1/x402/pay");
    expect(JSON.parse(pay?.body ?? "{}").resource.url).toBe(`${base}/weather`);
  });

  it("works as a plain fetch (and as a wrapped fetch) exposing the settlement header", async () => {
    const response = await buyer().fetch(`${base}/weather`);
    expect(response.status).toBe(200);
    expect(readPaymentResponse(response)?.success).toBe(true);
    const paidFetch = buyer().wrapFetch(fetch);
    const wrapped = await paidFetch(`${base}/weather`);
    expect(wrapped.status).toBe(200);
    expect(readPaymentResponse(wrapped)?.transaction).toMatch(/^0x/);
  });

  it("refuses prices above maxAmountPerRequest before asking Agent Bank", async () => {
    const before = api.requests.length;
    const error = await buyer("1.00")
      .fetch(`${base}/premium`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(X402Error);
    expect((error as X402Error).reason).toBe("amount_exceeds_limit");
    expect((error as X402Error).code).toBe("policy_denied");
    // Only the deployment facts were read (GET /v1/meta); x402.pay was never called.
    expect(api.requests.slice(before).map((r) => r.url)).toEqual(["/v1/meta"]);
  });

  it("propagates a policy denial from Agent Bank without signing", async () => {
    const settledBefore = local.settled.length;
    const error = await buyer("10.00")
      .fetch(`${base}/expensive`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).decision?.outcome).toBe("deny");
    expect(local.settled.length).toBe(settledBefore);
  });

  it("lets the per-call cap only lower the configured one", async () => {
    const error = await buyer("0.05")
      .fetchWithPayment(`${base}/weather`, undefined, { maxAmountPerRequest: "0.001" })
      .catch((e: unknown) => e);
    expect((error as X402Error).reason).toBe("amount_exceeds_limit");
    const ok = await buyer("0.05").fetchWithPayment(`${base}/weather`, undefined, {
      maxAmountPerRequest: "99",
    });
    expect(ok.paid).toBe(true);
  });
});

describe("our x402 client against a v1 (X-PAYMENT) seller", () => {
  it("answers a v1 challenge with a payload the official v1 facilitator verifies", async () => {
    const local = createLocalFacilitator();
    const requirements: PaymentRequirementsV1 = {
      scheme: "exact",
      network: "base-sepolia" as PaymentRequirementsV1["network"],
      maxAmountRequired: "25000",
      resource: "http://seller.test/v1-report",
      description: "v1 report",
      mimeType: "application/json",
      outputSchema: {},
      payTo: SELLER,
      maxTimeoutSeconds: 120,
      asset: USDC_BASE_SEPOLIA,
      extra: { name: "USDC", version: "2" },
    };
    const app = express();
    app.get("/v1-report", async (req, res) => {
      const header = req.get("x-payment");
      if (!header) {
        res
          .status(402)
          .json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirements] });
        return;
      }
      const payload = decodePaymentSignatureHeader(header) as unknown as PaymentPayload;
      const verify = await local.client.verify(payload, requirements as never);
      if (!verify.isValid) {
        res.status(402).json({ x402Version: 1, error: verify.invalidReason, accepts: [requirements] });
        return;
      }
      const settle = await local.client.settle(payload, requirements as never);
      res.set("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settle)).toString("base64"));
      res.json({ report: "v1 ok" });
    });
    const base = await listen(app);
    const result = await buyer().fetchWithPayment(`${base}/v1-report`);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ report: "v1 ok" });
    expect(result.amount).toBe("0.025");
    expect(result.requirement?.version).toBe(1);
    expect(result.settlement?.success).toBe(true);
    expect(local.verifications.at(-1)).toEqual({ valid: true, reason: undefined });
  });
});

describe("the official x402 client against our paywall", () => {
  it("pays our Express paywall and receives PAYMENT-RESPONSE", async () => {
    const local = createLocalFacilitator();
    const paywall = createPaywall({
      facilitatorUrl: "http://facilitator.test/v1/x402",
      fetch: local.fetch,
      payTo: SELLER,
      price: "$0.02",
      description: "Forecast",
    });
    const app = express();
    app.get("/forecast", expressPaywall(paywall), (_req, res) => {
      res.json({ forecast: "sunny" });
    });
    const base = await listen(app);

    const account = privateKeyToAccount(generatePrivateKey());
    const http = new x402HTTPClient(
      new x402Client().register("eip155:84532", new ExactEvmClientScheme(account)),
    );
    const first = await fetch(`${base}/forecast`);
    expect(first.status).toBe(402);
    const paymentRequired = http.getPaymentRequiredResponse(
      (name) => first.headers.get(name),
      await first.json(),
    );
    expect(paymentRequired.x402Version).toBe(2);
    const payload = await http.createPaymentPayload(paymentRequired);
    const second = await fetch(`${base}/forecast`, { headers: http.encodePaymentSignatureHeader(payload) });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ forecast: "sunny" });
    const settlement = http.getPaymentSettleResponse((name) => second.headers.get(name));
    expect(settlement.success).toBe(true);
    expect(local.settled).toHaveLength(1);
    expect(local.settled[0]?.value).toBe(20_000n);
  });
});
