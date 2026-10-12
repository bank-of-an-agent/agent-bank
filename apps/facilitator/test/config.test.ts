import { Writable } from "node:stream";
import { CHAINS, getAsset, usdc } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChainRuntime, settlementAsset } from "../src/chain";
import { ConfigError, loadConfig } from "../src/config";
import { Facilitator } from "../src/facilitator";
import { createLogger, REDACTED } from "../src/logger";
import { Metrics } from "../src/metrics";
import { simulatedReceipts } from "../src/receipts";
import { SandboxScreening } from "../src/screening";
import { buildPayment, createHarness, DEV_KEYS, payer, relayer } from "./helpers";

const RELAYER_KEY = DEV_KEYS[4] as string;
const BASE = { DATABASE_URL: "postgres://agentbank@db.internal/agentbank" };

function configError(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a configuration error");
}

describe("loadConfig", () => {
  it("defaults to the in-memory simulator on 0.0.0.0:8083 for development", () => {
    const config = loadConfig({ DATABASE_URL: "pglite://memory" });
    expect(config).toMatchObject({
      env: "development",
      host: "0.0.0.0",
      port: 8083,
      chain: CHAINS.simulated,
      relayer: undefined,
      migrateOnStart: true,
      settleBeforeServeAbove: 1_000_000n,
      maxSettlement: undefined,
      receiptTimeoutMs: 20_000,
      staleSweepSeconds: 60,
      screening: { provider: "sandbox", denylist: [] },
    });
  });

  it("builds the Base Sepolia configuration the infrastructure provides", () => {
    const config = loadConfig({
      ...BASE,
      NODE_ENV: "production",
      APP_ENV: "sandbox",
      CHAIN_ID: "84532",
      X402_NETWORK: "base-sepolia",
      CHAIN_RPC_URL: "https://base-sepolia.example/rpc",
      FACILITATOR_RELAYER_KEY: RELAYER_KEY,
      METRICS_NAMESPACE: "AgentBank/Facilitator",
      PUBLIC_BASE_URL: "https://x402.sandbox.agentbank.example/",
      MAX_SETTLEMENT: "100.00",
      SETTLE_BEFORE_SERVE_ABOVE: "1.00",
      SCREENING_DENYLIST: "0x000000000000000000000000000000000000dEaD",
      PORT: "8083",
    });
    expect(config.chain).toBe(CHAINS["base-sepolia"]);
    expect(config.rpcUrl).toBe("https://base-sepolia.example/rpc");
    expect(config.relayer?.address).toBe(relayer.address);
    expect(config.maxSettlement).toBe(usdc("100"));
    expect(config.migrateOnStart).toBe(false);
    expect(config.publicBaseUrl).toBe("https://x402.sandbox.agentbank.example");
    expect(config.metricsNamespace).toBe("AgentBank/Facilitator");
    expect(config.screening.denylist).toEqual(["0x000000000000000000000000000000000000dEaD"]);
  });

  it.each([
    ["CHAIN_ID=8453 (Base mainnet)", { CHAIN_ID: "8453" }],
    ["CHAIN_ID=1 (Ethereum mainnet)", { CHAIN_ID: "1" }],
    ["X402_NETWORK=eip155:8453", { X402_NETWORK: "eip155:8453" }],
  ])("refuses to start with a mainnet chain: %s", (_name, env) => {
    expect(
      configError({
        ...BASE,
        FACILITATOR_RELAYER_KEY: RELAYER_KEY,
        CHAIN_RPC_URL: "https://rpc.example",
        ...env,
      }),
    ).toMatch(/mainnet/);
  });

  it("refuses unknown chains and a CHAIN_ID that contradicts the network", () => {
    expect(configError({ ...BASE, X402_NETWORK: "eip155:10" })).toMatch(/mainnet/);
    expect(configError({ ...BASE, X402_NETWORK: "eip155:999" })).toMatch(/not supported/);
    expect(
      configError({
        ...BASE,
        X402_NETWORK: "base-sepolia",
        CHAIN_ID: "31337",
        FACILITATOR_RELAYER_KEY: RELAYER_KEY,
        CHAIN_RPC_URL: "https://rpc.example",
      }),
    ).toMatch(/does not match/);
    expect(configError({ ...BASE, X402_NETWORK: "base" })).toMatch(/X402_NETWORK/);
  });

  it("requires the relayer key and an RPC URL on Base Sepolia", () => {
    const message = configError({ ...BASE, X402_NETWORK: "base-sepolia" });
    expect(message).toMatch(/FACILITATOR_RELAYER_KEY: required/);
    expect(message).toMatch(/CHAIN_RPC_URL: required/);
    expect(configError({ ...BASE, X402_NETWORK: "anvil" })).toMatch(/FACILITATOR_RELAYER_KEY: required/);
  });

  it("production serves Base Sepolia only, on PostgreSQL", () => {
    expect(configError({ NODE_ENV: "production", DATABASE_URL: "pglite://memory" })).toMatch(
      /Base Sepolia only/,
    );
    expect(configError({ NODE_ENV: "production", DATABASE_URL: "pglite://memory" })).toMatch(/PostgreSQL/);
    expect(
      configError({
        ...BASE,
        NODE_ENV: "production",
        X402_NETWORK: "anvil",
        FACILITATOR_RELAYER_KEY: RELAYER_KEY,
      }),
    ).toMatch(/Base Sepolia only/);
  });

  it("never repeats the relayer key, and the configuration object does not hold it", () => {
    const malformed = `${RELAYER_KEY.slice(0, 60)}zz`;
    const message = configError({
      ...BASE,
      X402_NETWORK: "base-sepolia",
      CHAIN_RPC_URL: "https://rpc.example",
      FACILITATOR_RELAYER_KEY: malformed,
    });
    expect(message).toMatch(/FACILITATOR_RELAYER_KEY: must be a 0x-prefixed 32-byte hex private key/);
    expect(message).not.toContain(malformed);
    expect(message).not.toContain(RELAYER_KEY.slice(2, 20));

    const config = loadConfig({
      ...BASE,
      X402_NETWORK: "base-sepolia",
      CHAIN_RPC_URL: "https://rpc.example",
      FACILITATOR_RELAYER_KEY: RELAYER_KEY,
    });
    const serialized = JSON.stringify(config, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialized).not.toContain(RELAYER_KEY.slice(2));
    expect(serialized).toContain(relayer.address);
  });

  it("validates amounts and the screening denylist", () => {
    expect(configError({ ...BASE, MAX_SETTLEMENT: "1.0000001" })).toMatch(/MAX_SETTLEMENT/);
    expect(configError({ ...BASE, MAX_SETTLEMENT: "0" })).toMatch(
      /MAX_SETTLEMENT: must be greater than zero/,
    );
    expect(configError({ ...BASE, SCREENING_DENYLIST: "0x1234,nope" })).toMatch(
      /SCREENING_DENYLIST: not addresses: 0x1234, nope/,
    );
    expect(loadConfig({ ...BASE, SETTLE_BEFORE_SERVE_ABOVE: "2.50" }).settleBeforeServeAbove).toBe(
      usdc("2.50"),
    );
  });
});

