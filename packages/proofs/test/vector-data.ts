import { bytesToHex, canonicalJson, utf8 } from "@agentbank/core";
import type { Address, Hex } from "viem";
import { onchainScope, scopeField, scopeTag, toBytes32 } from "../src/field";
import { gateNonce } from "../src/http";
import {
  accountOlderThan,
  balanceAtLeast,
  bounds,
  canPayPerDay,
  canPayPerTx,
  createProofRequest,
  parseBoundValue,
  reputation,
  requestHash,
  reservedFor,
  spendingCappedAt,
  verifiedCompany,
  verifiedPrincipal,
  type ProofRequest,
} from "../src/request";
import {
  ATTRIBUTES,
  CLASS_ATTRIBUTES,
  CLAIMS_SCHEMA,
  DISCLOSURE_CLASSES,
  disclosureMask,
  MAX_U64,
  SNARK_SCALAR_FIELD,
  TREE_DEPTH,
  type Attribute,
} from "../src/schema";
import { attributesHash, identityCommitment, leafHash, zeroHashes } from "../src/tree";
import {
  AGENT_SECRET,
  BASE_ATTRIBUTES,
  buildFixture,
  CHAIN_ID,
  GATE_KEY,
  NOW,
  otherSecret,
  REGISTRY,
  RESERVATION_ATTRIBUTES,
  SCOPE,
} from "./fixtures";

/**
 * The deterministic part of test/vectors/proofs.json (everything except the Groth16 proof and
 * the gate-issued request it answers). `scripts/generate-vectors.ts` writes it; the vectors test
 * recomputes it and compares, so a change in any derivation fails CI.
 */

const dec = (v: bigint) => v.toString();

function requestCase(name: string, request: ProofRequest) {
  const { mins, maxs } = bounds(request);
  return {
    name,
    request,
    canonical_json: canonicalJson(request),
    request_hash: requestHash(request),
    mins: mins.map(dec),
    maxs: maxs.map(dec),
  };
}

const fixed = {
  scope: SCOPE,
  now: NOW,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  nonce: `0x${"5e".repeat(31)}` as Hex,
  requestId: "9f2c1b0e5a7d4c3b8e6f1a2b3c4d5e6f",
};

function attributeRecord(values: Readonly<Record<Attribute, bigint>>): Record<string, string> {
  return Object.fromEntries(ATTRIBUTES.map((a) => [a, dec(values[a])]));
}

