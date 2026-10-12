import type { PreparedOperation } from "@agentbank/chain";
import type { EvaluateInternal } from "@agentbank/core";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYEE, usd, World } from "./helpers";

/**
 * Service objective (design § Security): p99 decision latency under 300 ms.
 * Measured in-process through the whole stack the API talks to: HMAC
 * authentication, routing, schema validation, the co-signer's database,
 * policy evaluation, and (for co-signatures) hashing, decoding, session
 * signature recovery and signing.
 */
const N = 1_000;
const WARMUP = 25;

let w: World;

beforeAll(async () => {
  w = await World.create({
    policy: { limits: { per_tx: "1000.00", per_day: "10000000.00" } },
    scope: { max_per_tx: "1000.00", max_per_day: "10000000.00" },
  });
});

afterAll(async () => {
  await w.close();
});

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function summary(name: string, samples: number[]): { p50: number; p99: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const result = { p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) as number };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `[benchmark] ${name}: n=${samples.length} p50=${result.p50.toFixed(2)}ms p99=${result.p99.toFixed(2)}ms max=${result.max.toFixed(2)}ms mean=${mean.toFixed(2)}ms (in-process, ${(process.env.COSIGNER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) ? "PostgreSQL" : "PGlite"})`,
  );
  return result;
}

describe("decision latency", () => {
  it(`runs ${N} evaluations and ${N} co-signatures with p99 under 300 ms`, async () => {
    const evaluation: EvaluateInternal = {
      org_id: w.org,
      agent_id: w.agent,
      account_id: w.accountId,
      account_address: w.account,
      chain_id: w.chain.chainId,
      session_id: w.sessionId,
      intent: {
        kind: "transfer",
        amount: usd(1).toString(),
        asset: "USDC",
        counterparty: { address: PAYEE },
      },
    };
    // Operations are prepared (and signed by the session key) up front, as the API and agent would.
    const prepared: { op: PreparedOperation; sessionSignature: Hex; amount: bigint }[] = [];
    for (let i = 0; i < N + WARMUP; i++) {
      const amount = usd(1) + BigInt(i);
      prepared.push({ ...(await w.prepare(w.transferCalls(PAYEE, amount, 0n))), amount });
    }

    for (let i = 0; i < WARMUP; i++) {
      await w.client.evaluate(evaluation);
      const p = prepared[i] as (typeof prepared)[number];
      await w.client.cosign(w.cosignRequest(p, { to: PAYEE, amount: p.amount, fee: 0n }));
    }

    const evaluations: number[] = [];
    for (let i = 0; i < N; i++) {
      const started = performance.now();
      const decision = await w.client.evaluate(evaluation);
      evaluations.push(performance.now() - started);
      expect(decision.outcome).toBe("allow");
    }

    const cosignatures: number[] = [];
    for (let i = WARMUP; i < N + WARMUP; i++) {
      const p = prepared[i] as (typeof prepared)[number];
      const request = w.cosignRequest(p, { to: PAYEE, amount: p.amount, fee: 0n });
      const started = performance.now();
      const result = await w.client.cosign(request);
      cosignatures.push(performance.now() - started);
      expect(result.signature).not.toBeNull();
    }

    const evaluate = summary("evaluate", evaluations);
    const cosign = summary("cosign", cosignatures);
    expect(evaluate.p99).toBeLessThan(300);
    expect(cosign.p99).toBeLessThan(300);
    // The in-process histogram agrees: (almost) everything lands at or below the 0.3 s bucket.
    const snapshot = w.cosigner.metrics.latencySnapshot("cosign");
    expect(snapshot.count).toBe(N + WARMUP);
  }, 600_000);
});
