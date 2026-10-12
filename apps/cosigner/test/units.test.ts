import { transferCall } from "@agentbank/chain";
import { CHAINS } from "@agentbank/core";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { contractsFor, createOperationCodec } from "../src/chain";
import { loadConfig } from "../src/config";
import { migrateCosigner } from "../src/database";
import { Metrics } from "../src/metrics";
import { ANVIL_KEYS } from "./keys";
import { createTestDb, PAYEE, REVENUE, usd, World } from "./helpers";

describe("metrics", () => {
  it("renders the decision latency histogram and counters in Prometheus text format", () => {
    const metrics = new Metrics();
    metrics.observeDecision("cosign", "allow", 0.004);
    metrics.observeDecision("cosign", "allow", 0.4);
    metrics.observeRequest("/internal/v1/cosign", 200);
    metrics.gauge("cosigner_fail_closed", "fail closed", () => 0);
    const text = metrics.render();
    expect(text).toContain(
      'cosigner_decision_duration_seconds_bucket{route="cosign",outcome="allow",le="0.005"} 1',
    );
    expect(text).toContain(
      'cosigner_decision_duration_seconds_bucket{route="cosign",outcome="allow",le="0.3"} 1',
    );
    expect(text).toContain(
      'cosigner_decision_duration_seconds_bucket{route="cosign",outcome="allow",le="+Inf"} 2',
    );
    expect(text).toContain('cosigner_decision_duration_seconds_count{route="cosign",outcome="allow"} 2');
    expect(text).toContain('cosigner_decisions_total{route="cosign",outcome="allow"} 2');
    expect(text).toContain('cosigner_requests_total{route="/internal/v1/cosign",status="200"} 1');
    expect(text).toContain("cosigner_fail_closed 0");
    expect(metrics.latencySnapshot("cosign").count).toBe(2);
  });

  it("emits CloudWatch EMF lines (no dimensions) only when a namespace is configured", () => {
    const lines: string[] = [];
    const metrics = new Metrics({
      emfNamespace: "AgentBank/Cosigner",
      emfSink: (l) => lines.push(l),
      now: () => 1_790_000_000_000,
    });
    metrics.observeDecision("evaluate", "deny", 0.0125);
    metrics.observeRequest("/internal/v1/evaluate", 200);
    metrics.observeRequest("/internal/v1/cosign", 503);
    const [latency, ok, failed] = lines.map(
      (l) =>
        JSON.parse(l) as Record<string, unknown> & {
          _aws: {
            Timestamp: number;
            CloudWatchMetrics: {
              Namespace: string;
              Dimensions: string[][];
              Metrics: { Name: string; Unit: string }[];
            }[];
          };
        },
    );
    expect(latency?._aws).toEqual({
      Timestamp: 1_790_000_000_000,
      CloudWatchMetrics: [
        {
          Namespace: "AgentBank/Cosigner",
          Dimensions: [[]],
          Metrics: [{ Name: "DecisionLatency", Unit: "Milliseconds" }],
        },
      ],
    });
    expect(latency?.DecisionLatency).toBeCloseTo(12.5);
    expect(ok).toMatchObject({ Requests: 1, Errors: 0 });
    expect(failed).toMatchObject({ Requests: 1, Errors: 1 });
    expect(failed?._aws.CloudWatchMetrics[0]?.Metrics.map((m) => m.Name)).toEqual(["Requests", "Errors"]);

    const silent: string[] = [];
    new Metrics({ emfSink: (l) => silent.push(l) }).observeDecision("cosign", "allow", 0.01);
    expect(silent).toEqual([]);
  });
});