export function deterministicVectors() {
  const scopes = [
    "api.seller.example",
    "a",
    "localhost",
    "tools.example.com",
    "x".repeat(253),
    "bücher.example",
  ].map((scopeId) => {
    const scope = scopeField(scopeId);
    return {
      scope_id: scopeId,
      scope: dec(scope),
      scope_bytes32: toBytes32(scope),
      tag: dec(scopeTag(scope)),
    };
  });

  const onchain = (
    [
      [84532, "0x1111111111111111111111111111111111111111", `0x${"00".repeat(32)}`],
      [
        84532,
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        `0x${"6d61726b6574706c6163652e61646d697373696f6e"}${"00".repeat(11)}`,
      ],
      [31337, "0x5FbDB2315678afecb367f032d93F642f64180aa3", `0x${"ff".repeat(32)}`],
    ] as [number, Address, Hex][]
  ).map(([chainId, consumer, context]) => {
    const scope = onchainScope(chainId, consumer, context);
    return { chain_id: chainId, consumer, context, scope: dec(scope), tag: dec(scopeTag(scope)) };
  });

  const moneyBounds = [
    "0",
    "5",
    "5.5",
    "5.00",
    "0.000001",
    "1000000.123456",
    "18446744073709.551615",
    "5.0000001",
    "05",
    "1e3",
    " 5",
    "-1",
    "5.",
    ".5",
    "18446744073709.551616",
  ].map((value) => {
    try {
      return { attribute: "per_tx_limit", value, minor: dec(parseBoundValue("per_tx_limit", value)) };
    } catch {
      return { attribute: "per_tx_limit", value, error: true };
    }
  });

  const integerBounds = [
    "0",
    "42",
    "18446744073709551615",
    "18446744073709551616",
    "1.5",
    "01",
    "-1",
    "0x10",
  ].map((value) => {
    try {
      return {
        attribute: "payments_settled",
        value,
        value_parsed: dec(parseBoundValue("payments_settled", value)),
      };
    } catch {
      return { attribute: "payments_settled", value, error: true };
    }
  });

  const requests = [
    requestCase("empty", createProofRequest({ ...fixed })),
    requestCase(
      "standard",
      createProofRequest({
        ...fixed,
        require: [
          verifiedCompany(),
          canPayPerTx("5.00"),
          balanceAtLeast("1000.00"),
          reputation({ disputesLostAtMost: 0, paymentsSettled: 10 }),
          accountOlderThan(90),
        ],
      }),
    ),
    requestCase(
      "every_kind",
      createProofRequest({
        ...fixed,
        require: [
          verifiedPrincipal(), // enum
          canPayPerTx("2.5"), // money, normalized to "2.50"
          canPayPerDay("100"),
          spendingCappedAt({ perTx: "250.000001", perDay: "1000" }),
          balanceAtLeast("0.000001"),
          reservedFor("500.00", { until: NOW + 3_600 }), // money, timestamp, integer (tag)
          accountOlderThan(30), // timestamp
          reputation({
            paymentsSettled: 10,
            volumeSettled: "1234.5",
            escrowsCompleted: 2,
            disputesLostAtMost: 1,
            counterparties: 3,
          }),
        ],
      }),
    ),
    requestCase(
      "intersected",
      createProofRequest({
        ...fixed,
        require: [verifiedPrincipal(), verifiedCompany(), canPayPerTx("1"), canPayPerTx("3")],
      }),
    ),
  ];

  const base = requests[1]?.request as ProofRequest;
  const invalidRequests = [
    { name: "unknown_attribute", constraints: { shoe_size: { min: "1" } } },
    { name: "min_greater_than_max", constraints: { balance: { min: "10.00", max: "9.99" } } },
    { name: "fractional_integer", constraints: { payments_settled: { min: "1.5" } } },
    { name: "too_many_decimals", constraints: { balance: { min: "1.0000001" } } },
    { name: "above_u64", constraints: { counterparties: { min: "18446744073709551616" } } },
    { name: "money_above_u64", constraints: { volume_settled: { min: "18446744073709.551616" } } },
    { name: "unknown_bound_key", constraints: { balance: { at_least: "1" } } },
  ].map(({ name, constraints }) => ({ name, request: { ...base, constraints } }));

  const keyBytes = utf8(GATE_KEY);
  const gateCases = [requests[0], requests[1], requests[2]].map((c) => {
    const { nonce: _nonce, ...withoutNonce } = c?.request as ProofRequest;
    return {
      request_without_nonce: withoutNonce,
      canonical_json: canonicalJson(withoutNonce),
      nonce: gateNonce(GATE_KEY, withoutNonce),
    };
  });

  const fixture = buildFixture();
  const masks = [
    [],
    ["principal"],
    ["limits"],
    ["balance"],
    ["reservations"],
    ["account_age"],
    ["reputation"],
    ["principal", "limits", "reputation"],
    [...DISCLOSURE_CLASSES],
  ].map((classes) => ({ classes, mask: disclosureMask(classes as (typeof DISCLOSURE_CLASSES)[number][]) }));

  const identity = identityCommitment(AGENT_SECRET);
  const leafCases = [
    { secret: AGENT_SECRET, attributes: BASE_ATTRIBUTES, mask: fixture.mask },
    { secret: AGENT_SECRET, attributes: RESERVATION_ATTRIBUTES, mask: fixture.mask },
    { secret: otherSecret(2), attributes: { ...BASE_ATTRIBUTES, payments_settled: 2n }, mask: fixture.mask },
    { secret: AGENT_SECRET, attributes: BASE_ATTRIBUTES, mask: disclosureMask(["principal", "limits"]) },
  ].map(({ secret, attributes, mask }) => {
    const id = identityCommitment(secret);
    return {
      secret,
      identity_commitment: toBytes32(id),
      attributes: attributeRecord(attributes),
      mask,
      attributes_hash: dec(attributesHash(attributes, mask)),
      leaf: dec(leafHash(id, attributes, mask)),
    };
  });

  return {
    description:
      "Agent Bank private proofs cross-language vectors (schema agentbank.claims.v1). Secrets and keys here are public test values; never use them for anything real.",
    schema: CLAIMS_SCHEMA,
    constants: {
      snark_scalar_field: dec(SNARK_SCALAR_FIELD),
      max_u64: dec(MAX_U64),
      tree_depth: TREE_DEPTH,
      attributes: [...ATTRIBUTES],
      disclosure_classes: CLASS_ATTRIBUTES,
      scope_domain: "agentbank.proofs.scope.v1",
    },
    disclosure_masks: masks,
    scopes,
    onchain_scopes: onchain,
    money_bounds: moneyBounds,
    integer_bounds: integerBounds,
    requests,
    invalid_requests: invalidRequests,
    gate_nonces: { key_utf8: GATE_KEY, key_hex: bytesToHex(keyBytes), cases: gateCases },
    poseidon: {
      identity: { secret: AGENT_SECRET, identity_commitment: toBytes32(identity) },
      leaves: leafCases,
    },
    tree: {
      depth: TREE_DEPTH,
      zero_hashes: zeroHashes().map(dec),
      leaves: Array.from({ length: fixture.tree.size }, (_, i) => dec(fixture.tree.leaf(i))),
      root: toBytes32(fixture.tree.root),
      witnesses: [0, 1, 7, fixture.tree.size - 1].map((index) => {
        const { siblings, pathBits } = fixture.tree.witness(index);
        return {
          index,
          leaf: dec(fixture.tree.leaf(index)),
          siblings: siblings.map(dec),
          path_bits: pathBits,
        };
      }),
    },
  };
}
