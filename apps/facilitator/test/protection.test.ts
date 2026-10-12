import { newId, usdc } from "@agentbank/core";
import { routes } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import type { FastifyInstance } from "fastify";
import { getAddress, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type RateLimits } from "../src/app";
import { createChainRuntime } from "../src/chain";
import { ConfigError, DEFAULT_RELAYER_MIN_BALANCE_WEI, loadConfig, parseTrustProxy } from "../src/config";
import { RelayerGasGuard } from "../src/gas";
import {
  buildPayment,
  createHarness,
  DEV_KEYS,
  otherSeller,
  payer,
  relayer,
  seller,
  stranger,
  type Harness,
  type HarnessOptions,
} from "./helpers";

/**
 * Abuse protection: per-client-IP rate limits (verify and settle budgets), a cap on settlements
 * in flight, payee registration (`FACILITATOR_PAYEE_MODE=registered`) and the relayer gas guard.
 */

let db: SqlClient;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

function funded(options: HarnessOptions = {}): Harness {
  const h = createHarness(db, options);
  h.chain.faucet(payer.address, usdc("100"));
  if (options.automine === false) h.chain.mine();
  return h;
}

async function appFor(
  h: Harness,
  extra: { rateLimits?: RateLimits | false; trustProxy?: boolean | number | string } = {},
): Promise<FastifyInstance> {
  return buildApp({ facilitator: h.facilitator, metrics: h.metrics, ...extra });
}

// ------------------------------------------------------------------------------------ rate limits

describe("rate limits (per client IP, separate verify and settle budgets)", () => {
  it("refuses with 429, Retry-After and an x402-shaped body once a budget is spent", async () => {
    const h = funded();
    const app = await appFor(h, { rateLimits: { verifyPerMinute: 3, settlePerMinute: 2 } });
    const { body } = await buildPayment(h);
    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: "POST", url: "/v1/x402/verify", payload: body });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["x-ratelimit-limit"]).toBe("3");
    }
    const limited = await app.inject({ method: "POST", url: "/v1/x402/verify", payload: body });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(routes.x402Verify.response.parse(limited.json())).toMatchObject({
      isValid: false,
      invalidReason: "rate_limited",
    });

    // Settle has its own (stricter) budget, untouched by the verifies.
    const malformed = { x402Version: 2 };
    for (let i = 0; i < 2; i++) {
      expect(
        (await app.inject({ method: "POST", url: "/v1/x402/settle", payload: malformed })).statusCode,
      ).toBe(400);
    }
    const settleLimited = await app.inject({ method: "POST", url: "/v1/x402/settle", payload: body });
    expect(settleLimited.statusCode).toBe(429);
    expect(settleLimited.headers["retry-after"]).toBeDefined();
    expect(routes.x402Settle.response.parse(settleLimited.json())).toMatchObject({
      success: false,
      errorReason: "rate_limited",
      transaction: "",
      network: "eip155:1337",
    });
    expect(h.chain.balanceOf(seller)).toBe(0n); // the limited settle never reached the facilitator

    // Discovery and health are not limited.
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/v1/x402/supported" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    }
    expect(h.metrics.counter("facilitator_rate_limited_total", { route: "/v1/x402/verify" })).toBe(1);
    expect(h.metrics.counter("facilitator_rate_limited_total", { route: "/v1/x402/settle" })).toBe(1);
  });

  it("keeps one budget per client IP", async () => {
    const h = funded();
    const app = await appFor(h, { rateLimits: { verifyPerMinute: 1, settlePerMinute: 1 } });
    const { body } = await buildPayment(h);
    const from = (remoteAddress: string) =>
      app.inject({ method: "POST", url: "/v1/x402/verify", payload: body, remoteAddress });
    expect((await from("198.51.100.1")).statusCode).toBe(200);
    expect((await from("198.51.100.1")).statusCode).toBe(429);
    expect((await from("198.51.100.2")).statusCode).toBe(200);
    expect((await from("2001:db8::1")).statusCode).toBe(200);
    expect((await from("2001:db8::2")).statusCode).toBe(429); // IPv6 is limited per /64
  });

  it("behind the ALB (TRUST_PROXY=1) keys on the address the load balancer saw, not forged entries", async () => {
    const h = funded();
    const app = await appFor(h, { rateLimits: { verifyPerMinute: 1, settlePerMinute: 1 }, trustProxy: 1 });
    const { body } = await buildPayment(h);
    const via = (forwardedFor: string) =>
      app.inject({
        method: "POST",
        url: "/v1/x402/verify",
        payload: body,
        remoteAddress: "10.0.0.5", // the load balancer
        headers: { "x-forwarded-for": forwardedFor },
      });
    expect((await via("203.0.113.7")).statusCode).toBe(200);
    expect((await via("6.6.6.6, 203.0.113.7")).statusCode).toBe(429); // a forged left entry does not help
    expect((await via("203.0.113.8")).statusCode).toBe(200); // another client
  });

  it("without TRUST_PROXY, X-Forwarded-For is ignored", async () => {
    const h = funded();
    const app = await appFor(h, { rateLimits: { verifyPerMinute: 1, settlePerMinute: 1 } });
    const { body } = await buildPayment(h);
    const as = (forwardedFor: string) =>
      app.inject({
        method: "POST",
        url: "/v1/x402/verify",
        payload: body,
        remoteAddress: "198.51.100.9",
        headers: { "x-forwarded-for": forwardedFor },
      });
    expect((await as("203.0.113.1")).statusCode).toBe(200);
    expect((await as("203.0.113.2")).statusCode).toBe(429);
  });

  it("can be switched off", async () => {
    const h = funded();
    const app = await appFor(h, { rateLimits: false });
    const { body } = await buildPayment(h);
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "POST", url: "/v1/x402/verify", payload: body })).statusCode).toBe(
        200,
      );
    }
  });
});

