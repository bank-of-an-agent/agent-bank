import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBankError } from "../src";
import { AgentClient, X402Error, type AgentX402Options, type FetchLike } from "../src";
import { createPaywall, withPaywall } from "../src/x402-server";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";
import { createLocalFacilitator, USDC_BASE_SEPOLIA, USDC_SIMULATED } from "./helpers/x402-facilitator";

/**
 * The local sandbox runs on the simulated chain (1337) and its sellers ask
 * for payment on `eip155:1337`. An `AgentClient` without an explicit
 * `x402.network` must pick the deployment's network and USDC up from
 * `GET /v1/meta` instead of assuming Base Sepolia.
 */

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SELLER = "0x7777777777777777777777777777777777777777";
const sessionKey = privateKeyToAccount(generatePrivateKey());
const spendKey = privateKeyToAccount(generatePrivateKey());

const apis: FakeApi[] = [];

afterEach(async () => {
  await Promise.all(apis.splice(0).map((a) => a.close()));
});

async function sandbox(chainId: number) {
  const api = await startFakeApi({
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    spendAddress: spendKey.address,
    ownerAuthorizationChainId: chainId,
  });
  apis.push(api);
  return api;
}

/** A seller on the simulated chain, served in-process as a Web handler. */
function sellerOn1337() {
  const local = createLocalFacilitator();
  const paywall = createPaywall({
    facilitatorUrl: "http://facilitator.test/v1/x402",
    fetch: local.fetch,
    payTo: SELLER,
    price: "0.05",
    network: "eip155:1337",
  });
  const handler = withPaywall(paywall, async () => Response.json({ sandbox: true }));
  const fetch: FetchLike = (input, init) => handler(new Request(input, init));
  return { local, fetch };
}

function agent(api: FakeApi, x402: AgentX402Options): AgentClient {
  return new AgentClient({
    baseUrl: api.url,
    accountId: ACCT,
    session: { id: SES, signer: sessionKey },
    spendKey,
    validateResponses: true,
    x402,
  });
}

describe("x402 network resolution from GET /v1/meta", () => {
  it("pays a seller on eip155:1337 when the deployment's meta says so (no x402.network configured)", async () => {
    const api = await sandbox(1337);
    const seller = sellerOn1337();
    const client = agent(api, { fetch: seller.fetch });
    expect(await client.x402Settings()).toMatchObject({
      network: "eip155:1337",
      chainId: 1337,
      usdc: USDC_SIMULATED,
      usdcDomain: { name: "USDC", version: "2" },
    });

    const first = await client.fetchWithPayment("http://seller.test/data");
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toEqual({ sandbox: true });
    expect(first.paid).toBe(true);
    expect(first.settlement).toMatchObject({ success: true, network: "eip155:1337" });
    expect(seller.local.settled.at(-1)?.from.toLowerCase()).toBe(spendKey.address.toLowerCase());

    const second = await client.fetch("http://seller.test/data");
    expect(second.status).toBe(200);
    const pays = api.requests.filter((r) => r.url === "/v1/x402/pay");
    expect(pays.map((r) => JSON.parse(r.body).requirements.network)).toEqual(["eip155:1337", "eip155:1337"]);
    expect(api.requests.filter((r) => r.url === "/v1/meta")).toHaveLength(1);
  });

  it("does not read /v1/meta for free resources", async () => {
    const api = await sandbox(1337);
    const client = agent(api, { fetch: async () => Response.json({ free: true }) });
    const result = await client.fetchWithPayment("http://seller.test/free");
    expect(result.paid).toBe(false);
    expect(api.requests).toHaveLength(0);
  });

  it("respects an explicit x402.network (and never asks /v1/meta)", async () => {
    const api = await sandbox(1337);
    const seller = sellerOn1337();
    const client = agent(api, { network: "eip155:84532", fetch: seller.fetch });
    expect(await client.x402Settings()).toMatchObject({ network: "eip155:84532", usdc: USDC_BASE_SEPOLIA });
    const error = await client.fetch("http://seller.test/data").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(X402Error);
    expect((error as X402Error).reason).toBe("no_acceptable_requirement");
    expect(api.requests.some((r) => r.url === "/v1/meta")).toBe(false);
    expect(api.requests.some((r) => r.url === "/v1/x402/pay")).toBe(false);
  });

  it("refuses a mainnet network served by /v1/meta before paying", async () => {
    const api = await sandbox(8453);
    const seller = sellerOn1337();
    const error = await agent(api, { fetch: seller.fetch })
      .fetch("http://seller.test/data")
      .catch((e: unknown) => e);
    expect((error as AgentBankError).code).toBe("mainnet_locked");
    expect(api.requests.some((r) => r.url === "/v1/x402/pay")).toBe(false);
  });

  it("takes USDC from meta for an explicit network without a registered USDC (Anvil), or asks for x402.usdc", async () => {
    const anvil = await sandbox(31337);
    const resolved = await agent(anvil, { network: "eip155:31337" }).x402Settings();
    expect(resolved).toMatchObject({ network: "eip155:31337", chainId: 31337, usdc: USDC_BASE_SEPOLIA });

    const simulated = await sandbox(1337);
    await expect(agent(simulated, { network: "eip155:31337" }).x402Settings()).rejects.toThrow(/x402\.usdc/);
    const pinned = await agent(simulated, {
      network: "eip155:31337",
      usdc: "0x1111111111111111111111111111111111111111",
    }).x402Settings();
    expect(pinned.usdc).toBe("0x1111111111111111111111111111111111111111");
  });

  it("validates explicit settings when the client is constructed", async () => {
    const api = await sandbox(1337);
    expect(() => agent(api, { network: "eip155:8453" })).toThrow(/mainnet/i);
    expect(() => agent(api, { network: "base-sepolia" })).toThrow(/CAIP-2/);
    expect(() => agent(api, { usdc: "usdc" })).toThrow(/address/);
    expect(() => agent(api, { maxAmountPerRequest: "lots" })).toThrow();
  });
});
