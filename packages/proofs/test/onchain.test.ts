import { existsSync, readFileSync } from "node:fs";
import { poseidon2 } from "poseidon-lite/poseidon2";
import * as snarkjs from "snarkjs";
import type { Abi, AbiFunction } from "viem";
import { formatAbiItem } from "viem/utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProofInputError, ProofRequestError } from "../src/errors";
import { fromBytes32, onchainScopeId, scopeField, toBytes32 } from "../src/field";
import {
  CLAIMS_VERIFIER_ABI,
  toClaimsVerifierArgs,
  type ClaimsVerifierArgs,
  type ClaimsVerifierProof,
} from "../src/onchain";
import { prove, toSolidityClaims, toSolidityProof } from "../src/prover";
import { createProofRequest, requestHash, reservedFor, verifiedCompany } from "../src/request";
import {
  publicSignals,
  releaseProverResources,
  VERIFICATION_KEY,
  verifyPresentation,
  type ProofPresentation,
} from "../src/verifier";
import { AGENT_SECRET, buildFixture, CHAIN_ID, NOW, REGISTRY, standardRequest } from "./fixtures";

/**
 * Proofs for an on-chain consumer: the request's scope is `onchainScopeId(chainId, consumer,
 * context)`, so the proof's scope signal is `AgentClaimsVerifier.scopeOf(consumer, context)` and
 * `toClaimsVerifierArgs` produces calldata the contract accepts. The consumer and context are the
 * contracts repository's claims fixtures' (test/fixtures/claims/*.json), whose scope its Solidity
 * tests check against `scopeOf` on chain 84532.
 */

const CONSUMER = "0x00000000000000000000000000000000000a11ce";
const CONTEXT = "0x2486d1ababe1b60da21be608aa2b9fe1abceb2d01942060a150b931230778e68";
/** scopeOf(CONSUMER, CONTEXT) on 84532 (contract fixture; equally keccak256(cast abi-encode …) mod r). */
const CONTRACT_SCOPE = 0x2fcdc29b33cc8a15e9649724756a35b3ef08688329524ef5966b3be044b00684n;
const SCOPE_ID = onchainScopeId(84532, CONSUMER, CONTEXT);

const fixture = buildFixture();
const onchainRequest = createProofRequest({
  scope: SCOPE_ID,
  require: [verifiedCompany()],
  now: NOW,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  requestId: "0123456789abcdef0123456789abcdef",
  nonce: `0x${"0c".repeat(31)}`,
});
let presentation: ProofPresentation;