// ------------------------------------------------------------------------------------ in flight

describe("cap on settlements in flight", () => {
  it("refuses settlements beyond the cap with 503 facilitator_busy and Retry-After", async () => {
    const h = funded({ automine: false, options: { maxInflightSettlements: 2 } });
    const [a, b, c] = await Promise.all([buildPayment(h), buildPayment(h), buildPayment(h)]);
    // Two settlements submit and wait for their receipts (nothing is mined yet).
    const first = h.facilitator.settle(a.body);
    const second = h.facilitator.settle(b.body);
    expect(h.facilitator.inflightSettlements).toBe(2);

    const busy = await h.facilitator.settle(c.body);
    expect(busy.status).toBe(503);
    expect(busy.headers).toEqual({ "retry-after": "1" });
    expect(routes.x402Settle.response.parse(busy.body)).toMatchObject({
      success: false,
      errorReason: "facilitator_busy",
    });

    // Over HTTP the Retry-After header reaches the client.
    const app = await appFor(h, { rateLimits: false });
    const viaHttp = await app.inject({ method: "POST", url: "/v1/x402/settle", payload: c.body });
    expect(viaHttp.statusCode).toBe(503);
    expect(viaHttp.headers["retry-after"]).toBe("1");
    expect(viaHttp.json()).toMatchObject({ errorReason: "facilitator_busy" });

    // Keep mining until both in-flight settlements have their receipts: on a slower database
    // (PostgreSQL in CI) a settlement may submit after a single mine() call.
    const drain = setInterval(() => h.chain.mine(), 5);
    try {
      expect((await first).body.success).toBe(true);
      expect((await second).body.success).toBe(true);
    } finally {
      clearInterval(drain);
    }
    expect(h.facilitator.inflightSettlements).toBe(0);

    // Capacity is back: the refused payment settles now.
    const miner = setInterval(() => h.chain.mine(), 5);
    try {
      expect((await h.facilitator.settle(c.body)).body.success).toBe(true);
    } finally {
      clearInterval(miner);
    }
    const emf = h.emf.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(emf.filter((l) => l.reason === "facilitator_busy").map((l) => l.Failures)).toEqual([1, 1]);
  });

  it("releases the slot whatever the outcome", async () => {
    const h = funded({ options: { maxInflightSettlements: 1 } });
    await h.facilitator.settle({ nonsense: true });
    const bad = await buildPayment(h, { signer: stranger, from: payer.address });
    await h.facilitator.settle(bad.body);
    expect(h.facilitator.inflightSettlements).toBe(0);
    const good = await buildPayment(h);
    expect((await h.facilitator.settle(good.body)).body.success).toBe(true);
  });
});

