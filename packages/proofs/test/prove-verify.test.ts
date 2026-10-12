import { readFileSync } from "node:fs";
import { ProofPresentation as ProofPresentationSchema } from "@agentbank/core/api";
import { poseidon2 } from "poseidon-lite/poseidon2";
import * as snarkjs from "snarkjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactPaths } from "../src/artifacts";
import { ProofInputError, ProofRefusedError, ProofRequestError } from "../src/errors";
import { fromBytes32, scopeField, toBytes32 } from "../src/field";
import { prepareProof, prove, toSolidityClaims, toSolidityProof } from "../src/prover";
import {
  balanceAtLeast,
  bounds,
  createProofRequest,
  requestHash,
  reservedFor,
  verifiedCompany,
  type ProofRequest,
} from "../src/request";
import { disclosureMask, MAX_U64, SNARK_SCALAR_FIELD } from "../src/schema";
import {
  checkRoot,
  publicSignals,
  releaseProverResources,
  rootStatusOf,
  VERIFICATION_KEY,
  verifyPresentation,
  type ProofPresentation,
  type RootInfo,
} from "../src/verifier";
import {
  AGENT_SECRET,
  buildFixture,
  CHAIN_ID,
  NOW,
  otherSecret,
  PUBLISHED_AT,
  REGISTRY,
  SCOPE,
  SNAPSHOT_AT,
  standardRequest,
  VALID_UNTIL,
} from "./fixtures";

const fixture = buildFixture();
const request = standardRequest();
const reservationRequest = createProofRequest({
  scope: SCOPE,
  require: [verifiedCompany(), reservedFor("500.00", { forSeconds: 3600 })],
  now: NOW,
  chainId: CHAIN_ID,
  registry: REGISTRY,
});
let presentation: ProofPresentation;
let reservationPresentation: ProofPresentation;

beforeAll(async () => {
  presentation = await prove({ secret: AGENT_SECRET, witness: fixture.baseWitness, request });
  reservationPresentation = await prove({
    secret: AGENT_SECRET,
    witness: fixture.reservationWitness,
    request: reservationRequest,
    artifacts: {
      wasm: new Uint8Array(readFileSync(artifactPaths().wasm)),
      zkey: new Uint8Array(readFileSync(artifactPaths().zkey)),
    },
  });
});

afterAll(releaseProverResources);

const verify = (overrides: Partial<Parameters<typeof verifyPresentation>[0]> = {}) =>
  verifyPresentation({ request, presentation, rootInfo: fixture.rootInfo, now: NOW, ...overrides });

