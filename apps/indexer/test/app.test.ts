import { signInternalRequest } from "@agentbank/core";
import { afterEach, describe, expect, it } from "vitest";
import { SimBank, usd } from "../../../packages/reconciliation/test/support/sim-bank";
import { BALANCE_CHECK_PATH, buildApp, ConfigError, loadConfig } from "../src";

const SECRET = "app-test-internal-secret-0123456789";

describe("HTTP app", () => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  it("serves health, metrics and an HMAC-protected on-demand balance check", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    bank.faucet(a.address, usd(5));
    const app = buildApp({
      indexer: bank.indexer,
      secret: SECRET,
      now: () => Math.floor(bank.now().getTime() / 1000),
    });
    const before = await app.inject({ method: "GET", url: "/healthz" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ status: "ok", chain_id: bank.chain.chainId, last_tick_at: null });
    await bank.sync();
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toMatchObject({ status: "ok", cursor_lag_blocks: 0 });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("indexer_block_lag 0");
    expect(metrics.body).toContain("indexer_events_pushed_total");

    const unsigned = await app.inject({ method: "POST", url: BALANCE_CHECK_PATH, payload: "" });
    expect(unsigned.statusCode).toBe(401);
    const t = Math.floor(bank.now().getTime() / 1000);
    const signed = await app.inject({
      method: "POST",
      url: BALANCE_CHECK_PATH,
      headers: { authorization: signInternalRequest(SECRET, "POST", BALANCE_CHECK_PATH, "", t) },
      payload: "",
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ mismatches: [] });
    expect(signed.json().checked).toBeGreaterThan(0);
    await app.close();
  });
});

describe("configuration", () => {
  const base = {
    DATABASE_URL: "pglite://memory",
    API_INTERNAL_URL: "http://api.internal:8080/",
    INTERNAL_API_SHARED_SECRET: "x".repeat(32),
    CHAIN_RPC_URL: "https://sepolia.base.org",
  };

  it("applies defaults and derives the chain from CHAIN_ID", () => {
    const config = loadConfig({
      ...base,
      CHAIN_ID: "84532",
      METRICS_NAMESPACE: "AgentBank/Indexer",
      RECONCILIATION_METRICS_NS: "AgentBank/Reconciliation",
    });
    expect(config).toMatchObject({
      port: 8082,
      host: "0.0.0.0",
      windowBlocks: 20,
      apiInternalUrl: "http://api.internal:8080",
      metricsNamespace: "AgentBank/Indexer",
      reconciliationMetricsNamespace: "AgentBank/Reconciliation",
      balanceCheckContracts: "at_least",
    });
    expect(config.chain.name).toBe("base-sepolia");
    expect(loadConfig({ ...base, AGENTBANK_CHAIN: "simulated", CHAIN_RPC_URL: "" }).chain.id).toBe(1337);
    expect(loadConfig({ ...base, RECONCILIATION_WINDOW: "30", START_BLOCK: "123" })).toMatchObject({
      windowBlocks: 30,
      startBlock: 123n,
    });
  });

  it("fails fast on missing secrets, mainnets and unsafe production settings", () => {
    expect(() => loadConfig({ ...base, INTERNAL_API_SHARED_SECRET: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CHAIN_RPC_URL: "" })).toThrow(/CHAIN_RPC_URL/);
    expect(() => loadConfig({ ...base, CHAIN_ID: "8453" })).toThrow(/CHAIN_ID/);
    expect(() => loadConfig({ ...base, AGENTBANK_CHAIN: "anvil", CHAIN_ID: "84532" })).toThrow(
      /does not match/,
    );
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AGENTBANK_CHAIN: "simulated" })).toThrow(
      /simulated/,
    );
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", INTERNAL_API_SHARED_SECRET: "y".repeat(20) }),
    ).toThrow(/32 characters/);
    const { DATABASE_URL: _omit, ...noDb } = base;
    expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
  });
});