// ------------------------------------------------------------------------------------ payee mode

describe("FACILITATOR_PAYEE_MODE=registered", () => {
  let registeredAccountId: string;
  const unregistered: Address = getAddress("0x00000000000000000000000000000000ab0ba5e1"); // an account, not an x402 payee
  const elsewhere: Address = otherSeller; // a payee, but on Base Sepolia

  async function account(address: Address, chainId: number, payee: boolean): Promise<string> {
    const orgId = newId("org");
    const agentId = newId("agent");
    const accountId = newId("account");
    await db.query(
      "INSERT INTO org (id, legal_name, kind, country, contact_email, owner_address) VALUES ($1, 'Seller', 'company', 'US', 'ops@seller.example', $2)",
      [orgId, stranger.address],
    );
    await db.query("INSERT INTO agent (id, org_id, name) VALUES ($1, $2, 'seller-agent')", [agentId, orgId]);
    await db.query(
      "INSERT INTO account (id, org_id, agent_id, role, chain_id, address, owner_address, salt) VALUES ($1, $2, $3, 'agent', $4, $5, $6, '1')",
      [accountId, orgId, agentId, chainId, address, stranger.address],
    );
    if (payee)
      await db.query("INSERT INTO x402_payee (account_id, domains) VALUES ($1, $2)", [
        accountId,
        ["seller.example"],
      ]);
    return accountId;
  }

  beforeAll(async () => {
    registeredAccountId = await account(seller, 1337, true);
    await account(unregistered, 1337, false);
    await account(elsewhere, 84532, true);
  });

  it("verifies and settles for a registered payee and records its account", async () => {
    const h = funded({ options: { payeeMode: "registered" } });
    const built = await buildPayment(h, { payTo: seller });
    expect((await h.facilitator.verify(built.body)).body).toEqual({ isValid: true, payer: payer.address });
    const out = await h.facilitator.settle(built.body);
    expect(out.body.success).toBe(true);
    const { rows } = await db.query<{ payee_account_id: string }>(
      "SELECT payee_account_id FROM x402_authorization WHERE tx_hash = $1",
      [out.body.transaction],
    );
    expect(rows).toEqual([{ payee_account_id: registeredAccountId }]);
  });

  it.each([
    ["an address that is no Agent Bank account", stranger.address],
    ["an Agent Bank account that is not an x402 payee", unregistered],
    ["a payee registered on another chain", elsewhere],
  ])("refuses %s with payee_not_registered (verify and settle)", async (_name, payTo) => {
    const h = funded({ options: { payeeMode: "registered" } });
    const built = await buildPayment(h, { payTo });
    expect((await h.facilitator.verify(built.body)).body).toMatchObject({
      isValid: false,
      invalidReason: "payee_not_registered",
      payer: payer.address,
    });
    const settled = await h.facilitator.settle(built.body);
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({
      success: false,
      errorReason: "payee_not_registered",
      transaction: "",
    });
    const { rows } = await db.query("SELECT 1 FROM x402_authorization WHERE nonce = $1", [
      built.authorization.nonce,
    ]);
    expect(rows).toHaveLength(0);
    expect(h.chain.balanceOf(payTo)).toBe(0n);
  });

  it("`any` mode serves unregistered payees", async () => {
    const h = funded();
    const built = await buildPayment(h, { payTo: unregistered });
    expect((await h.facilitator.verify(built.body)).body.isValid).toBe(true);
  });

  it("is required when APP_ENV=production and defaults to any elsewhere", () => {
    const base = { DATABASE_URL: "pglite://memory" };
    expect(loadConfig(base).payeeMode).toBe("any");
    expect(loadConfig({ ...base, APP_ENV: "sandbox" }).payeeMode).toBe("any");
    expect(loadConfig({ ...base, FACILITATOR_PAYEE_MODE: "registered" }).payeeMode).toBe("registered");
    expect(loadConfig({ ...base, APP_ENV: "production" }).payeeMode).toBe("registered");
    expect(() => loadConfig({ ...base, APP_ENV: "production", FACILITATOR_PAYEE_MODE: "any" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, APP_ENV: "production", FACILITATOR_PAYEE_MODE: "any" })).toThrow(
      /FACILITATOR_PAYEE_MODE: must be registered when APP_ENV=production/,
    );
  });
});

