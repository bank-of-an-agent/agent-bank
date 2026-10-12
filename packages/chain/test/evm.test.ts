import { describe, expect, it } from "vitest";
import { BaseError, custom, keccak256, pad, toHex, type Address, type Hex } from "viem";
import {
  baseSepoliaContracts,
  bundlerError,
  EVENT_TOPICS,
  evmGatewayFromEnv,
  EvmChainGateway,
  pimlicoUrl,
  predictAccountAddress,
  transferCall,
  withAgentBankContracts,
} from "../src";
import { cosigner, owner, payee } from "./helpers";

type Request = { method: string; params?: unknown };

function mockGateway(
  handler: (req: Request) => unknown,
  overrides: Partial<ConstructorParameters<typeof EvmChainGateway>[0]> = {},
) {
  const calls: Request[] = [];
  const gateway = new EvmChainGateway({
    chainId: 84532,
    rpcUrl: "http://mock.invalid",
    transport: custom({
      async request(req: Request) {
        calls.push(req);
        if (req.method === "eth_chainId") return toHex(84532);
        return handler(req);
      },
    }),
    ...overrides,
  });
  return { gateway, calls };
}

describe("EvmChainGateway safety", () => {
  it("refuses mainnet and the simulated chain at construction", () => {
    expect(() => new EvmChainGateway({ chainId: 8453, rpcUrl: "http://x.invalid" })).toThrow(/mainnet/i);
    expect(() => new EvmChainGateway({ chainId: 1, rpcUrl: "http://x.invalid" })).toThrow(/mainnet/i);
    expect(() => new EvmChainGateway({ chainId: 1337, rpcUrl: "http://x.invalid" })).toThrow(
      /SimulatedChain/,
    );
  });

  it("refuses a node that serves another chain (or a mainnet)", async () => {
    for (const [served, code] of [
      [8453, "mainnet_locked"],
      [31337, "unsupported_chain"],
    ] as const) {
      const gateway = new EvmChainGateway({
        chainId: 84532,
        rpcUrl: "http://mock.invalid",
        transport: custom({
          async request({ method }: Request) {
            if (method === "eth_chainId") return toHex(served);
            throw new Error(method);
          },
        }),
      });
      await expect(gateway.getBlock("latest")).rejects.toMatchObject({ code });
    }
  });

  it("builds Pimlico URLs and gateways from the environment without hard-coded keys", () => {
    expect(pimlicoUrl(84532, "k/ey")).toBe("https://api.pimlico.io/v2/84532/rpc?apikey=k%2Fey");
    expect(() => pimlicoUrl(8453, "k")).toThrow(/mainnet/i);
    expect(() => pimlicoUrl(84532, "")).toThrow(/PIMLICO_API_KEY/);
    const gw = evmGatewayFromEnv({ AGENTBANK_CHAIN: "base-sepolia", PIMLICO_API_KEY: "test" });
    expect(gw.chainId).toBe(84532);
    expect(gw.contracts.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(evmGatewayFromEnv({ AGENTBANK_CHAIN: "anvil" }).chainId).toBe(31337);
    expect(() => evmGatewayFromEnv({ AGENTBANK_CHAIN: "simulated" })).toThrow();
  });

  it("maps bundler errors to Agent Bank error codes", () => {
    const err = (m: string) => new BaseError(m);
    expect(bundlerError(err("UserOperation reverted with reason: AA24 signature error")).code).toBe(
      "signature_invalid",
    );
    expect(bundlerError(err("AA22 expired or not due")).code).toBe("session_expired");
    expect(bundlerError(err("AA23 reverted: PolicyViolation")).code).toBe("policy_denied");
    expect(bundlerError(err("AA25 invalid account nonce")).code).toBe("invalid_state");
    expect(bundlerError(err("AA13 initCode failed or OOG")).code).toBe("invalid_request");
    const revert = bundlerError(err("UserOperation reverted during simulation with reason: 0xacfdb444"));
    expect(revert).toMatchObject({ code: "invalid_state", extensions: { revertData: "0xacfdb444" } });
    expect(bundlerError(new Error("fetch failed")).code).toBe("chain_error");
  });

  it("only relays calls to Agent Bank contracts, with a relayer", async () => {
    const contracts = withAgentBankContracts(baseSepoliaContracts(), {
      escrow: "0x0000000000000000000000000000000000000E5C",
    });
    const { gateway } = mockGateway(() => "0x", { contracts });
    await expect(
      gateway.relayCall({ call: transferCall({ token: contracts.usdc, to: payee, amount: 1n }) }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      gateway.relayCall({ call: { to: contracts.escrow as Address, data: "0x", value: 1n } }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      gateway.relayCall({ call: { to: contracts.escrow as Address, data: "0x" } }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/relayer/),
    });
  });

  it("predicts addresses offline, identical to the pure function", async () => {
    const { gateway, calls } = mockGateway(() => {
      throw new Error("no network expected");
    });
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 9n };
    expect(await gateway.predictAccountAddress(deployment)).toBe(
      predictAccountAddress(deployment, gateway.contracts),
    );
    expect(calls).toEqual([]);
  });
});

describe("EvmChainGateway.getLogs", () => {
  const usdc = baseSepoliaContracts().usdc;
  const transferLog = (from: Address, to: Address, block: bigint, index: number) => ({
    address: usdc,
    topics: [
      EVENT_TOPICS.Transfer,
      pad(from.toLowerCase() as Hex, { size: 32 }),
      pad(to.toLowerCase() as Hex, { size: 32 }),
    ],
    data: toHex(5n, { size: 32 }),
    blockNumber: toHex(block),
    blockHash: keccak256(toHex(block)),
    transactionHash: keccak256(toHex(1000n + block)),
    logIndex: toHex(index),
    transactionIndex: "0x0",
    removed: false,
  });

  it("chunks ranges, filters parties server-side, de-duplicates and normalizes", async () => {
    const me = owner.address;
    const requests: { fromBlock: string; toBlock: string; topics: unknown[] }[] = [];
    const { gateway } = mockGateway(
      (req) => {
        if (req.method !== "eth_getLogs") throw new Error(req.method);
        const [filter] = req.params as [{ fromBlock: string; toBlock: string; topics: unknown[] }];
        requests.push(filter);
        if (BigInt(filter.fromBlock) <= 10n && BigInt(filter.toBlock) >= 10n) {
          // The same self-transfer matches both the `from` and the `to` query.
          return [transferLog(me, me, 10n, 0), transferLog(me, payee, 10n, 1)];
        }
        return [];
      },
      { maxLogBlockRange: 10n },
    );
    const logs = await gateway.getLogs({
      fromBlock: 0n,
      toBlock: 25n,
      events: ["Transfer"],
      involving: [me],
    });
    // 3 chunks x 2 topic positions (from, to).
    expect(requests).toHaveLength(6);
    expect(requests.map((r) => [r.fromBlock, r.toBlock])).toContainEqual(["0xa", "0x13"]);
    const positions = new Set(requests.map((r) => r.topics.length));
    expect(positions).toEqual(new Set([2, 3]));
    expect(logs.map((l) => [l.logIndex, l.args.from, l.args.to, l.args.value])).toEqual([
      [0, me, me, "5"],
      [1, me, payee, "5"],
    ]);
    await expect(gateway.getLogs({ fromBlock: 2n, toBlock: 1n })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