/** The snarkjs proof and the 30 public signals that `AgentClaimsVerifier` rebuilds from its arguments. */
function snarkjsInputsOf({ claims, proof }: ClaimsVerifierArgs) {
  const signals = [
    claims.nullifier,
    fromBytes32(claims.root),
    claims.scope,
    claims.nonce,
    ...claims.mins,
    ...claims.maxs,
  ].map(String);
  const unswap = (pair: readonly [bigint, bigint]): [string, string] => [String(pair[1]), String(pair[0])];
  const groth16 = {
    pi_a: [String(proof.a[0]), String(proof.a[1]), "1"],
    pi_b: [unswap(proof.b[0]), unswap(proof.b[1]), ["1", "0"]],
    pi_c: [String(proof.c[0]), String(proof.c[1]), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
  return { signals, groth16 };
}

beforeAll(async () => {
  presentation = await prove({ secret: AGENT_SECRET, witness: fixture.baseWitness, request: onchainRequest });
});

afterAll(releaseProverResources);

describe("proofs for an on-chain scope id", () => {
  it("binds the proof to scopeOf(consumer, context) and verifies off-chain", async () => {
    expect(scopeField(SCOPE_ID)).toBe(CONTRACT_SCOPE);
    expect(publicSignals(onchainRequest, presentation)[2]).toBe(CONTRACT_SCOPE.toString());
    const result = await verifyPresentation({
      request: onchainRequest,
      presentation,
      rootInfo: fixture.rootInfo,
      now: NOW,
    });
    expect(result).toMatchObject({ valid: true, reason: null });
    // The nullifier is the agent's pseudonym for that consumer and context: Poseidon(secret, scope).
    expect(result.nullifier).toBe(toBytes32(poseidon2([fromBytes32(AGENT_SECRET), CONTRACT_SCOPE])));
    // The same proof does not verify for the HTTP scope string, nor for another context.
    for (const scope of [CONSUMER, onchainScopeId(84532, CONSUMER, `0x${"00".repeat(32)}`)]) {
      const other = { ...onchainRequest, scope };
      expect(
        await verifyPresentation({
          request: other,
          presentation: { ...presentation, request_hash: requestHash(other) },
          rootInfo: fixture.rootInfo,
          now: NOW,
        }),
      ).toMatchObject({ reason: "invalid_proof" });
    }
  });

  it("builds AgentClaimsVerifier arguments that verify against the same public signals", async () => {
    const args = toClaimsVerifierArgs(onchainRequest, presentation);
    expect(args.claims).toEqual({
      root: presentation.root,
      nullifier: fromBytes32(presentation.nullifier),
      scope: CONTRACT_SCOPE,
      nonce: BigInt(onchainRequest.nonce),
      mins: [2n, ...new Array<bigint>(12).fill(0n)],
      maxs: [2n, ...new Array<bigint>(12).fill(2n ** 64n - 1n)],
    });
    expect(args.claims.mins).toHaveLength(13);
    expect(args.claims.maxs).toHaveLength(13);
    expect(args.claims).toEqual(toSolidityClaims(onchainRequest, presentation));
    expect(args.proof).toEqual(toSolidityProof(presentation));

    // Exactly snarkjs's Solidity calldata for the request's public signals.
    const calldata = JSON.parse(
      `[${await snarkjs.groth16.exportSolidityCallData(presentation.proof, publicSignals(onchainRequest, presentation))}]`,
    ) as [string[], string[][], string[], string[]];
    expect(args.proof.a).toEqual(calldata[0].map(BigInt));
    expect(args.proof.b).toEqual(calldata[1].map((pair) => pair.map(BigInt)));
    expect(args.proof.c).toEqual(calldata[2].map(BigInt));
    const { signals, groth16 } = snarkjsInputsOf(args);
    expect(signals).toEqual(calldata[3].map((v) => BigInt(v).toString()));
    expect(signals).toEqual(publicSignals(onchainRequest, presentation));

    // And the Groth16 check the contract runs on these arguments succeeds.
    expect(await snarkjs.groth16.verify(VERIFICATION_KEY, signals, groth16)).toBe(true);
    const wrongNonce = snarkjsInputsOf({
      ...args,
      claims: { ...args.claims, nonce: args.claims.nonce + 1n },
    });
    expect(await snarkjs.groth16.verify(VERIFICATION_KEY, wrongNonce.signals, wrongNonce.groth16)).toBe(
      false,
    );
    const swapped: ClaimsVerifierProof = { ...args.proof, b: [args.proof.b[1], args.proof.b[0]] };
    const bad = snarkjsInputsOf({ ...args, proof: swapped });
    expect(await snarkjs.groth16.verify(VERIFICATION_KEY, bad.signals, bad.groth16)).toBe(false);
  });

  it("builds requests that tag reservations for the consumer", () => {
    const request = createProofRequest({
      scope: SCOPE_ID,
      require: [reservedFor("10.00", { until: NOW + 600 })],
      now: NOW,
    });
    expect(request.constraints.reserved_for).toEqual({
      min: (CONTRACT_SCOPE & (2n ** 64n - 1n)).toString(),
      max: (CONTRACT_SCOPE & (2n ** 64n - 1n)).toString(),
    });
  });

  it("refuses inputs that cannot be calldata for this request", () => {
    const http = standardRequest();
    expect(() => toClaimsVerifierArgs(http, presentation)).toThrow(ProofInputError);
    expect(() => toClaimsVerifierArgs(http, presentation)).toThrow(/request_hash/);
    expect(() => toClaimsVerifierArgs(onchainRequest, { ...presentation, root: "0x12" })).toThrow(
      ProofInputError,
    );
    expect(() => toClaimsVerifierArgs({ ...onchainRequest, nonce: "0x12" }, presentation)).toThrow(
      ProofRequestError,
    );
  });
});

describe("CLAIMS_VERIFIER_ABI", () => {
  const file = new URL("../../chain/src/abis/AgentClaimsVerifier.json", import.meta.url);

  it.skipIf(!existsSync(file))("is the contract's ABI (as synced into @agentbank/chain)", () => {
    const abi = JSON.parse(readFileSync(file, "utf8")) as Abi;
    for (const item of CLAIMS_VERIFIER_ABI) {
      const match = abi.find((x) => x.type === item.type && "name" in x && x.name === item.name);
      expect(match, item.name).toBeDefined();
      expect(formatAbiItem(match as Abi[number]), item.name).toBe(formatAbiItem(item));
      if (item.type === "function") {
        const fn = match as AbiFunction;
        expect(fn.stateMutability).toBe(item.stateMutability);
        expect(fn.outputs.map((o) => o.type)).toEqual(item.outputs.map((o) => o.type));
      }
      if (item.type === "event" && match?.type === "event") {
        expect(match.inputs.map((i) => Boolean(i.indexed))).toEqual(item.inputs.map((i) => i.indexed));
      }
    }
  });
});
