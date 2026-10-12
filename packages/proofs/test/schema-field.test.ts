import { usdc } from "@agentbank/core";
import { DISCLOSURE_CLASSES as API_CLASSES, PROOF_ATTRIBUTES } from "@agentbank/core/api";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/artifacts";
import {
  fromBytes32,
  nonceField,
  onchainScope,
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