describe("configuration", () => {
  const base = {
    COSIGNER_SHARED_SECRET: "a".repeat(40),
    COSIGNER_DATABASE_URL: "pglite://memory",
    COSIGNER_PRIVATE_KEY: ANVIL_KEYS.cosigner,
    COSIGNER_REVENUE_ADDRESS: REVENUE,
  };

  it("loads a minimal development configuration with safe defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 8081,
      host: "0.0.0.0",
      failClosed: false,
      maxFeeSweep: 100_000_000n,
      ownerAuthorizationChainId: CHAINS.simulated.id,
      signer: { kind: "local" },
    });
    expect(config.chain.name).toBe("simulated");
    expect(
      loadConfig({ ...base, AGENTBANK_CHAIN: "base-sepolia", OWNER_AUTHORIZATION_CHAIN_ID: "84532" })
        .ownerAuthorizationChainId,
    ).toBe(84532);
  });

  it("parses COSIGNER_FAIL_CLOSED fail-safe: only explicit false values turn it off", () => {
    for (const value of ["true", "1", "yes", "TRUE", "on", "ture"])
      expect(loadConfig({ ...base, COSIGNER_FAIL_CLOSED: value }).failClosed, value).toBe(true);
    for (const value of ["false", "0", "no", "off", ""])
      expect(loadConfig({ ...base, COSIGNER_FAIL_CLOSED: value }).failClosed, value).toBe(false);
  });

  it("refuses unsafe configurations", () => {
    expect(() => loadConfig({ ...base, COSIGNER_SHARED_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, COSIGNER_PRIVATE_KEY: undefined })).toThrow(/COSIGNER_PRIVATE_KEY/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/kms in production/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        COSIGNER_SIGNER: "kms",
        COSIGNER_KMS_KEY_ID: "alias/x",
        COSIGNER_SHARED_SECRET: "dev-only-shared-secret-change-me",
      }),
    ).toThrow(/example value/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", COSIGNER_SIGNER: "kms", COSIGNER_KMS_KEY_ID: "alias/x" }),
    ).toThrow(/PostgreSQL in production/);
    expect(() => loadConfig({ ...base, COSIGNER_SIGNER: "kms" })).toThrow(/COSIGNER_KMS_KEY_ID/);
    expect(() => loadConfig({ ...base, AGENTBANK_CHAIN: "base" })).toThrow();
    expect(() => loadConfig({ ...base, COSIGNER_CONTRACTS: "{not json" })).toThrow(/COSIGNER_CONTRACTS/);
    const prod = loadConfig({
      ...base,
      NODE_ENV: "production",
      COSIGNER_SIGNER: "kms",
      COSIGNER_KMS_KEY_ID: "alias/cosigner",
      COSIGNER_DATABASE_URL: "postgres://cosigner@db/cosigner",
      METRICS_NAMESPACE: "AgentBank/Cosigner",
    });
    expect(prod).toMatchObject({
      signer: { kind: "kms", kmsKeyId: "alias/cosigner" },
      metricsNamespace: "AgentBank/Cosigner",
    });
  });

  it("fills Agent Bank contract addresses from COSIGNER_CONTRACTS", () => {
    const config = loadConfig({
      ...base,
      AGENTBANK_CHAIN: "base-sepolia",
      COSIGNER_CONTRACTS: JSON.stringify({ escrow: "0x00000000000000000000000000000000000000e1" }),
    });
    expect(contractsFor(config).escrow).toBe(getAddress("0x00000000000000000000000000000000000000e1"));
  });
});

describe("migrations", () => {
  it("are idempotent and safe to run from several replicas at once", async () => {
    const { db, close } = await createTestDb();
    try {
      const runs = await Promise.all([migrateCosigner(db), migrateCosigner(db), migrateCosigner(db)]);
      expect(runs.flat()).toEqual([]);
      const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      expect(rows.map((r) => r.name)).toEqual(["0001_cosigner.sql"]);
    } finally {
      await close();
    }
  });
});

describe("the production operation codec", () => {
  it("hashes and decodes exactly like the chain gateway, without any network access", async () => {
    const w = await World.create();
    try {
      const codec = createOperationCodec(
        loadConfig({
          COSIGNER_SHARED_SECRET: "a".repeat(40),
          COSIGNER_DATABASE_URL: "pglite://memory",
          COSIGNER_PRIVATE_KEY: ANVIL_KEYS.cosigner,
          COSIGNER_REVENUE_ADDRESS: REVENUE,
        }),
      );
      const { op } = await w.prepare([transferCall({ token: w.usdc, to: PAYEE, amount: usd(3) })]);
      expect(codec.chainId).toBe(w.chain.chainId);
      expect(codec.hashOperation(op)).toBe(w.chain.gateway.hashOperation(op));
      expect(codec.decodeOperation(op)).toEqual(w.chain.gateway.decodeOperation(op));
      expect(() => codec.hashOperation({ ...op, chainId: 84532 })).toThrow();
    } finally {
      await w.close();
    }
  });
});
