import { describe, expect, it } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  RpcRequestError,
  toHex,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentAttestationRegistryAbi,
  baseSepoliaContracts,
  ContractNotConfiguredError,
  EvmChainGateway,
  SIMULATED_ATTESTER_KEY,
  withAgentBankContracts,
} from "../src";
import { DEV_KEYS } from "./helpers";

type Request = { method: string; params?: unknown };

const registry = getAddress("0x000000000000000000000000000000000000a77e");
const attester = privateKeyToAccount(DEV_KEYS[7] as Hex);
const root = keccak256(toHex("root")).replace(/^0x../, "0x0a") as Hex;
const contracts = withAgentBankContracts(baseSepoliaContracts(), { attestationRegistry: registry });

/** A JSON-RPC "execution reverted" error carrying revert data, as nodes return it. */
function reverted(data: Hex): Error {
  return Object.assign(new Error("execution reverted"), { code: 3, data });
}

function mockGateway(
  handler: (req: Request) => unknown,
  overrides: Partial<ConstructorParameters<typeof EvmChainGateway>[0]> = {},
) {
  const calls: Request[] = [];
  const gateway = new EvmChainGateway({
    chainId: 84532,
    rpcUrl: "http://mock.invalid",
    contracts,
    transport: custom(
      {
        async request(req: Request) {
          calls.push(req);
          if (req.method === "eth_chainId") return toHex(84532);
          return handler(req);
        },
      },
      { retryCount: 0 },
    ),
    ...overrides,
  });
  return { gateway, calls };
}

/** A node that simulates registry calls with `onCall`, then signs-and-sends like a real one. */
function sendingNode(onCall: (data: Hex, from: Address) => Hex | Error = () => "0x") {
  const sent: TransactionSerialized[] = [];
  const handler = (req: Request) => {
    const params = (req.params ?? []) as unknown[];
    switch (req.method) {
      case "eth_call": {
        const [{ to, data, from }] = params as [{ to: Address; data: Hex; from: Address }];
        expect(getAddress(to)).toBe(registry);
        const result = onCall(data, getAddress(from));
        if (result instanceof Error) throw result;
        return result;
      }
      case "eth_getTransactionCount":
        return "0x7";
      case "eth_estimateGas":
        return "0xc350";
      case "eth_maxPriorityFeePerGas":
        return "0xf4240";
      case "eth_getBlockByNumber":
        return {
          number: "0x10",
          hash: keccak256("0x10"),
          parentHash: keccak256("0x0f"),
          timestamp: "0x6700000",
          baseFeePerGas: "0x3b9aca00",
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          transactions: [],
        };
      case "eth_sendRawTransaction": {
        const raw = params[0] as TransactionSerialized;
        sent.push(raw);
        return keccak256(raw);
      }
      default:
        throw new Error(`unexpected ${req.method}`);
    }
  };
  return { handler, sent };
}

