import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { createLogger, REDACTED } from "../src/logger";
import { decimal, usdc } from "../src/serializers";
import { call, createHarness, type Harness } from "./support/harness";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "pglite://memory",
  COSIGNER_URL: "http://127.0.0.1:8081",
  COSIGNER_SHARED_SECRET: "test-shared-secret-0123456789abcdef",
};

describe("configuration", () => {
  it("refuses mainnets in every form", () => {
    expect(() => loadConfig({ ...base, AGENTBANK_CHAIN: "base" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CHAIN_ID: "8453" })).toThrow(/mainnet|Mainnet/);
    expect(() => loadConfig({ ...base, CHAIN_ID: "1" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CHAIN_ID: "84532", AGENTBANK_CHAIN: "anvil" })).toThrow(
      /does not match/,
    );
  });

  it("derives the chain from the infra's CHAIN_ID", () => {
    const config = loadConfig({
      ...base,
      CHAIN_ID: "84532",
      CHAIN_RPC_URL: "https://sepolia.base.org",
      REVENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
    });
    expect(config.chain.name).toBe("base-sepolia");
    expect(config.rpcUrl).toBe("https://sepolia.base.org");
  });

  it("fails fast on unsafe production settings", () => {
    const prod = { ...base, NODE_ENV: "production" };
    expect(() => loadConfig({ ...prod, AGENTBANK_CHAIN: "simulated" })).toThrow(/simulated chain/);
    expect(() =>
      loadConfig({
        ...prod,
        AGENTBANK_CHAIN: "base-sepolia",
        CHAIN_RPC_URL: "https://x.example",
        REVENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
        COSIGNER_SHARED_SECRET: "dev-only-shared-secret-change-me",
      }),
    ).toThrow(/development secret/);
    expect(() => loadConfig({ ...base, AGENTBANK_CHAIN: "base-sepolia" })).toThrow(
      /CHAIN_RPC_URL|REVENUE_ADDRESS/,
    );
    expect(() => loadConfig({ ...base, STAFF_TOKEN: "short" })).toThrow(/STAFF_TOKEN/);
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("treats a missing COSIGNER_URL as fail-closed rather than an error", () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite://memory" });
    expect(config.cosigner.url).toBeUndefined();
    expect(config.features).toEqual({ escrow: true, streams: true, treasurySweep: false });
    expect(config.allowOpenSignup).toBe(false);
  });

  it("keeps the in-process co-signer and the faucet key to local chains", () => {
    const local = loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "pglite://memory",
      AGENTBANK_CHAIN: "simulated",
      COSIGNER_MODE: "inprocess",
    });
    expect(local.cosigner.mode).toBe("inprocess");
    expect(local.runWorkerInProcess).toBe(true);
    expect(local.migrateOnStart).toBe(true);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://x/y",
        AGENTBANK_CHAIN: "anvil",
        COSIGNER_MODE: "inprocess",
        REVENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
        STAFF_TOKEN: "s".repeat(40),
      }),
    ).toThrow(/inprocess is for local development only/);
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        DATABASE_URL: "pglite://memory",
        AGENTBANK_CHAIN: "base-sepolia",
        CHAIN_RPC_URL: "https://sepolia.base.org",
        REVENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
        COSIGNER_MODE: "inprocess",
      }),
    ).toThrow(/simulated chain or Anvil/);
    expect(() =>
      loadConfig({ ...base, AGENTBANK_CHAIN: "simulated", SANDBOX_FAUCET_KEY: `0x${"11".repeat(32)}` }),
    ).toThrow(/Anvil only/);
    const postgres = loadConfig({
      ...base,
      DATABASE_URL: "postgres://x/y",
      AGENTBANK_CHAIN: "anvil",
      REVENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
    });
    expect(postgres.migrateOnStart).toBe(false);
    expect(postgres.runWorkerInProcess).toBe(false);
    expect(postgres.facilitatorUrl).toBe("http://localhost:8083/v1/x402");
    expect(loadConfig({ ...base, API_RELAYER_KEY: `0x${"22".repeat(32)}` }).relayerKey).toBe(
      `0x${"22".repeat(32)}`,
    );
  });
});

describe("logging", () => {
  it("redacts credentials, signatures, cookies and secrets at any depth", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createLogger("info", sink);
    logger.info({
      req: {
        headers: {
          authorization: "Bearer abk_test_supersecret",
          cookie: "agentbank_session=abc",
          signature: "agentbank=:sig:",
          "signature-input": "agentbank=(...)",
        },
      },
      secret: "whsec_top",
      body: {
        owner_authorization: { signature: "0xdead" },
        nested: { deeper: { private_key: "0xkey", token: "tok" } },
      },
    });
    const out = lines.join("");
    for (const leaked of [
      "abk_test_supersecret",
      "agentbank_session=abc",
      "whsec_top",
      "0xdead",
      "0xkey",
      "agentbank=:sig:",
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain(REDACTED);
  });
});

describe("money", () => {
  it("formats integer minor units as decimal strings", () => {
    expect(decimal(0n)).toBe("0.00");
    expect(decimal(1n)).toBe("0.000001");
    expect(decimal(25_000_000n)).toBe("25.00");
    expect(decimal(1_234_567_890n)).toBe("1234.56789");
    expect(usdc(5_000_000n)).toEqual({ amount: "5.00", asset: "USDC" });
  });

  it("has no floating-point money code in the API sources", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(join(import.meta.dirname, "../src"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/parseFloat|toFixed\(|Number\.parseFloat/);
    }
  });
});

describe("meta", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it("publishes the deployment facts clients sign against", async () => {
    const res = await call(h.app, "GET", "/v1/meta");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "meta",
      chain: "simulated",
      chain_id: 1337,
      caip2: "eip155:1337",
      owner_authorization_chain_id: 1337,
      usdc: { address: h.chain.contracts.usdc, decimals: 6, eip712_name: "USDC", eip712_version: "2" },
      cosigner_address: h.cosigner.address,
      features: { escrow: true, streams: true, treasury_sweep: false, open_signup: true },
    });
    expect(res.body.contracts.escrow).toBe(h.chain.contracts.escrow);
    expect(res.body.revenue_address).toMatch(/^0x/);
  });
});
