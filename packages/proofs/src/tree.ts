import { bytesToHex, randomBytes } from "@agentbank/core";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon14 } from "poseidon-lite/poseidon14";
import { poseidon2 } from "poseidon-lite/poseidon2";
import type { Hex } from "viem";
import { toBytes32, toField } from "./field";
import type { ProofWitness } from "./request";
import {
  ATTRIBUTES,
  CLAIMS_SCHEMA,
  FULL_DISCLOSURE_MASK,
  MAX_U64,
  TREE_DEPTH,
  type Attribute,
} from "./schema";

/**
 * The attested-facts tree (schema agentbank.claims.v1), exactly as the circuit hashes it:
 *
 *     identity = Poseidon(secret)
 *     leaf     = Poseidon(identity, Poseidon(attributes[0..12], mask))
 *     node     = Poseidon(left, right)
 *
 * Depth 20; empty subtrees hash from zero leaves (zero[0] = 0, zero[i+1] = Poseidon(zero[i],
 * zero[i])); `pathBits[i] = 1` when the node at level i is a right child.
 */

/** Attribute values in raw units (USDC minor units, unix seconds), each in [0, 2^64 - 1]. */
export type AttributeValues = Readonly<Record<Attribute, bigint>>;

export interface MerklePath {
  /** Sibling hashes from the leaf level up. */
  siblings: bigint[];
  /** 1 when the node at that level is a right child. */
  pathBits: (0 | 1)[];
}

/**
 * A fresh proof secret: 31 random bytes (always a field element), as 32-byte hex. Keep it
 * secret: whoever holds it can prove as the agent.
 */
export function generateProofSecret(): Hex {
  return toBytes32(BigInt(bytesToHex(randomBytes(31))));
}

/** Parse a secret (bytes32 hex, any 0x hex up to 32 bytes, or bigint); must be a non-zero field element. */
export function parseSecret(secret: Hex | string | bigint): bigint {
  const value = toField(secret);
  if (value === 0n) throw new RangeError("the proof secret must be non-zero");
  return value;
}

/** identity = Poseidon(secret): the commitment an agent enrolls. */
export function identityCommitment(secret: Hex | string | bigint): bigint {
  return poseidon1([parseSecret(secret)]);
}

/** The 13 attribute values in circuit order, range-checked. */
export function attributeVector(values: Readonly<Record<Attribute, bigint | string>>): bigint[] {
  return ATTRIBUTES.map((a) => {
    const raw = values[a];
    if (raw === undefined) throw new RangeError(`attribute ${a} is missing`);
    const value = typeof raw === "bigint" ? raw : /^(0|[1-9][0-9]*)$/.test(raw) ? BigInt(raw) : -1n;
    if (value < 0n || value > MAX_U64)
      throw new RangeError(`attribute ${a} must be an integer in [0, 2^64 - 1]`);
    return value;
  });
}

function checkMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || mask > FULL_DISCLOSURE_MASK) {
    throw new RangeError("disclosure mask must be an integer in [0, 8191]");
  }
}

/** Poseidon(attributes[0..12], mask). */
export function attributesHash(values: Readonly<Record<Attribute, bigint | string>>, mask: number): bigint {
  checkMask(mask);
  return poseidon14([...attributeVector(values), BigInt(mask)]);
}

/** Poseidon(identity, Poseidon(attributes, mask)). */
export function leafHash(
  identity: bigint,
  values: Readonly<Record<Attribute, bigint | string>>,
  mask: number,
): bigint {
  return poseidon2([toField(identity), attributesHash(values, mask)]);
}

/** Poseidon(left, right). */
export function hashPair(left: bigint, right: bigint): bigint {
  return poseidon2([left, right]);
}

const zeroCache = new Map<number, readonly bigint[]>();

/** zero[0..depth]: the hash of an empty subtree at each level. */
export function zeroHashes(depth: number = TREE_DEPTH): readonly bigint[] {
  const cached = zeroCache.get(depth);
  if (cached) return cached;
  const zeros = [0n];
  for (let i = 0; i < depth; i++) zeros.push(hashPair(zeros[i] as bigint, zeros[i] as bigint));
  zeroCache.set(depth, zeros);
  return zeros;
}

