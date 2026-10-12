import { ProofWitness } from "@agentbank/core/api";
import fc from "fast-check";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon14 } from "poseidon-lite/poseidon14";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { describe, expect, it } from "vitest";
import { fromBytes32, toBytes32 } from "../src/field";
import { ATTRIBUTES, SNARK_SCALAR_FIELD, TREE_DEPTH } from "../src/schema";
import {
  attributesHash,
  attributeVector,
  buildWitness,
  ClaimsTree,
  computeRoot,
  generateProofSecret,
  identityCommitment,
  leafHash,
  parseSecret,
  verifyWitness,
  zeroHashes,
} from "../src/tree";
import { AGENT_SECRET, BASE_ATTRIBUTES, buildFixture, FULL_MASK } from "./fixtures";

/** Reference: hash a full, padded level by level. */
function naiveRoot(leaves: bigint[], depth: number): bigint {
  let level = [...leaves, ...new Array<bigint>(2 ** depth - leaves.length).fill(0n)];
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(poseidon2([level[i] as bigint, level[i + 1] as bigint]));
    level = next;
  }
  return level[0] as bigint;
}

const field = fc.bigInt({ min: 0n, max: SNARK_SCALAR_FIELD - 1n });

describe("Poseidon leaves", () => {
  it("hashes exactly like the circuit", () => {
    const identity = identityCommitment(AGENT_SECRET);
    expect(identity).toBe(poseidon1([fromBytes32(AGENT_SECRET)]));
    const values = ATTRIBUTES.map((a) => BASE_ATTRIBUTES[a]);
    const attrHash = poseidon14([...values, BigInt(FULL_MASK)]);
    expect(attributesHash(BASE_ATTRIBUTES, FULL_MASK)).toBe(attrHash);
    expect(leafHash(identity, BASE_ATTRIBUTES, FULL_MASK)).toBe(poseidon2([identity, attrHash]));
    // string values (the witness wire form) hash the same
    const strings = Object.fromEntries(ATTRIBUTES.map((a) => [a, BASE_ATTRIBUTES[a].toString()]));
    expect(attributesHash(strings as never, FULL_MASK)).toBe(attrHash);
    // known circomlib vector
    expect(poseidon2([1n, 2n])).toBe(
      7853200120776062878684798364095072458815029376092732009249414926327459813530n,
    );
  });

  it("validates secrets, attributes and masks", () => {
    const secret = generateProofSecret();
    expect(secret).toMatch(/^0x00[0-9a-f]{62}$/);
    expect(parseSecret(secret)).toBe(fromBytes32(secret));
    expect(() => parseSecret("0x0")).toThrow(/non-zero/);
    expect(() => parseSecret(`0x${"ff".repeat(32)}`)).toThrow(RangeError);
    expect(() => attributeVector({ ...BASE_ATTRIBUTES, balance: -1n })).toThrow(/balance/);
    expect(() => attributeVector({ ...BASE_ATTRIBUTES, balance: 1n << 64n })).toThrow(/balance/);
    expect(() => attributeVector({ ...BASE_ATTRIBUTES, balance: "1.5" } as never)).toThrow(/balance/);
    const { balance: _b, ...missing } = BASE_ATTRIBUTES;
    expect(() => attributeVector(missing as never)).toThrow(/balance is missing/);
    expect(() => attributesHash(BASE_ATTRIBUTES, 8192)).toThrow(/mask/);
    expect(() => attributesHash(BASE_ATTRIBUTES, 0.5)).toThrow(/mask/);
  });
});

describe("ClaimsTree", () => {
  it("builds zero hashes from zero leaves", () => {
    const zeros = zeroHashes();
    expect(zeros).toHaveLength(TREE_DEPTH + 1);
    expect(zeros[0]).toBe(0n);
    expect(zeros[1]).toBe(poseidon2([0n, 0n]));
    expect(zeroHashes()).toBe(zeros);
    expect(new ClaimsTree([]).root).toBe(zeros[TREE_DEPTH]);
  });

  it("matches a naive padded tree and serves valid paths for every leaf", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(field, { minLength: 1, maxLength: 32 }),
        (depth, raw) => {
          const leaves = raw.slice(0, 2 ** depth);
          const tree = new ClaimsTree(leaves, depth);
          expect(tree.root).toBe(naiveRoot(leaves, depth));
          expect(tree.size).toBe(leaves.length);
          leaves.forEach((leaf, i) => {
            expect(tree.leaf(i)).toBe(leaf);
            const { siblings, pathBits } = tree.witness(i);
            expect(siblings).toHaveLength(depth);
            expect(verifyWitness(leaf, siblings, pathBits, tree.root)).toBe(true);
            expect(pathBits.reduce<number>((acc, bit, level) => acc + bit * 2 ** level, 0)).toBe(i);
          });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("rejects bad shapes, indexes and paths", () => {
    expect(() => new ClaimsTree([], 0)).toThrow(RangeError);
    expect(() => new ClaimsTree([1n, 2n, 3n], 1)).toThrow(/at most/);
    expect(() => new ClaimsTree([SNARK_SCALAR_FIELD])).toThrow(RangeError);
    const tree = new ClaimsTree([1n, 2n, 3n]);
    expect(() => tree.witness(3)).toThrow(/out of range/);
    expect(() => tree.leaf(-1)).toThrow(/out of range/);
    const { siblings, pathBits } = tree.witness(2);
    expect(computeRoot(3n, siblings, pathBits)).toBe(tree.root);
    expect(verifyWitness(4n, siblings, pathBits, tree.root)).toBe(false);
    expect(verifyWitness(3n, siblings, [2, ...pathBits.slice(1)], tree.root)).toBe(false);
    expect(() => computeRoot(3n, siblings, pathBits.slice(1))).toThrow(/length/);
  });

  it("builds API witnesses that match the contract", () => {
    const fixture = buildFixture();
    const witness = fixture.reservationWitness;
    expect(ProofWitness.parse(witness)).toEqual(witness);
    expect(witness.root).toBe(toBytes32(fixture.tree.root));
    expect(witness.leaf_index).toBe(1);
    expect(witness.reservation_id).toMatch(/^prv_/);
    expect(fixture.baseWitness.reservation_id).toBeNull();
    expect(() =>
      buildWitness({
        tree: fixture.tree,
        index: 0,
        attributes: BASE_ATTRIBUTES,
        disclosureMask: -1,
        accountId: "acct_x",
        chainId: 1,
        registry: null,
        epoch: 1,
        snapshotAt: 0,
        validUntil: 1,
      }),
    ).toThrow(/mask/);
  });
});