describe("EvmChainGateway attestation registry", () => {
  it("refuses when the chain has no registry configured", async () => {
    const { gateway, calls } = mockGateway(
      () => {
        throw new Error("no call expected");
      },
      { contracts: baseSepoliaContracts() },
    );
    for (const attempt of [
      gateway.publishAttestationRoot({
        root,
        epoch: 1n,
        snapshotAt: 1n,
        validUntil: 2n,
        leafCount: 1,
        attester,
      }),
      gateway.revokeAttestationRoots({ roots: [root], attester }),
      gateway.getAttestationRoot(root),
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(ContractNotConfiguredError);
    }
    await expect(gateway.getAttestationRoot(root)).rejects.toMatchObject({
      code: "invalid_state",
      contract: "attestationRegistry",
    });
    expect(calls.every((c) => c.method === "eth_chainId")).toBe(true);
  });

  it("never signs with the public simulated attester key", async () => {
    const { handler, sent } = sendingNode();
    const { gateway, calls } = mockGateway(handler);
    const simulated = privateKeyToAccount(SIMULATED_ATTESTER_KEY);
    await expect(
      gateway.publishAttestationRoot({
        root,
        epoch: 1n,
        snapshotAt: 1n,
        validUntil: 2n,
        leafCount: 1,
        attester: simulated,
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/simulated attester/),
    });
    await expect(
      gateway.revokeAttestationRoots({ roots: [root], attester: simulated }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(sent).toEqual([]);
    expect(calls.some((c) => c.method === "eth_call")).toBe(false);
  });

  it("simulates publishRoot from the attester, then signs and sends it without waiting", async () => {
    const simulated: { data: Hex; from: Address }[] = [];
    const { handler, sent } = sendingNode((data, from) => {
      simulated.push({ data, from });
      return "0x";
    });
    const { gateway, calls } = mockGateway(handler);
    const { txHash } = await gateway.publishAttestationRoot({
      root,
      epoch: 4n,
      snapshotAt: 1_800_000_000n,
      validUntil: 1_800_007_200n,
      leafCount: 32,
      attester,
    });
    expect(simulated).toHaveLength(1);
    expect(simulated[0]?.from).toBe(attester.address);
    expect(sent).toHaveLength(1);
    const raw = sent[0] as TransactionSerialized;
    expect(txHash).toBe(keccak256(raw));
    const tx = parseTransaction(raw);
    expect(tx).toMatchObject({ chainId: 84532, to: registry.toLowerCase(), nonce: 7 });
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(attester.address);
    expect(decodeFunctionData({ abi: agentAttestationRegistryAbi, data: tx.data as Hex })).toEqual({
      functionName: "publishRoot",
      args: [root, 4n, 1_800_000_000n, 1_800_007_200n, 32],
    });
    expect(tx.data).toBe(simulated[0]?.data);
    // Never waits for a receipt.
    expect(calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(false);
  });

  it("sends revokeRoots the same way", async () => {
    const { handler, sent } = sendingNode();
    const { gateway } = mockGateway(handler);
    const other = keccak256(toHex("other")).replace(/^0x../, "0x0b") as Hex;
    await gateway.revokeAttestationRoots({ roots: [root, other], attester });
    const tx = parseTransaction(sent[0] as TransactionSerialized);
    expect(decodeFunctionData({ abi: agentAttestationRegistryAbi, data: tx.data as Hex })).toEqual({
      functionName: "revokeRoots",
      args: [[root, other]],
    });
  });

  it("reports the registry's custom error when the simulation reverts, and sends nothing", async () => {
    const epochError = encodeErrorResult({
      abi: agentAttestationRegistryAbi,
      errorName: "EpochNotIncreasing",
      args: [4n, 4n],
    });
    const { handler, sent } = sendingNode(() => reverted(epochError));
    const { gateway } = mockGateway(handler);
    const input = { root, epoch: 4n, snapshotAt: 1n, validUntil: 2n, leafCount: 1, attester };
    await expect(gateway.publishAttestationRoot(input)).rejects.toMatchObject({
      code: "invalid_state",
      message: "Transaction would revert: EpochNotIncreasing(4, 4)",
      extensions: { revertReason: "EpochNotIncreasing(4, 4)" },
    });

    const unknownRoot = encodeErrorResult({
      abi: agentAttestationRegistryAbi,
      errorName: "UnknownRoot",
      args: [root],
    });
    const revoke = mockGateway(sendingNode(() => reverted(unknownRoot)).handler).gateway;
    await expect(revoke.revokeAttestationRoots({ roots: [root], attester })).rejects.toMatchObject({
      message: `Transaction would revert: UnknownRoot(${root})`,
    });

    const notAttester = encodeErrorResult({
      abi: agentAttestationRegistryAbi,
      errorName: "NotAttester",
      args: [attester.address],
    });
    const wrongKey = mockGateway(sendingNode(() => reverted(notAttester)).handler).gateway;
    await expect(wrongKey.publishAttestationRoot(input)).rejects.toMatchObject({
      message: `Transaction would revert: NotAttester(${attester.address})`,
    });

    // The same revert as viem's HTTP transport reports a node's JSON-RPC error.
    const http = mockGateway(
      sendingNode(
        () =>
          new RpcRequestError({
            body: {},
            error: { code: 3, message: "execution reverted", data: epochError },
            url: "http://node.invalid",
          }),
      ).handler,
    ).gateway;
    await expect(http.publishAttestationRoot(input)).rejects.toMatchObject({
      message: "Transaction would revert: EpochNotIncreasing(4, 4)",
    });

    // Revert data the registry ABI does not know still fails closed.
    const opaque = mockGateway(sendingNode(() => reverted("0xdeadbeef")).handler).gateway;
    await expect(opaque.publishAttestationRoot(input)).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/^Transaction would revert/),
    });
    const down = mockGateway(sendingNode(() => new Error("connection refused")).handler).gateway;
    await expect(down.publishAttestationRoot(input)).rejects.toMatchObject({ code: "invalid_state" });
    expect(sent).toEqual([]);
  });

  it("maps a failed send to chain_error", async () => {
    const { handler } = sendingNode();
    const { gateway } = mockGateway((req) => {
      if (req.method === "eth_sendRawTransaction") throw new Error("insufficient funds for gas");
      return handler(req);
    });
    await expect(
      gateway.publishAttestationRoot({
        root,
        epoch: 1n,
        snapshotAt: 1n,
        validUntil: 2n,
        leafCount: 1,
        attester,
      }),
    ).rejects.toMatchObject({
      code: "chain_error",
      message: expect.stringMatching(/^Attester transaction failed/),
    });
  });

  it("checks argument types before touching the node", async () => {
    const { gateway, calls } = mockGateway(() => {
      throw new Error("no call expected");
    });
    await expect(
      gateway.publishAttestationRoot({
        root: "0x01",
        epoch: 1n,
        snapshotAt: 1n,
        validUntil: 2n,
        leafCount: 1,
        attester,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(gateway.revokeAttestationRoots({ roots: [], attester })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(gateway.getAttestationRoot("0x01")).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls.every((c) => c.method === "eth_chainId")).toBe(true);
  });

  it("reads rootInfo and isValidRoot; null for a root never published", async () => {
    const infos = new Map<string, { info: object; valid: boolean }>([
      [
        root,
        {
          info: {
            epoch: 9n,
            snapshotAt: 100n,
            publishedAt: 110n,
            validUntil: 7300n,
            leafCount: 64,
            revoked: false,
          },
          valid: true,
        },
      ],
    ]);
    const zero = { epoch: 0n, snapshotAt: 0n, publishedAt: 0n, validUntil: 0n, leafCount: 0, revoked: false };
    const { gateway, calls } = mockGateway((req) => {
      if (req.method !== "eth_call") throw new Error(req.method);
      const [{ to, data }] = req.params as [{ to: Address; data: Hex }];
      expect(getAddress(to)).toBe(registry);
      const call = decodeFunctionData({ abi: agentAttestationRegistryAbi, data });
      const entry = infos.get((call.args as readonly Hex[])[0] as string);
      if (call.functionName === "rootInfo")
        return encodeFunctionResult({
          abi: agentAttestationRegistryAbi,
          functionName: "rootInfo",
          result: (entry?.info ?? zero) as never,
        });
      if (call.functionName === "isValidRoot")
        return encodeAbiParameters([{ type: "bool" }], [entry?.valid ?? false]);
      throw new Error(call.functionName);
    });
    expect(await gateway.getAttestationRoot(root.toUpperCase().replace("0X", "0x") as Hex)).toEqual({
      epoch: 9n,
      snapshotAt: 100n,
      publishedAt: 110n,
      validUntil: 7300n,
      leafCount: 64,
      revoked: false,
      valid: true,
    });
    const before = calls.filter((c) => c.method === "eth_call").length;
    expect(before).toBe(2);
    expect(await gateway.getAttestationRoot(keccak256("0x99"))).toBeNull();
    // An unknown root costs one read.
    expect(calls.filter((c) => c.method === "eth_call").length).toBe(before + 1);
  });

  it("reads transaction receipts; null while not mined", async () => {
    const mined = keccak256("0x01");
    const failed = keccak256("0x02");
    const { gateway } = mockGateway((req) => {
      if (req.method !== "eth_getTransactionReceipt") throw new Error(req.method);
      const [hash] = req.params as [Hex];
      if (hash !== mined && hash !== failed) return null;
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256("0xb1"),
        blockNumber: "0x2a",
        from: attester.address,
        to: registry,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status: hash === mined ? "0x1" : "0x0",
        type: "0x2",
      };
    });
    expect(await gateway.getTransactionReceipt(mined)).toEqual({ status: "success", blockNumber: 42n });
    expect(await gateway.getTransactionReceipt(failed)).toEqual({ status: "reverted", blockNumber: 42n });
    expect(await gateway.getTransactionReceipt(keccak256("0x03"))).toBeNull();

    const broken = mockGateway(() => {
      throw new Error("upstream timeout");
    }).gateway;
    await expect(broken.getTransactionReceipt(mined)).rejects.toMatchObject({ code: "chain_error" });
  });

  it("refuses a node that serves a mainnet", async () => {
    const gateway = new EvmChainGateway({
      chainId: 84532,
      rpcUrl: "http://mock.invalid",
      contracts,
      transport: custom({
        async request({ method }: Request) {
          if (method === "eth_chainId") return toHex(8453);
          throw new Error(method);
        },
      }),
    });
    await expect(
      gateway.publishAttestationRoot({
        root,
        epoch: 1n,
        snapshotAt: 1n,
        validUntil: 2n,
        leafCount: 1,
        attester,
      }),
    ).rejects.toMatchObject({ code: "mainnet_locked" });
    await expect(gateway.getTransactionReceipt(root)).rejects.toMatchObject({ code: "mainnet_locked" });
  });
});