/** Fold a leaf up its Merkle path. */
export function computeRoot(leaf: bigint, siblings: readonly bigint[], pathBits: readonly number[]): bigint {
  if (siblings.length !== pathBits.length) throw new RangeError("siblings and pathBits differ in length");
  let node = leaf;
  siblings.forEach((sibling, i) => {
    const bit = pathBits[i];
    if (bit !== 0 && bit !== 1) throw new RangeError("path bits must be 0 or 1");
    node = bit === 1 ? hashPair(sibling, node) : hashPair(node, sibling);
  });
  return node;
}

/** Whether `leaf` with this path hashes to `root`. */
export function verifyWitness(
  leaf: bigint,
  siblings: readonly bigint[],
  pathBits: readonly number[],
  root: bigint,
): boolean {
  try {
    return computeRoot(leaf, siblings, pathBits) === root;
  } catch {
    return false;
  }
}

/**
 * A depth-20 Poseidon Merkle tree over a list of leaves (index 0 leftmost). Only the occupied
 * part of each level is stored; missing nodes are the zero hashes.
 */
export class ClaimsTree {
  readonly depth: number;
  private readonly levels: bigint[][];

  constructor(leaves: readonly bigint[], depth: number = TREE_DEPTH) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw new RangeError("depth must be 1 to 32");
    if (leaves.length > 2 ** depth)
      throw new RangeError(`a depth-${depth} tree holds at most 2^${depth} leaves`);
    this.depth = depth;
    const zeros = zeroHashes(depth);
    const levels: bigint[][] = [leaves.map((leaf) => toField(leaf))];
    for (let level = 0; level < depth; level++) {
      const nodes = levels[level] as bigint[];
      const next: bigint[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(hashPair(nodes[i] as bigint, nodes[i + 1] ?? (zeros[level] as bigint)));
      }
      levels.push(next);
    }
    this.levels = levels;
  }

  /** Number of leaves. */
  get size(): number {
    return (this.levels[0] as bigint[]).length;
  }

  get root(): bigint {
    return this.levels[this.depth]?.[0] ?? (zeroHashes(this.depth)[this.depth] as bigint);
  }

  leaf(index: number): bigint {
    this.checkIndex(index);
    return (this.levels[0] as bigint[])[index] as bigint;
  }

  /** The Merkle path of leaf `index`. */
  witness(index: number): MerklePath {
    this.checkIndex(index);
    const zeros = zeroHashes(this.depth);
    const siblings: bigint[] = [];
    const pathBits: (0 | 1)[] = [];
    let position = index;
    for (let level = 0; level < this.depth; level++) {
      const nodes = this.levels[level] as bigint[];
      siblings.push(nodes[position ^ 1] ?? (zeros[level] as bigint));
      pathBits.push((position & 1) as 0 | 1);
      position >>= 1;
    }
    return { siblings, pathBits };
  }

  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(`leaf index ${index} is out of range`);
    }
  }
}

export interface BuildWitnessArgs {
  tree: ClaimsTree;
  index: number;
  attributes: Readonly<Record<Attribute, bigint | string>>;
  disclosureMask: number;
  accountId: string;
  chainId: number;
  registry: Hex | null;
  epoch: bigint | number;
  /** Unix seconds. */
  snapshotAt: number;
  /** Unix seconds. */
  validUntil: number;
  reservationId?: string | null;
}

/**
 * The `ProofWitness` (API wire shape) for leaf `index` of `tree`. Pass the attributes and mask
 * the leaf was built from (`leafHash(identity, attributes, mask)`); the tree cannot check them,
 * but the prover refuses a witness whose values do not hash to its root.
 */
export function buildWitness(args: BuildWitnessArgs): ProofWitness {
  const values = attributeVector(args.attributes);
  checkMask(args.disclosureMask);
  const { siblings, pathBits } = args.tree.witness(args.index);
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return {
    object: "proof_witness",
    schema: CLAIMS_SCHEMA,
    account_id: args.accountId,
    chain_id: args.chainId,
    registry: args.registry,
    root: toBytes32(args.tree.root),
    epoch: BigInt(args.epoch).toString(),
    snapshot_at: iso(args.snapshotAt),
    valid_until: iso(args.validUntil),
    leaf_count: args.tree.size,
    leaf_index: args.index,
    siblings: siblings.map((s) => s.toString()),
    path_bits: pathBits,
    attributes: Object.fromEntries(ATTRIBUTES.map((a, i) => [a, (values[i] as bigint).toString()])) as Record<
      Attribute,
      string
    >,
    disclosure_mask: args.disclosureMask,
    reservation_id: args.reservationId ?? null,
  };
}
