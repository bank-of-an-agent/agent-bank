import { bytesToBase64, canonicalJson, utf8 } from "@agentbank/core";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createProofGate,
  decodeHeaderJson,
  decodeProof,
  decodeProofRequired,
  decodeProofResponse,
  encodeHeaderJson,
  encodeProof,
  encodeProofRequired,
  gateNonce,
  MemoryReplayCache,
  PROOF_HEADERS,
  ProofHeaderError,
  wwwAuthenticate,
  type ProofGateOptions,
  type ReplayCache,
} from "../src/http";
import { prove } from "../src/prover";
import { requestHash, type ProofRequest } from "../src/request";
import { releaseProverResources, VERIFICATION_KEY, type ProofPresentation } from "../src/verifier";
import {
  AGENT_SECRET,
  buildFixture,
  CHAIN_ID,
  GATE_KEY,
  GATE_REQUIREMENTS,
  NOW,
  REGISTRY,
  SCOPE,
  standardRequest,
} from "./fixtures";

const fixture = buildFixture();

function gateAt(clock: { now: number }, overrides: Partial<ProofGateOptions> = {}) {
  return createProofGate({
    scope: SCOPE,
    key: GATE_KEY,
    require: GATE_REQUIREMENTS,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    rootResolver: async () => fixture.rootInfo,
    now: () => clock.now,
    ...overrides,
  });
}

let request: ProofRequest;
let presentation: ProofPresentation;

beforeAll(async () => {
  request = gateAt({ now: NOW }).createRequest();
  presentation = await prove({ secret: AGENT_SECRET, witness: fixture.reservationWitness, request });
});

afterAll(releaseProverResources);

describe("headers", () => {
  it("encode and decode base64 JSON", () => {
    const req = standardRequest();
    expect(decodeProofRequired(encodeProofRequired(req))).toEqual(req);
    const urlSafe = encodeHeaderJson({ a: "ÿ~?>" })
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeHeaderJson(urlSafe, z.object({ a: z.string() }))).toEqual({ a: "ÿ~?>" });
    expect(() => decodeHeaderJson("%%%", z.unknown())).toThrow(ProofHeaderError);
    expect(() => decodeHeaderJson(bytesToBase64(utf8("{nope")), z.unknown())).toThrow(/base64-encoded JSON/);
    expect(() => decodeHeaderJson(bytesToBase64(new Uint8Array([0xff, 0xfe])), z.unknown())).toThrow(
      ProofHeaderError,
    );
    expect(() => decodeHeaderJson(encodeHeaderJson({ a: 1 }), z.object({ a: z.string() }))).toThrow(
      /invalid header: a/,
    );
    expect(() => decodeHeaderJson(encodeHeaderJson(1), z.object({}))).toThrow(/invalid header: value/);
    expect(
      decodeProofResponse(encodeHeaderJson({ status: "accepted", nullifier: `0x${"11".repeat(32)}` })),
    ).toEqual({
      status: "accepted",
      nullifier: `0x${"11".repeat(32)}`,
    });
    expect(wwwAuthenticate('a"b\\c')).toBe('AgentProof realm="a\\"b\\\\c"');
  });

  it("derives stateless nonces from the key and the request without nonce", () => {
    const req = standardRequest();
    const { nonce: _nonce, ...withoutNonce } = req;
    const expected = `0x${Buffer.from(hmac(sha256, utf8(GATE_KEY), utf8(canonicalJson(withoutNonce))).slice(0, 31)).toString("hex")}`;
    expect(gateNonce(GATE_KEY, req)).toBe(expected);
    expect(gateNonce(GATE_KEY, withoutNonce)).toBe(expected);
    expect(gateNonce(utf8(GATE_KEY), { ...req, nonce: `0x${"00".repeat(31)}` })).toBe(expected);
    expect(gateNonce(`${GATE_KEY}!`, req)).not.toBe(expected);
  });
});

