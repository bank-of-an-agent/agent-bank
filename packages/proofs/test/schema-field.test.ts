import { usdc } from "@agentbank/core";
import { DISCLOSURE_CLASSES as API_CLASSES, PROOF_ATTRIBUTES } from "@agentbank/core/api";
import fc from "fast-check";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/artifacts";
import {
  fromBytes32,
  isOnchainScopeId,
  nonceField,
  onchainScope,
  onchainScopeId,
  parseOnchainScopeId,
  randomNonce,
  scopeField,
  scopeTag,
  scopeTagOf,
  toBytes32,
  toField,
} from "../src/field";
import {
  ATTRIBUTE_INFO,
  ATTRIBUTES,
  CLASS_ATTRIBUTES,
  classesFromMask,
  DISCLOSURE_CLASSES,
  disclosureMask,
  FULL_DISCLOSURE_MASK,
  isAttribute,
  isDisclosed,
  isDisclosureClass,
  MAX_U64,
  PUBLIC_SIGNAL_COUNT,
  SNARK_SCALAR_FIELD,
  TREE_DEPTH,
} from "../src/schema";

describe("schema agentbank.claims.v1", () => {
  it("matches the circuit manifest and the API contract", () => {
    const manifest = loadManifest();
    expect([...ATTRIBUTES]).toEqual(manifest.attributes);
    expect([...ATTRIBUTES]).toEqual([...PROOF_ATTRIBUTES]);
    expect([...DISCLOSURE_CLASSES]).toEqual([...API_CLASSES]);
    expect(manifest.tree_depth).toBe(TREE_DEPTH);
    expect(manifest.public_signals).toHaveLength(PUBLIC_SIGNAL_COUNT);
    ATTRIBUTES.forEach((a, i) => expect(ATTRIBUTE_INFO[a].index).toBe(i));
  });

  it("maps classes to the attributes in the design doc", () => {
    expect(CLASS_ATTRIBUTES).toEqual({
      principal: ["principal_verification"],
      limits: ["per_tx_limit", "per_day_limit"],
      balance: ["balance"],
      reservations: ["reserved_amount", "reserved_until", "reserved_for"],
      account_age: ["account_created_on"],
      reputation: [
        "payments_settled",
        "volume_settled",
        "escrows_completed",
        "disputes_lost",
        "counterparties",
      ],
    });
    expect(disclosureMask(DISCLOSURE_CLASSES)).toBe(FULL_DISCLOSURE_MASK);
    expect(disclosureMask([])).toBe(0);
    expect(disclosureMask(["principal"])).toBe(1);
    expect(disclosureMask(["limits"])).toBe(0b110);
    expect(disclosureMask(["reputation"])).toBe(0b1_1111_0000_0000);
    expect(() => disclosureMask(["everything" as never])).toThrow(RangeError);
  });

  it("round-trips class sets through masks", () => {
    fc.assert(
      fc.property(fc.subarray([...DISCLOSURE_CLASSES]), (classes) => {
        const mask = disclosureMask(classes);
        expect(classesFromMask(mask)).toEqual(classes);
        for (const a of ATTRIBUTES) {
          expect(isDisclosed(mask, a)).toBe(classes.includes(ATTRIBUTE_INFO[a].disclosureClass));
        }
      }),
    );
    expect(() => classesFromMask(0b10)).toThrow(/part of a class/);
    expect(() => classesFromMask(8192)).toThrow(/13-bit/);
    expect(() => classesFromMask(-1)).toThrow(/13-bit/);
    expect(() => classesFromMask(1.5)).toThrow(/13-bit/);
    expect(isAttribute("balance")).toBe(true);
    expect(isAttribute("shoe_size")).toBe(false);
    expect(isAttribute(3)).toBe(false);
    expect(isDisclosureClass("limits")).toBe(true);
    expect(isDisclosureClass("everything")).toBe(false);
  });
});

