import {
  concat,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  padHex,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  contractSignatureVerifierFor,
  ERC1271_MAGIC_WORD,
  erc1271ViaCall,
  isErc1271Accepted,
} from "../src/erc1271";
import { payer, seller } from "./helpers";

/**
 * `erc1271ViaCall` through a real viem public client over a scripted JSON-RPC transport, so
 * viem's own error mapping (reverts vs transport failures) is exercised.
 */

const abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

const HASH: Hex = `0x${"11".repeat(32)}`;
const SIGNATURE: Hex = `0x${"22".repeat(65)}`;

type Answer = { result: Hex } | { error: { code: number; message: string; data?: Hex } } | "network";

function clientAnswering(answer: Answer, seen: { to?: string; data?: Hex }[] = []) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [call] = params as [{ to: string; data: Hex }];
        seen.push({ to: call.to, data: call.data });
        if (answer === "network") throw new Error("fetch failed: ECONNRESET");
        if ("error" in answer) throw Object.assign(new Error(answer.error.message), answer.error);
        return answer.result;
      },
    }),
  });
}

describe("isErc1271Accepted (FiatToken's rule)", () => {
  it("accepts exactly bytes32(0x1626ba7e)", () => {
    expect(isErc1271Accepted(ERC1271_MAGIC_WORD)).toBe(true);
    expect(isErc1271Accepted(concat([ERC1271_MAGIC_WORD, "0x00"]))).toBe(true); // longer is fine: first word decides
  });

  it.each([
    ["no data", undefined],
    ["empty data", "0x" as Hex],
    ["only the 4-byte selector", "0x1626ba7e" as Hex],
    ["another value", padHex("0xffffffff", { dir: "right", size: 32 })],
    ["the magic value right-aligned", padHex("0x1626ba7e", { size: 32 })],
    [
      "the magic value with dirty padding",
      "0x1626ba7e00000000000000000000000000000000000000000000000000000001" as Hex,
    ],
  ])("rejects %s", (_name, data) => {
    expect(isErc1271Accepted(data)).toBe(false);
  });
});

describe("erc1271ViaCall", () => {
  it("calls isValidSignature(hash, signature) on the payer and accepts the magic word", async () => {
    const seen: { to?: string; data?: Hex }[] = [];
    const verify = erc1271ViaCall(
      clientAnswering(
        { result: encodeFunctionResult({ abi, functionName: "isValidSignature", result: "0x1626ba7e" }) },
        seen,
      ),
    );
    expect(await verify({ address: payer.address, hash: HASH, signature: SIGNATURE })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.to?.toLowerCase()).toBe(payer.address.toLowerCase());
    const decoded = decodeFunctionData({ abi, data: seen[0]?.data as Hex });
    expect(decoded.args).toEqual([HASH, SIGNATURE]);
  });

  it("treats other answers and empty returns as rejected", async () => {
    expect(
      await erc1271ViaCall(clientAnswering({ result: padHex("0xdeadbeef", { dir: "right", size: 32 }) }))({
        address: payer.address,
        hash: HASH,
        signature: SIGNATURE,
      }),
    ).toBe(false);
    expect(
      await erc1271ViaCall(clientAnswering({ result: "0x" }))({
        address: payer.address,
        hash: HASH,
        signature: SIGNATURE,
      }),
    ).toBe(false);
  });

  it("treats a revert as rejected (no ECDSA fallback)", async () => {
    const reverted = erc1271ViaCall(
      clientAnswering({ error: { code: 3, message: "execution reverted", data: "0x" } }),
    );
    expect(await reverted({ address: payer.address, hash: HASH, signature: SIGNATURE })).toBe(false);
    const legacy = erc1271ViaCall(
      clientAnswering({ error: { code: -32000, message: "execution reverted" } }),
    );
    expect(await legacy({ address: payer.address, hash: HASH, signature: SIGNATURE })).toBe(false);
  });

  it("throws on transport failures so the facilitator fails closed", async () => {
    const down = erc1271ViaCall(clientAnswering("network"));
    await expect(down({ address: payer.address, hash: HASH, signature: SIGNATURE })).rejects.toThrow();
  });

  it("is chosen for gateways that expose a viem client; others use verifySignature", async () => {
    const client = clientAnswering({ result: ERC1271_MAGIC_WORD });
    const viaClient = contractSignatureVerifierFor({ publicClient: client } as never);
    expect(await viaClient({ address: seller, hash: HASH, signature: SIGNATURE })).toBe(true);
    const calls: unknown[] = [];
    const viaGateway = contractSignatureVerifierFor({
      verifySignature: async (input: unknown) => {
        calls.push(input);
        return false;
      },
    } as never);
    expect(await viaGateway({ address: seller, hash: HASH, signature: numberToHex(1n, { size: 65 }) })).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
  });
});
