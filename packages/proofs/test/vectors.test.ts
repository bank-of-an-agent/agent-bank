import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { fromBytes32, onchainScope, scopeField } from "../src/field";
import { createProofGate, gateNonce, PROOF_HEADERS } from "../src/http";
import { toClaimsVerifierArgs } from "../src/onchain";
import { prepareProof } from "../src/prover";
import { parseProofRequest, requestHash, type ProofRequest } from "../src/request";
import { computeRoot } from "../src/tree";
import {
  publicSignals,
  releaseProverResources,
  verifyPresentation,
  type ProofPresentation,
} from "../src/verifier";
import { GATE_REQUIREMENTS, rootInfoFromJson } from "./fixtures";
import { claimsArgsJson, deterministicVectors } from "./vector-data";

/** The committed vectors the Python SDK runs must stay true. */
const vectors = JSON.parse(readFileSync(new URL("./vectors/proofs.json", import.meta.url), "utf8"));

type RootJson = Parameters<typeof rootInfoFromJson>[0] & { root: string };

function vectorGate(rootInfo: RootJson | null, now: number) {
  const g = vectors.proof.gate;
  return createProofGate({
    scope: g.scope,
    key: g.key_utf8,
    require: GATE_REQUIREMENTS,
    ttlSeconds: g.ttl_seconds,
    chainId: g.chain_id,
    registry: g.registry,
    minAnonymitySet: g.min_anonymity_set,
    maxRootAgeSeconds: g.max_root_age_seconds,
    now: () => now,
    rootResolver: async ({ root }) => {
      if (rootInfo === null) return null;
      expect(root).toBe(rootInfo.root.toLowerCase());
      return rootInfoFromJson(rootInfo);
    },
  });
}

afterAll(releaseProverResources);

describe("committed proof vectors", () => {
  it("still match every deterministic derivation", () => {
    const fresh = JSON.parse(JSON.stringify(deterministicVectors()));
    for (const [key, value] of Object.entries(fresh)) expect(vectors[key], key).toEqual(value);
  });

  it("reject every invalid request", () => {
    for (const { name, request } of vectors.invalid_requests) {
      expect(() => parseProofRequest(request), name).toThrow();
    }
  });

  it("carry tree witnesses that hash to the root", () => {
    const root = fromBytes32(vectors.tree.root);
    for (const w of vectors.tree.witnesses) {
      expect(computeRoot(BigInt(w.leaf), w.siblings.map(BigInt), w.path_bits)).toBe(root);
    }
  });

  it("carry a gate-issued request whose proof the gate accepts once", async () => {
    const {
      request,
      presentation,
      root_info: rootInfo,
      gate,
    } = vectors.proof as {
      request: ProofRequest;
      presentation: ProofPresentation;
      root_info: RootJson;
      gate: { now: number; key_utf8: string };
    };
    expect(request.nonce).toBe(gateNonce(gate.key_utf8, request));
    expect(requestHash(request)).toBe(vectors.proof.request_hash);
    expect(publicSignals(request, presentation)).toEqual(vectors.proof.public_signals);
    // The secret and witness in the vector produce this circuit input.
    const { input } = prepareProof({ secret: vectors.proof.secret, witness: vectors.proof.witness, request });
    expect(input.root).toBe(fromBytes32(presentation.root).toString());

    const g = vectorGate(rootInfo, gate.now);
    const headers = { [PROOF_HEADERS.proof]: vectors.proof.agent_proof_header };
    expect(await g.check(headers)).toMatchObject({
      kind: "verified",
      nullifier: vectors.proof.expected.nullifier,
      root: vectors.proof.expected.root,
    });
    expect(await g.check(headers)).toMatchObject({ kind: "proof-required", reason: "nonce_reused" });
  });

  it("carry AgentClaimsVerifier calldata for the gate-issued proof", () => {
    const { request, presentation } = vectors.proof;
    expect(claimsArgsJson(toClaimsVerifierArgs(request, presentation))).toEqual(
      vectors.proof.claims_verifier_args,
    );
  });

  it("carry a proof for an on-chain scope id that verifies, with its calldata", async () => {
    const v = vectors.onchain_proof;
    expect(scopeField(v.request.scope)).toBe(onchainScope(v.chain_id, v.consumer, v.context));
    expect(requestHash(v.request)).toBe(v.request_hash);
    expect(publicSignals(v.request, v.presentation)).toEqual(v.public_signals);
    expect(v.public_signals[2]).toBe(onchainScope(v.chain_id, v.consumer, v.context).toString());
    const result = await verifyPresentation({
      request: v.request,
      presentation: v.presentation,
      rootInfo: rootInfoFromJson(v.root_info),
      now: v.now,
    });
    expect(result).toMatchObject({ valid: true, reason: null });
    expect(claimsArgsJson(toClaimsVerifierArgs(v.request, v.presentation))).toEqual(v.claims_verifier_args);
  });

  it("carry tampered variants refused for the stated reason", async () => {
    expect(vectors.tampered.map((t: { expected_reason: string }) => t.expected_reason)).toEqual(
      expect.arrayContaining([
        "malformed",
        "request_expired",
        "nonce_invalid",
        "nonce_reused",
        "request_hash_mismatch",
        "unknown_root",
        "root_revoked",
        "root_expired",
        "root_too_old",
        "anonymity_set_too_small",
        "invalid_proof",
      ]),
    );
    for (const t of vectors.tampered) {
      const g = vectorGate(t.root_info, t.now);
      const headers = { [PROOF_HEADERS.proof]: t.agent_proof_header };
      if (t.submit_twice) expect((await g.check(headers)).kind, t.name).toBe("verified");
      expect(await g.check(headers), t.name).toMatchObject({
        kind: "proof-required",
        reason: t.expected_reason,
      });
    }
  });
});