describe("chain runtime", () => {
  it("serves the simulator in development", () => {
    const runtime = createChainRuntime(loadConfig({ DATABASE_URL: "pglite://memory" }));
    expect(runtime.gateway.chainId).toBe(1337);
    expect(runtime.asset).toBe(getAsset(1337, "USDC"));
    expect(runtime.simulated).toBeDefined();
  });

  it("builds an EVM gateway for Base Sepolia with the registered USDC", () => {
    const runtime = createChainRuntime(
      loadConfig({
        ...BASE,
        X402_NETWORK: "base-sepolia",
        CHAIN_RPC_URL: "http://127.0.0.1:1",
        FACILITATOR_RELAYER_KEY: RELAYER_KEY,
      }),
    );
    expect(runtime.gateway.chainId).toBe(84532);
    expect(runtime.asset.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(runtime.rpcChainId).toBeTypeOf("function");
  });

  it("registers USDC for Anvil (fork or MockUSDC) and refuses a mismatch elsewhere", () => {
    const mock = "0x00000000000000000000000000000000000Dead1";
    const anvil = createChainRuntime(
      loadConfig({
        ...BASE,
        X402_NETWORK: "anvil",
        USDC_ADDRESS: mock,
        FACILITATOR_RELAYER_KEY: RELAYER_KEY,
      }),
    );
    expect(anvil.asset).toMatchObject({
      chainId: 31337,
      address: getAddress(mock.toLowerCase()),
      eip712: { name: "USDC", version: "2" },
    });
    expect(() => settlementAsset(84532, mock)).toThrow(/USDC on chain 84532/);
    expect(() => settlementAsset(8453, mock)).toThrow(/mainnet/);
  });
});

describe("logs never carry secrets or signatures", () => {
  let db: SqlClient;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  function capture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    return { lines, logger: createLogger("debug", stream) };
  }

  it("redacts keys, signatures and credentials at any depth", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        relayerKey: RELAYER_KEY,
        FACILITATOR_RELAYER_KEY: RELAYER_KEY,
        payload: { signature: "0xabc", authorization: "Bearer x" },
        nested: { deeper: { privateKey: RELAYER_KEY } },
      },
      "test",
    );
    const line = lines.join("");
    expect(line).not.toContain(RELAYER_KEY.slice(2));
    expect(line).not.toContain("0xabc");
    expect(line).toContain(REDACTED);
  });

  it("a verify and settle round logs the payment without its signature or the relayer key", async () => {
    const { lines, logger } = capture();
    const h = createHarness(db);
    h.chain.faucet(payer.address, usdc("10"));
    const facilitator = new Facilitator({
      db,
      gateway: h.chain.gateway,
      receipts: simulatedReceipts(h.chain),
      screening: new SandboxScreening(),
      clock: h.clock,
      relayer,
      metrics: new Metrics(),
      logger,
      options: { chain: CHAINS.simulated, asset: h.asset },
    });
    const built = await buildPayment(h);
    await facilitator.verify(built.body);
    const out = await facilitator.settle(built.body);
    expect(out.body.success).toBe(true);
    const text = lines.join("");
    expect(text).toContain("x402.settle");
    expect(text).toContain(built.authorization.nonce);
    expect(text).toContain(out.body.transaction);
    expect(text).not.toContain(built.signature.slice(2, 40));
    expect(text).not.toContain(RELAYER_KEY.slice(2));
  });
});