describe("createProofGate", () => {
  it("validates its options", () => {
    expect(() => gateAt({ now: NOW }, { key: "short" })).toThrow(/32 bytes/);
    expect(() => gateAt({ now: NOW }, { scope: "" })).toThrow(/scope/);
    expect(() => gateAt({ now: NOW }, { scope: "x".repeat(254) })).toThrow(/scope/);
  });

  it("challenges with a 401 and an authentic request", () => {
    const gate = gateAt({ now: NOW });
    const challenge = gate.challenge();
    expect(challenge.status).toBe(401);
    expect(challenge.headers[PROOF_HEADERS.wwwAuthenticate]).toBe(`AgentProof realm="${SCOPE}"`);
    const issued = decodeProofRequired(challenge.headers[PROOF_HEADERS.required] as string);
    expect(issued).toEqual(challenge.request);
    expect(issued.nonce).toBe(gateNonce(GATE_KEY, issued));
    expect(issued.scope).toBe(SCOPE);
    expect(issued.issued_at).toBe(NOW);
    expect(issued.expires_at).toBe(NOW + 300);
    expect(issued.registry).toBe(REGISTRY);
    expect(challenge.body).toEqual({ error: "proof_required", reason: null, request: issued });
    expect(gate.scope).toBe(SCOPE);
  });

  it("accepts a valid proof once, then refuses the replay", async () => {
    const gate = gateAt({ now: NOW + 10 });
    const header = encodeProof({ request, presentation });
    const accepted = await gate.check({ "Agent-Proof": header });
    expect(accepted.kind).toBe("verified");
    if (accepted.kind !== "verified") return;
    expect(accepted.nullifier).toBe(presentation.nullifier);
    expect(accepted.root).toBe(presentation.root);
    expect(accepted.request).toEqual(request);
    expect(decodeProofResponse(accepted.headers[PROOF_HEADERS.response] as string)).toEqual({
      status: "accepted",
      nullifier: presentation.nullifier,
    });
    const replay = await gate.check(new Headers({ [PROOF_HEADERS.proof]: header }));
    expect(replay).toMatchObject({ kind: "proof-required", reason: "nonce_reused" });
    if (replay.kind === "proof-required") {
      expect(replay.response.status).toBe(401);
      expect(replay.response.body.reason).toBe("nonce_reused");
    }
  });

  it("asks for a proof when none (or garbage) is sent", async () => {
    const gate = gateAt({ now: NOW });
    expect(await gate.check({})).toMatchObject({ kind: "proof-required", reason: null });
    expect(await gate.check({ "agent-proof": "  " })).toMatchObject({ reason: null });
    expect(await gate.check({ "agent-proof": undefined, other: "x" })).toMatchObject({ reason: null });
    expect(await gate.check({ "agent-proof": ["%%%"] })).toMatchObject({ reason: "malformed" });
    expect(await gate.check({ "agent-proof": encodeHeaderJson({ request }) })).toMatchObject({
      reason: "malformed",
    });
  });

  it("refuses expired requests and forged or foreign nonces", async () => {
    const header = (r: ProofRequest, p: ProofPresentation = presentation) =>
      ({ [PROOF_HEADERS.proof]: encodeProof({ request: r, presentation: p }) }) as Record<string, string>;
    expect(await gateAt({ now: request.expires_at + 1 }).check(header(request))).toMatchObject({
      reason: "request_expired",
    });
    const gate = gateAt({ now: NOW });
    const loosened: ProofRequest = {
      ...request,
      constraints: { ...request.constraints, per_tx_limit: { min: "1.00" } },
    };
    expect(
      await gate.check(header(loosened, { ...presentation, request_hash: requestHash(loosened) })),
    ).toMatchObject({
      reason: "nonce_invalid",
    });
    expect(await gate.check(header({ ...request, nonce: `0x${"ab".repeat(31)}` }))).toMatchObject({
      reason: "nonce_invalid",
    });
    const foreign = gateAt({ now: NOW }, { scope: "other.example" });
    expect(await foreign.check(header(request))).toMatchObject({ reason: "nonce_invalid" });
    const rekeyed = gateAt({ now: NOW }, { key: `${GATE_KEY}-rotated` });
    expect(await rekeyed.check(header(request))).toMatchObject({ reason: "nonce_invalid" });
    // a valid nonce does not make a bad proof pass
    expect(
      await gate.check(header(request, { ...presentation, request_hash: `0x${"00".repeat(32)}` })),
    ).toMatchObject({ reason: "request_hash_mismatch" });
    const unknownRoot = gateAt({ now: NOW }, { rootResolver: async () => null });
    expect(await unknownRoot.check(header(request))).toMatchObject({ reason: "unknown_root" });
  });

  it("defaults to the system clock, Base Sepolia and the SDK limits", async () => {
    const gate = createProofGate({
      scope: SCOPE,
      key: utf8(GATE_KEY),
      require: [],
      rootResolver: async () => fixture.rootInfo,
    });
    const issued = gate.challenge("malformed").request;
    expect(Math.abs(issued.issued_at - Date.now() / 1000)).toBeLessThan(5);
    expect(issued).toMatchObject({
      chain_id: 84532,
      registry: null,
      min_anonymity_set: 16,
      max_root_age_seconds: 7200,
      constraints: {},
    });
    expect(issued.expires_at - issued.issued_at).toBe(300);
    const pinned = gateAt({ now: NOW }, { verificationKey: VERIFICATION_KEY });
    expect((await pinned.check({ "agent-proof": encodeProof({ request, presentation }) })).kind).toBe(
      "verified",
    );
  });

  it("treats a lost consume race as a replay", async () => {
    const racy: ReplayCache = { has: () => false, consume: async () => false };
    const gate = gateAt({ now: NOW }, { replayCache: racy, verificationKey: undefined });
    const result = await gate.check({ [PROOF_HEADERS.proof]: encodeProof({ request, presentation }) });
    expect(result).toMatchObject({ kind: "proof-required", reason: "nonce_reused" });
  });

  it("decodes the AGENT-PROOF envelope", () => {
    expect(decodeProof(encodeProof({ request, presentation }))).toEqual({ request, presentation });
  });
});

describe("MemoryReplayCache", () => {
  it("remembers nonces until their request expires", () => {
    const cache = new MemoryReplayCache();
    expect(cache.consume("a", 100, 50)).toBe(true);
    expect(cache.has("a", 100)).toBe(true);
    expect(cache.consume("a", 100, 60)).toBe(false);
    expect(cache.has("a", 101)).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.consume("a", 200, 101)).toBe(true);
  });

  it("evicts expired entries first, then the soonest-expiring", () => {
    const cache = new MemoryReplayCache({ maxEntries: 3 });
    cache.consume("a", 10, 0);
    cache.consume("b", 30, 0);
    cache.consume("c", 20, 0);
    cache.consume("d", 40, 15); // "a" expired: evicted
    expect(cache.size).toBe(3);
    expect(cache.has("a", 15)).toBe(false);
    cache.consume("e", 50, 15); // full of live entries: drop "c" (soonest)
    expect(cache.has("c", 15)).toBe(false);
    expect(cache.has("b", 15)).toBe(true);
    expect(cache.has("e", 15)).toBe(true);
    expect(() => new MemoryReplayCache({ maxEntries: 0 })).toThrow(RangeError);
  });
});