// ------------------------------------------------------------------------------------ gas guard

describe("relayer gas guard", () => {
  function guarded(state: { balance: bigint; fail?: boolean; reads: number; now: number }, min = 1_000n) {
    const guard = new RelayerGasGuard({
      address: relayer.address,
      minBalanceWei: min,
      balanceOf: async () => {
        state.reads += 1;
        if (state.fail) throw new Error("rpc down");
        return state.balance;
      },
      now: () => state.now,
    });
    return guard;
  }

  it("caches the balance for 30 s, shares concurrent lookups and never caches failures", async () => {
    const state = { balance: 5_000n, reads: 0, now: 0, fail: false };
    const guard = guarded(state);
    expect(await Promise.all([guard.check(), guard.check(), guard.check()])).toEqual([
      { ok: true, balanceWei: 5_000n },
      { ok: true, balanceWei: 5_000n },
      { ok: true, balanceWei: 5_000n },
    ]);
    expect(state.reads).toBe(1);
    state.balance = 10n;
    state.now = 29_999;
    expect((await guard.check()).ok).toBe(true); // still the cached reading
    state.now = 30_000;
    expect(await guard.check()).toEqual({ ok: false, balanceWei: 10n });
    expect(state.reads).toBe(2);
    state.now = 60_000;
    state.fail = true;
    await expect(guard.check()).rejects.toThrow("rpc down");
    state.fail = false;
    expect(await guard.check()).toEqual({ ok: false, balanceWei: 10n });
    expect(state.reads).toBe(4);
  });

  it("refuses to settle (503 facilitator_unavailable) and to verify while the relayer is low on gas", async () => {
    const state = { balance: 999n, reads: 0, now: 0 };
    const h = funded({ relayerGas: guarded(state) });
    const built = await buildPayment(h);
    const settle = await h.facilitator.settle(built.body);
    expect(settle.status).toBe(503);
    expect(settle.body).toMatchObject({ success: false, errorReason: "facilitator_unavailable" });
    expect(settle.body.errorMessage).toMatch(/low on gas/);
    const verify = await h.facilitator.verify(built.body);
    expect(verify.status).toBe(503);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "facilitator_unavailable" });
    const { rows } = await db.query("SELECT 1 FROM x402_authorization WHERE nonce = $1", [
      built.authorization.nonce,
    ]);
    expect(rows).toHaveLength(0);
    expect(h.chain.balanceOf(seller)).toBe(0n);

    // Topped up: refused until the cached reading expires, then the payment settles.
    state.balance = 10_000n;
    expect((await h.facilitator.settle(built.body)).status).toBe(503);
    state.now = 30_000;
    expect((await h.facilitator.settle(built.body)).body.success).toBe(true);
  });

  it("still answers an already-settled authorization (no gas needed for a replay)", async () => {
    const state = { balance: 10_000n, reads: 0, now: 0 };
    const h = funded({ relayerGas: guarded(state) });
    const built = await buildPayment(h);
    const first = await h.facilitator.settle(built.body);
    expect(first.body.success).toBe(true);
    state.balance = 0n;
    state.now = 60_000;
    expect(await h.facilitator.settle(built.body)).toEqual(first);
    const fresh = await buildPayment(h);
    expect((await h.facilitator.settle(fresh.body)).body.errorReason).toBe("facilitator_unavailable");
  });

  it("fails closed when the balance cannot be read", async () => {
    const state = { balance: 10_000n, reads: 0, now: 0, fail: true };
    const h = funded({ relayerGas: guarded(state) });
    const { body } = await buildPayment(h);
    const out = await h.facilitator.settle(body);
    expect(out.status).toBe(502);
    expect(out.body.errorReason).toBe("chain_unavailable");
  });

  it("/healthz reports the relayer's balance and degrades (200) when it is low or unreadable", async () => {
    const state = { balance: 5_000n, reads: 0, now: 0, fail: false };
    const h = funded({ relayerGas: guarded(state) });
    const app = await appFor(h);
    const healthy = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toEqual({
      status: "ok",
      checks: expect.objectContaining({
        relayer: relayer.address,
        relayer_balance_wei: "5000",
        relayer_min_balance_wei: "1000",
        relayer_gas: "ok",
      }),
    });
    state.balance = 1n;
    state.now = 30_000;
    const low = await app.inject({ method: "GET", url: "/healthz" });
    expect(low.statusCode).toBe(200);
    expect(low.json()).toMatchObject({
      status: "degraded",
      checks: { relayer_gas: "low", relayer_balance_wei: "1" },
    });
    state.fail = true;
    state.now = 60_000;
    const unknown = await app.inject({ method: "GET", url: "/healthz" });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ status: "degraded", checks: { relayer_gas: "unavailable" } });
  });

  it("is configured from RELAYER_MIN_BALANCE_WEI (default 0.001 ETH) and reads the relayer's ETH on EVM chains", () => {
    const evm = {
      DATABASE_URL: "postgres://agentbank@db/agentbank",
      X402_NETWORK: "base-sepolia",
      CHAIN_RPC_URL: "http://127.0.0.1:1",
      FACILITATOR_RELAYER_KEY: DEV_KEYS[4] as string,
    };
    expect(loadConfig(evm).relayerMinBalanceWei).toBe(DEFAULT_RELAYER_MIN_BALANCE_WEI);
    expect(DEFAULT_RELAYER_MIN_BALANCE_WEI).toBe(10n ** 15n);
    expect(loadConfig({ ...evm, RELAYER_MIN_BALANCE_WEI: "0" }).relayerMinBalanceWei).toBe(0n);
    expect(loadConfig({ ...evm, RELAYER_MIN_BALANCE_WEI: "250000000000000" }).relayerMinBalanceWei).toBe(
      250_000_000_000_000n,
    );
    expect(() => loadConfig({ ...evm, RELAYER_MIN_BALANCE_WEI: "0.5" })).toThrow(/RELAYER_MIN_BALANCE_WEI/);
    expect(createChainRuntime(loadConfig(evm)).relayerBalance).toBeTypeOf("function");
    expect(
      createChainRuntime(loadConfig({ DATABASE_URL: "pglite://memory" })).relayerBalance,
    ).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------ config

describe("protection settings", () => {
  it("parses limits, the in-flight cap and TRUST_PROXY", () => {
    const base = { DATABASE_URL: "pglite://memory" };
    expect(loadConfig(base)).toMatchObject({
      rateLimit: { verifyPerMinute: 300, settlePerMinute: 60 },
      maxInflightSettlements: 16,
      trustProxy: false,
    });
    expect(
      loadConfig({
        ...base,
        RATE_LIMIT_VERIFY_PER_MINUTE: "1000",
        RATE_LIMIT_SETTLE_PER_MINUTE: "30",
        MAX_INFLIGHT_SETTLEMENTS: "4",
        TRUST_PROXY: "1",
      }),
    ).toMatchObject({
      rateLimit: { verifyPerMinute: 1000, settlePerMinute: 30 },
      maxInflightSettlements: 4,
      trustProxy: 1,
    });
    expect(() => loadConfig({ ...base, RATE_LIMIT_SETTLE_PER_MINUTE: "0" })).toThrow(
      /RATE_LIMIT_SETTLE_PER_MINUTE/,
    );
    expect(() => loadConfig({ ...base, MAX_INFLIGHT_SETTLEMENTS: "0" })).toThrow(/MAX_INFLIGHT_SETTLEMENTS/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "please" })).toThrow(/TRUST_PROXY/);
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["0", false],
    ["true", true],
    ["2", 2],
    ["10.0.0.0/8, 192.168.1.1", "10.0.0.0/8,192.168.1.1"],
    ["fd00::/8", "fd00::/8"],
    ["nope", undefined],
  ])("TRUST_PROXY=%s → %s", (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });
});