describe("field elements and scopes", () => {
  it("derives HTTP scopes as keccak256(domain:scope) mod r (Foundry cast values)", () => {
    // cast keccak "agentbank.proofs.scope.v1:api.seller.example"
    expect(scopeField("api.seller.example")).toBe(
      7783571142662378032774545842123794300551940069470764337997240928210660770474n,
    );
    expect(scopeTagOf("api.seller.example")).toBe(2421086520919343786n);
    expect(scopeTag(scopeField("api.seller.example"))).toBe(2421086520919343786n);
    expect(() => scopeField("")).toThrow(RangeError);
    expect(() => scopeField("x".repeat(254))).toThrow(RangeError);
    expect(scopeField("x".repeat(253))).toBeLessThan(SNARK_SCALAR_FIELD);
  });

  it("derives on-chain scopes exactly like AgentClaimsVerifier.scopeOf", () => {
    // keccak256(cast abi-encode "f(string,uint256,address,bytes32)" "agentbank.proofs.scope.v1" …) mod r
    expect(onchainScope(84532, "0x1111111111111111111111111111111111111111", `0x${"00".repeat(32)}`)).toBe(
      21482666919260453620420798196477083178592613803978780111850912605372212387887n,
    );
    expect(
      onchainScope(
        84532n,
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "0x6d61726b6574706c6163652e61646d697373696f6e0000000000000000000000",
      ),
    ).toBe(8338455469655313161674516697628120586825752578463344819921474319005652670853n);
    const scope = onchainScope(31337, "0x5FbDB2315678afecb367f032d93F642f64180aa3", `0x${"ff".repeat(32)}`);
    expect(scope).toBe(12161478115592592256132410248367640299681992441465266964312437898907801951678n);
    expect(scopeTag(scope)).toBe(12905285381166013886n);
    expect(() => onchainScope(1, "0x1111111111111111111111111111111111111111", "0x00")).toThrow(RangeError);
  });

  it("maps on-chain scope ids to AgentClaimsVerifier.scopeOf (Foundry cast and contract fixture values)", () => {
    // The contracts repository's test/fixtures/claims/*.json scope, which its Solidity tests check
    // against scopeOf(consumer, context) on chain 84532; equally
    //   cast keccak $(cast abi-encode "f(string,uint256,address,bytes32)" "agentbank.proofs.scope.v1" \
    //     84532 0x00000000000000000000000000000000000a11ce 0x2486…8e68)   (mod r)
    const id = onchainScopeId(
      84532,
      "0x00000000000000000000000000000000000A11CE",
      "0x2486D1ABABE1B60DA21BE608AA2B9FE1ABCEB2D01942060A150B931230778E68",
    );
    expect(id).toBe(
      "eip155:84532:0x00000000000000000000000000000000000a11ce:0x2486d1ababe1b60da21be608aa2b9fe1abceb2d01942060a150b931230778e68",
    );
    expect(toBytes32(scopeField(id))).toBe(
      "0x2fcdc29b33cc8a15e9649724756a35b3ef08688329524ef5966b3be044b00684",
    );
    expect(scopeTagOf(id)).toBe(10838822762608330372n);
    const cases: [number | bigint, `0x${string}`, `0x${string}`, bigint][] = [
      [
        84532,
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "0x6d61726b6574706c6163652e61646d697373696f6e0000000000000000000000",
        8338455469655313161674516697628120586825752578463344819921474319005652670853n,
      ],
      [
        31337n,
        "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        `0x${"ff".repeat(32)}`,
        12161478115592592256132410248367640299681992441465266964312437898907801951678n,
      ],
    ];
    for (const [chainId, consumer, context, expected] of cases) {
      const scopeId = onchainScopeId(chainId, consumer, context);
      expect(scopeField(scopeId)).toBe(expected);
      expect(scopeField(scopeId)).toBe(onchainScope(chainId, consumer, context));
      // Case-insensitive: any spelling of the address and context is the same scope.
      expect(scopeField(scopeId.toUpperCase().replace("EIP155", "eip155").replace(/0X/g, "0x"))).toBe(
        expected,
      );
      expect(parseOnchainScopeId(scopeId)).toEqual({
        chainId: BigInt(chainId),
        consumer,
        context: context.toLowerCase(),
      });
      expect(isOnchainScopeId(scopeId)).toBe(true);
    }
  });

  it("treats anything but the exact on-chain form as a string scope", () => {
    const consumer = "0x1111111111111111111111111111111111111111";
    const context = `0x${"ab".repeat(32)}`;
    const stringScope = (id: string) =>
      BigInt(keccak256(stringToBytes(`agentbank.proofs.scope.v1:${id}`))) % SNARK_SCALAR_FIELD;
    for (const id of [
      `eip155:0:${consumer}:${context}`, // chain id 0
      `eip155:084532:${consumer}:${context}`, // leading zero
      `eip155:${"9".repeat(33)}:${consumer}:${context}`, // more than 32 digits
      `EIP155:84532:${consumer}:${context}`, // namespace case
      `eip155:84532:${consumer.slice(0, -2)}:${context}`, // 19-byte address
      `eip155:84532:${consumer}:${context.slice(0, -2)}`, // 31-byte context
      `eip155:84532:${consumer.slice(2)}:${context}`, // no 0x
      `eip155:84532:${consumer}:${context}:extra`,
      ` eip155:84532:${consumer}:${context}`,
      `eip155:84532:${consumer}`,
      "api.seller.example",
    ]) {
      expect(isOnchainScopeId(id), id).toBe(false);
      expect(parseOnchainScopeId(id), id).toBeNull();
      expect(scopeField(id), id).toBe(stringScope(id));
    }
    expect(parseOnchainScopeId(42 as unknown as string)).toBeNull();
    // The longest on-chain scope id fits a request's 253-character scope.
    expect(onchainScopeId(10n ** 32n - 1n, consumer, context)).toHaveLength(7 + 32 + 1 + 42 + 1 + 66);
    for (const [chainId, who, ctx] of [
      [0, consumer, context],
      [-1n, consumer, context],
      [1.5, consumer, context],
      [10n ** 32n, consumer, context],
      [1, "0x1234", context],
      [1, consumer, "0x00"],
      [1, 7, context],
    ] as [number | bigint, string, string][]) {
      expect(() => onchainScopeId(chainId, who, ctx)).toThrow(RangeError);
    }
  });

  it("converts bytes32 and field elements", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: SNARK_SCALAR_FIELD - 1n }), (v) => {
        expect(fromBytes32(toBytes32(v))).toBe(v);
        expect(toField(toBytes32(v))).toBe(v);
        expect(toField(v.toString())).toBe(v);
      }),
    );
    expect(toBytes32(255n)).toBe(`0x${"0".repeat(62)}ff`);
    expect(() => toBytes32(-1n)).toThrow(RangeError);
    expect(() => toBytes32(1n << 256n)).toThrow(RangeError);
    expect(() => fromBytes32("0x1234")).toThrow(RangeError);
    expect(toField("0x1")).toBe(1n);
    expect(() => toField(SNARK_SCALAR_FIELD)).toThrow(/field order/);
    expect(() => toField("-1")).toThrow(RangeError);
    expect(() => toField("1".repeat(79))).toThrow(RangeError);
    expect(() => toField("zz")).toThrow(RangeError);
  });

  it("makes 31-byte nonces", () => {
    const nonce = randomNonce();
    expect(nonce).toMatch(/^0x[0-9a-f]{62}$/);
    expect(randomNonce()).not.toBe(nonce);
    expect(nonceField(nonce)).toBeLessThan(SNARK_SCALAR_FIELD);
    expect(() => nonceField(`0x${"00".repeat(32)}`)).toThrow(RangeError);
  });

  it("keeps money parsing in step with core's USDC parser", async () => {
    const { parseUsdcBound } = await import("../src/request");
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: (1n << 63n) - 1n }),
        fc.integer({ min: 0, max: 6 }),
        (minor, digits) => {
          const whole = minor / 1_000_000n;
          const fraction = (minor % 1_000_000n).toString().padStart(6, "0").slice(0, digits);
          const text = digits === 0 ? whole.toString() : `${whole}.${fraction}`;
          expect(parseUsdcBound(text)).toBe(usdc(text));
        },
      ),
    );
    expect(parseUsdcBound("18446744073709.551615")).toBe(MAX_U64);
  });
});
