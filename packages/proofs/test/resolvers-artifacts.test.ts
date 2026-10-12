import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARTIFACTS_DIR,
  artifactPaths,
  loadManifest,
  loadVerificationKey,
  verifyArtifacts,
} from "../src/artifacts";
import { toBytes32 } from "../src/field";
import {
  apiRootResolver,
  ATTESTATION_REGISTRY_ABI,
  chainRootResolver,
  rootInfoFromApi,
  VERIFICATION_KEY,
  type RegistryReader,
} from "../src/verifier";
import { CHAIN_ID, REGISTRY } from "./fixtures";

const ROOT = toBytes32(123n);
const apiRoot = {
  object: "proof_root",
  root: ROOT,
  epoch: "7",
  snapshot_at: "2025-10-09T08:53:20.000Z",
  published_at: "2025-10-09T08:53:32.000Z",
  valid_until: "2025-10-09T10:53:20.000Z",
  leaf_count: 20,
  status: "published",
  tx_hash: `0x${"aa".repeat(32)}`,
  chain_id: CHAIN_ID,
  registry: REGISTRY,
};

function fakeFetch(status: number, body: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("apiRootResolver", () => {
  const query = { root: ROOT, chainId: CHAIN_ID, registry: REGISTRY };

  it("maps GET /v1/proofs/roots/{root} to a root record", async () => {
    const calls: string[] = [];
    const info = await apiRootResolver("https://api.example.test/", fakeFetch(200, apiRoot, calls))(query);
    expect(calls).toEqual([`https://api.example.test/v1/proofs/roots/${ROOT}`]);
    expect(info).toEqual({
      epoch: 7n,
      snapshotAt: 1_760_000_000,
      publishedAt: 1_760_000_012,
      validUntil: 1_760_007_200,
      leafCount: 20,
      revoked: false,
      status: "published",
    });
    expect(rootInfoFromApi({ ...apiRoot, status: "revoked", published_at: null } as never)).toMatchObject({
      revoked: true,
      publishedAt: null,
    });
    // a request without a registry accepts the API's
    expect(
      await apiRootResolver("https://x", fakeFetch(200, apiRoot))({ ...query, registry: null }),
    ).not.toBeNull();
  });

  it("treats unknown roots and other chains or registries as unknown, and fails closed otherwise", async () => {
    expect(await apiRootResolver("https://x", fakeFetch(404, { code: "not_found" }))(query)).toBeNull();
    expect(await apiRootResolver("https://x", fakeFetch(200, { ...apiRoot, chain_id: 1 }))(query)).toBeNull();
    expect(
      await apiRootResolver(
        "https://x",
        fakeFetch(200, { ...apiRoot, registry: `0x${"22".repeat(20)}` }),
      )(query),
    ).toBeNull();
    expect(
      await apiRootResolver("https://x", fakeFetch(200, { ...apiRoot, registry: null }))(query),
    ).toBeNull();
    await expect(apiRootResolver("https://x", fakeFetch(503, {}))(query)).rejects.toThrow(/HTTP 503/);
    await expect(
      apiRootResolver("https://x", fakeFetch(200, { ...apiRoot, root: toBytes32(1n) }))(query),
    ).rejects.toThrow(/another root/);
    await expect(apiRootResolver("https://x", fakeFetch(200, { nope: true }))(query)).rejects.toThrow();
  });
});

describe("chainRootResolver", () => {
  const record = {
    epoch: 7n,
    snapshotAt: 100n,
    publishedAt: 112n,
    validUntil: 7300n,
    leafCount: 20,
    revoked: false,
  };

  function reader(value: typeof record, chainId?: number, calls: unknown[] = []): RegistryReader {
    return {
      chain: chainId === undefined ? undefined : { id: chainId },
      readContract: (async (args: unknown) => {
        calls.push(args);
        return value;
      }) as never,
    };
  }

  it("reads rootInfo from the registry", async () => {
    const calls: unknown[] = [];
    const resolve = chainRootResolver(reader(record, CHAIN_ID, calls), REGISTRY);
    expect(await resolve({ root: ROOT, chainId: CHAIN_ID, registry: REGISTRY })).toEqual({
      epoch: 7n,
      snapshotAt: 100,
      publishedAt: 112,
      validUntil: 7300,
      leafCount: 20,
      revoked: false,
    });
    expect(calls).toEqual([
      { address: REGISTRY, abi: ATTESTATION_REGISTRY_ABI, functionName: "rootInfo", args: [ROOT] },
    ]);
    expect(
      await chainRootResolver(reader(record), REGISTRY)({ root: ROOT, chainId: 1, registry: null }),
    ).not.toBeNull();
  });

  it("treats unpublished roots, other chains and other registries as unknown", async () => {
    const empty = { ...record, epoch: 0n, publishedAt: 0n };
    expect(
      await chainRootResolver(reader(empty), REGISTRY)({ root: ROOT, chainId: CHAIN_ID, registry: null }),
    ).toBeNull();
    expect(
      await chainRootResolver(reader(record, 1), REGISTRY)({ root: ROOT, chainId: CHAIN_ID, registry: null }),
    ).toBeNull();
    expect(
      await chainRootResolver(
        reader(record),
        REGISTRY,
      )({
        root: ROOT,
        chainId: CHAIN_ID,
        registry: `0x${"22".repeat(20)}`,
      }),
    ).toBeNull();
  });
});

describe("artifacts", () => {
  it("bundles the circuit files the manifest describes", () => {
    expect(verifyArtifacts()).toEqual({ ok: true, mismatches: [] });
    const manifest = loadManifest();
    expect(manifest.schema).toBe("agentbank.claims.v1");
    expect(manifest.constraints).toBe(10_270);
    expect(loadVerificationKey()).toEqual(VERIFICATION_KEY);
    expect(VERIFICATION_KEY.nPublic).toBe(30);
    expect(artifactPaths().wasm.startsWith(ARTIFACTS_DIR)).toBe(true);
  });

  it("detects tampered artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbank-proofs-"));
    try {
      copyFileSync(artifactPaths().manifest, join(dir, "manifest.json"));
      copyFileSync(artifactPaths().verificationKey, join(dir, "verification_key.json"));
      writeFileSync(join(dir, "agent_claims.wasm"), "not wasm");
      writeFileSync(join(dir, "agent_claims.zkey"), "not a zkey");
      expect(verifyArtifacts(dir)).toEqual({ ok: false, mismatches: ["wasm", "zkey"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
