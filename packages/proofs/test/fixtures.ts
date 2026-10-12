import { keccak256, stringToBytes, type Address } from "viem";
import { toBytes32, scopeTagOf } from "../src/field";
import {
  accountOlderThan,
  balanceAtLeast,
  canPayPerTx,
  createProofRequest,
  reputation,
  reservedFor,
  verifiedCompany,
  type ProofRequest,
  type Requirement,
} from "../src/request";
import { DISCLOSURE_CLASSES, disclosureMask, type Attribute } from "../src/schema";
import { buildWitness, ClaimsTree, identityCommitment, leafHash, type AttributeValues } from "../src/tree";
import type { RootInfo } from "../src/verifier";

/** Deterministic test world: one agent with a base leaf and a reservation leaf among other agents. */

export const SCOPE = "api.seller.example";
export const CHAIN_ID = 84532;
export const REGISTRY: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const ACCOUNT_ID = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const RESERVATION_ID = "prv_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const SNAPSHOT_AT = 1_760_000_000;
export const PUBLISHED_AT = SNAPSHOT_AT + 12;
export const VALID_UNTIL = SNAPSHOT_AT + 7_200;
export const NOW = SNAPSHOT_AT + 100;
export const EPOCH = 7n;
/** A public test key (never use it for anything real). */
export const GATE_KEY = "agentbank-test-gate-key-0123456789abcdef";

const derive = (label: string) => toBytes32(BigInt(keccak256(stringToBytes(label))) >> 8n);

/** A public test secret (31 bytes, so always a field element). */
export const AGENT_SECRET = derive("agentbank.proofs.test.agent-secret");

export const BASE_ATTRIBUTES: AttributeValues = {
  principal_verification: 2n,
  per_tx_limit: 25_000_000n,
  per_day_limit: 200_000_000n,
  balance: 1_250_000_000n,
  reserved_amount: 0n,
  reserved_until: 0n,
  reserved_for: 0n,
  account_created_on: 1_749_945_600n, // 2025-06-15, floored to the UTC day
  payments_settled: 42n,
  volume_settled: 1_337_000_000n,
  escrows_completed: 3n,
  disputes_lost: 0n,
  counterparties: 7n,
};

export const RESERVATION_ATTRIBUTES: AttributeValues = {
  ...BASE_ATTRIBUTES,
  reserved_amount: 500_000_000n,
  reserved_until: BigInt(NOW + 7_200),
  reserved_for: scopeTagOf(SCOPE),
};

export const FULL_MASK = disclosureMask(DISCLOSURE_CLASSES);

export interface Fixture {
  tree: ClaimsTree;
  mask: number;
  rootInfo: RootInfo;
  baseWitness: ReturnType<typeof buildWitness>;
  reservationWitness: ReturnType<typeof buildWitness>;
}

export function otherSecret(i: number): `0x${string}` {
  return derive(`agentbank.proofs.test.other-agent-${i}`);
}

/** Leaves: [agent base, agent reservation, other agents…]. */
export function buildFixture(options: { mask?: number; leafCount?: number; secret?: string } = {}): Fixture {
  const mask = options.mask ?? FULL_MASK;
  const leafCount = options.leafCount ?? 20;
  const identity = identityCommitment(options.secret ?? AGENT_SECRET);
  const leaves = [
    leafHash(identity, BASE_ATTRIBUTES, mask),
    leafHash(identity, RESERVATION_ATTRIBUTES, mask),
  ];
  for (let i = 2; i < leafCount; i++) {
    const attributes: Record<Attribute, bigint> = { ...BASE_ATTRIBUTES, payments_settled: BigInt(i) };
    leaves.push(leafHash(identityCommitment(otherSecret(i)), attributes, FULL_MASK));
  }
  const tree = new ClaimsTree(leaves);
  const common = {
    tree,
    disclosureMask: mask,
    accountId: ACCOUNT_ID,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    epoch: EPOCH,
    snapshotAt: SNAPSHOT_AT,
    validUntil: VALID_UNTIL,
  };
  return {
    tree,
    mask,
    rootInfo: {
      epoch: EPOCH,
      snapshotAt: SNAPSHOT_AT,
      publishedAt: PUBLISHED_AT,
      validUntil: VALID_UNTIL,
      leafCount,
      revoked: false,
    },
    baseWitness: buildWitness({ ...common, index: 0, attributes: BASE_ATTRIBUTES }),
    reservationWitness: buildWitness({
      ...common,
      index: 1,
      attributes: RESERVATION_ATTRIBUTES,
      reservationId: RESERVATION_ID,
    }),
  };
}

export const STANDARD_REQUIREMENTS: Requirement[] = [
  verifiedCompany(),
  canPayPerTx("5.00"),
  balanceAtLeast("1000.00"),
  reputation({ disputesLostAtMost: 0, paymentsSettled: 10 }),
  accountOlderThan(90),
];

export function standardRequest(
  overrides: Partial<Parameters<typeof createProofRequest>[0]> = {},
): ProofRequest {
  return createProofRequest({
    scope: SCOPE,
    require: STANDARD_REQUIREMENTS,
    now: NOW,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    requestId: "9f2c1b0e5a7d4c3b8e6f1a2b3c4d5e6f",
    nonce: `0x${"5e".repeat(31)}`,
    ...overrides,
  });
}

/** What the vector gate (and the gate tests) require: a reservation-backed request. */
export const GATE_REQUIREMENTS: Requirement[] = [
  verifiedCompany(),
  canPayPerTx("5.00"),
  reservedFor("500.00", { forSeconds: 3_600 }),
  reputation({ disputesLostAtMost: 0 }),
  accountOlderThan(90),
];

/** A root record as the vectors carry it (unix seconds; epoch as a string). */
export function rootInfoJson(info: RootInfo, root: string) {
  return {
    root,
    epoch: info.epoch.toString(),
    snapshot_at: info.snapshotAt,
    published_at: info.publishedAt,
    valid_until: info.validUntil,
    leaf_count: info.leafCount,
    revoked: info.revoked,
  };
}

export function rootInfoFromJson(json: {
  epoch: string;
  snapshot_at: number;
  published_at: number | null;
  valid_until: number;
  leaf_count: number;
  revoked: boolean;
}): RootInfo {
  return {
    epoch: BigInt(json.epoch),
    snapshotAt: json.snapshot_at,
    publishedAt: json.published_at,
    validUntil: json.valid_until,
    leafCount: json.leaf_count,
    revoked: json.revoked,
  };
}