describe("EMF metrics", () => {
  it("writes CloudWatch EMF lines only when a namespace is set", () => {
    const lines: string[] = [];
    const quiet = new Metrics({ emfSink: (l) => lines.push(l) });
    quiet.observeVerify("valid", undefined, 0.01);
    expect(lines).toHaveLength(0);

    const metrics = new Metrics({
      emfNamespace: "AgentBank/Facilitator",
      emfSink: (l) => lines.push(l),
      now: () => 1_700_000_000_000,
    });
    metrics.observeVerify("invalid", "insufficient_funds", 0.012);
    metrics.observeSettle("settled", undefined, 1.5);
    metrics.observeSettle("failed", "invalid_transaction_state", 2);
    metrics.observeSettle("error", "chain_unavailable", 0.1);
    const docs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(docs[0]).toEqual({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [
          {
            Namespace: "AgentBank/Facilitator",
            Dimensions: [[]],
            Metrics: [
              { Name: "Verifications", Unit: "Count" },
              { Name: "Failures", Unit: "Count" },
            ],
          },
        ],
      },
      route: "verify",
      outcome: "invalid",
      reason: "insufficient_funds",
      latencyMs: 12,
      Verifications: 1,
      Failures: 0,
    });
    expect(docs.slice(1).map((d) => [d.outcome, d.Settlements, d.Failures])).toEqual([
      ["settled", 1, 0],
      ["failed", 0, 1],
      ["error", 0, 1],
    ]);
    expect(
      (
        docs[1]?._aws as { CloudWatchMetrics: { Metrics: { Name: string }[] }[] }
      ).CloudWatchMetrics[0]?.Metrics.map((m) => m.Name),
    ).toEqual(["Settlements", "Failures"]);
    expect(metrics.render()).toContain(
      'facilitator_failures_total{route="settle",reason="chain_unavailable"} 1',
    );
  });
});