describe("prove and verify", () => {
  it("proves the standard request from the base leaf", async () => {
    expect(ProofPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(presentation.request_hash).toBe(requestHash(request));
    expect(presentation.root).toBe(toBytes32(fixture.tree.root));
    const result = await verify();
    expect(result).toMatchObject({ valid: true, reason: null, root: presentation.root });
    // nullifier = Poseidon(secret, scope)
    expect(result.nullifier).toBe(toBytes32(poseidon2([fromBytes32(AGENT_SECRET), scopeField(SCOPE)])));
  });

  it("proves funds reserved for this verifier from the reservation leaf", async () => {
    const result = await verifyPresentation({
      request: reservationRequest,
      presentation: reservationPresentation,
      rootInfo: fixture.rootInfo,
      now: NOW,
    });
    expect(result.valid).toBe(true);
    // Same agent, same scope: the same pseudonym from either leaf.
    expect(reservationPresentation.nullifier).toBe(presentation.nullifier);
  });

  it("rebuilds public signals from the verifier's own request", async () => {
    const signals = publicSignals(request, presentation);
    const { mins, maxs } = bounds(request);
    expect(signals).toHaveLength(30);
    expect(signals.slice(0, 4)).toEqual([
      fromBytes32(presentation.nullifier).toString(),
      fromBytes32(presentation.root).toString(),
      scopeField(SCOPE).toString(),
      BigInt(request.nonce).toString(),
    ]);
    expect(signals.slice(4)).toEqual([...mins, ...maxs].map(String));
    // A different statement under its own hash: the proof does not carry over.
    const other: ProofRequest = {
      ...request,
      constraints: { ...request.constraints, balance: { min: "1.00" } },
    };
    const swapped = { ...presentation, request_hash: requestHash(other) };
    expect(await verify({ request: other, presentation: swapped })).toMatchObject({
      reason: "invalid_proof",
    });
    const otherScope = { ...request, scope: "other.example" };
    expect(
      await verify({
        request: otherScope,
        presentation: { ...presentation, request_hash: requestHash(otherScope) },
      }),
    ).toMatchObject({ reason: "invalid_proof" });
  });

  it("exports Solidity calldata like snarkjs", async () => {
    const calldata = JSON.parse(
      `[${await snarkjs.groth16.exportSolidityCallData(presentation.proof, publicSignals(request, presentation))}]`,
    ) as [string[], string[][], string[], string[]];
    const solidity = toSolidityProof(presentation);
    expect(solidity.a).toEqual(calldata[0].map(BigInt));
    expect(solidity.b).toEqual(calldata[1].map((pair) => pair.map(BigInt)));
    expect(solidity.c).toEqual(calldata[2].map(BigInt));
    const claims = toSolidityClaims(request, presentation);
    expect([
      claims.nullifier,
      BigInt(claims.root),
      claims.scope,
      claims.nonce,
      ...claims.mins,
      ...claims.maxs,
    ]).toEqual(calldata[3].map(BigInt));
  });
});

describe("verification failures, in order", () => {
  it("malformed", async () => {
    expect(await verify({ request: { ...request, type: "x" } })).toMatchObject({
      valid: false,
      reason: "malformed",
    });
    expect(
      await verify({ request: { ...request, constraints: { balance: { min: "2", max: "1" } } } }),
    ).toMatchObject({
      reason: "malformed",
    });
    expect(await verify({ presentation: { ...presentation, root: "0x12" } })).toMatchObject({
      reason: "malformed",
      request,
    });
    expect(
      await verify({ presentation: { ...presentation, root: toBytes32(SNARK_SCALAR_FIELD) } }),
    ).toMatchObject({
      reason: "malformed",
    });
    expect(
      await verify({ presentation: { ...presentation, nullifier: `0x${"ff".repeat(32)}` } }),
    ).toMatchObject({
      reason: "malformed",
    });
    expect(
      await verify({ presentation: { ...presentation, proof: { ...presentation.proof, curve: "bls" } } }),
    ).toMatchObject({ reason: "malformed" });
  });

  it("request_expired, then the gate's nonce check", async () => {
    expect(await verify({ now: request.expires_at + 1 })).toMatchObject({ reason: "request_expired" });
    expect((await verify({ now: request.expires_at })).valid).toBe(true);
    expect(await verify({ checkNonce: () => "nonce_invalid" })).toMatchObject({ reason: "nonce_invalid" });
    expect(await verify({ checkNonce: async () => "nonce_reused" as const })).toMatchObject({
      reason: "nonce_reused",
    });
    expect((await verify({ checkNonce: () => null })).valid).toBe(true);
  });

  it("request_hash_mismatch", async () => {
    const result = await verify({ presentation: { ...presentation, request_hash: toBytes32(1n) } });
    expect(result).toMatchObject({ reason: "request_hash_mismatch", root: presentation.root });
    const upper = {
      ...presentation,
      request_hash: presentation.request_hash.toUpperCase().replace("0X", "0x"),
    };
    expect((await verify({ presentation: upper })).valid).toBe(true);
  });

  it("root checks", async () => {
    const info = (o: Partial<RootInfo>) => ({ ...fixture.rootInfo, ...o });
    expect(await verify({ rootInfo: null })).toMatchObject({ reason: "unknown_root" });
    expect(await verify({ rootInfo: info({ publishedAt: null }) })).toMatchObject({ reason: "unknown_root" });
    expect(await verify({ rootInfo: info({ status: "publishing" }) })).toMatchObject({
      reason: "unknown_root",
    });
    expect(await verify({ rootInfo: info({ status: "failed" }) })).toMatchObject({ reason: "unknown_root" });
    expect(await verify({ rootInfo: info({ revoked: true }) })).toMatchObject({ reason: "root_revoked" });
    expect(await verify({ rootInfo: info({ status: "revoked" }) })).toMatchObject({ reason: "root_revoked" });
    expect(await verify({ rootInfo: info({ validUntil: NOW - 1 }) })).toMatchObject({
      reason: "root_expired",
    });
    expect(await verify({ rootInfo: info({ status: "expired" }) })).toMatchObject({ reason: "root_expired" });
    expect(await verify({ rootInfo: info({ snapshotAt: NOW - 7201 }) })).toMatchObject({
      reason: "root_too_old",
    });
    expect((await verify({ rootInfo: info({ snapshotAt: NOW - 7200 }) })).valid).toBe(true);
    expect(await verify({ rootInfo: info({ leafCount: 15 }) })).toMatchObject({
      reason: "anonymity_set_too_small",
      rootInfo: info({ leafCount: 15 }),
    });
    expect(checkRoot(fixture.rootInfo, request, NOW)).toBeNull();
  });

  it("resolves roots through a resolver, and needs one", async () => {
    const seen: unknown[] = [];
    const result = await verifyPresentation({
      request,
      presentation,
      now: NOW,
      rootResolver: async (query) => {
        seen.push(query);
        return fixture.rootInfo;
      },
    });
    expect(result.valid).toBe(true);
    expect(seen).toEqual([{ root: presentation.root, chainId: CHAIN_ID, registry: REGISTRY }]);
    await expect(verifyPresentation({ request, presentation, now: NOW })).rejects.toThrow(TypeError);
    await expect(
      verifyPresentation({
        request,
        presentation,
        now: NOW,
        rootResolver: () => Promise.reject(new Error("rpc down")),
      }),
    ).rejects.toThrow("rpc down");
  });

  it("invalid_proof", async () => {
    expect(await verify({ presentation: { ...presentation, nullifier: toBytes32(12345n) } })).toMatchObject({
      reason: "invalid_proof",
    });
    const offCurve = {
      ...presentation,
      proof: { ...presentation.proof, pi_c: ["1", "1", "1"] as [string, string, string] },
    };
    expect(await verify({ presentation: offCurve })).toMatchObject({ reason: "invalid_proof" });
    expect(await verify({ verificationKey: { ...VERIFICATION_KEY, curve: "nope" } })).toMatchObject({
      reason: "invalid_proof",
    });
    // the default clock: the fixture's request expired long ago
    expect(await verifyPresentation({ request, presentation, rootInfo: fixture.rootInfo })).toMatchObject({
      reason: "request_expired",
    });
  });

  it("reports root status", () => {
    const base = fixture.rootInfo;
    expect(rootStatusOf(null, NOW)).toBeNull();
    expect(rootStatusOf(base, NOW)).toBe("published");
    expect(rootStatusOf({ ...base, revoked: true }, NOW)).toBe("revoked");
    expect(rootStatusOf({ ...base, status: "failed" }, NOW)).toBe("failed");
    expect(rootStatusOf({ ...base, status: "publishing" }, NOW)).toBe("publishing");
    expect(rootStatusOf({ ...base, publishedAt: null }, NOW)).toBe("publishing");
    expect(rootStatusOf(base, VALID_UNTIL + 1)).toBe("expired");
    expect(rootStatusOf({ ...base, status: "expired" }, NOW)).toBe("expired");
    expect([SNAPSHOT_AT, PUBLISHED_AT]).toEqual([base.snapshotAt, base.publishedAt]);
  });
});

describe("the prover refuses before proving", () => {
  it("when attested values cannot satisfy the request", () => {
    const greedy = standardRequest({ require: [balanceAtLeast("5000.00"), verifiedCompany()] });
    try {
      prepareProof({ secret: AGENT_SECRET, witness: fixture.baseWitness, request: greedy });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProofRefusedError);
      const refusal = error as ProofRefusedError;
      expect(refusal.reason).toBe("unsatisfiable");
      expect(refusal.attributes).toEqual(["balance"]);
      expect(refusal.undisclosedClasses).toEqual([]);
    }
  });

  it("when the request constrains classes the owner did not disclose", () => {
    const narrow = buildFixture({ mask: disclosureMask(["principal", "limits"]) });
    try {
      prepareProof({ secret: AGENT_SECRET, witness: narrow.baseWitness, request });
      expect.unreachable();
    } catch (error) {
      const refusal = error as ProofRefusedError;
      expect(refusal.reason).toBe("undisclosed");
      expect(refusal.undisclosedClasses).toEqual(["balance", "account_age", "reputation"]);
      expect(refusal.message).toMatch(/balance, account_age, reputation/);
    }
  });

  it("when the secret or chain does not match the witness", () => {
    expect(() => prepareProof({ secret: otherSecret(3), witness: fixture.baseWitness, request })).toThrow(
      expect.objectContaining({ reason: "witness_mismatch" }),
    );
    expect(() =>
      prepareProof({ secret: AGENT_SECRET, witness: { ...fixture.baseWitness, chain_id: 31337 }, request }),
    ).toThrow(expect.objectContaining({ reason: "chain_mismatch" }));
    expect(() =>
      prepareProof({ secret: AGENT_SECRET, witness: { ...fixture.baseWitness, registry: null }, request }),
    ).toThrow(expect.objectContaining({ reason: "chain_mismatch" }));
    const anyRegistry = { ...request, registry: null };
    expect(
      prepareProof({ secret: AGENT_SECRET, witness: fixture.baseWitness, request: anyRegistry }).input.root,
    ).toBe(fixture.tree.root.toString());
  });

  it("on malformed input", () => {
    expect(() => prepareProof({ secret: "0x0", witness: fixture.baseWitness, request })).toThrow(
      ProofInputError,
    );
    expect(() => prepareProof({ secret: AGENT_SECRET, witness: { nope: true }, request })).toThrow(
      ProofInputError,
    );
    expect(() => prepareProof({ secret: AGENT_SECRET, witness: null, request })).toThrow(
      /invalid witness: witness/,
    );
    expect(() => prepareProof({ secret: AGENT_SECRET, witness: fixture.baseWitness, request: {} })).toThrow(
      ProofRequestError,
    );
  });

  it("and the circuit itself enforces the disclosure mask", async () => {
    const narrow = buildFixture({ mask: disclosureMask(["principal", "limits"]) });
    const allowed = standardRequest({ require: [verifiedCompany()] });
    const { input } = prepareProof({ secret: AGENT_SECRET, witness: narrow.baseWitness, request: allowed });
    // Bypass the prover's own check: constrain the undisclosed balance trivially (min 1).
    const forged = { ...input, mins: input.mins.map((m, i) => (i === 3 ? "1" : m)) };
    await expect(
      snarkjs.groth16.fullProve(forged as never, artifactPaths().wasm, artifactPaths().zkey),
    ).rejects.toThrow();
    const unbounded = { ...input, maxs: input.maxs.map((m, i) => (i === 3 ? (MAX_U64 - 1n).toString() : m)) };
    await expect(
      snarkjs.groth16.fullProve(unbounded as never, artifactPaths().wasm, artifactPaths().zkey),
    ).rejects.toThrow();
  });
});
