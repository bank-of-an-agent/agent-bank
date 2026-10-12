import { describe, expect, it } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { formatUserOperation } from "viem/account-abstraction";
import {
  baseSepoliaContracts,
  encodeSessionSignature,
  entryPointAbi,
  EVENT_TOPICS,
  EvmChainGateway,
  hashUserOperation,
  signOperationHash,
  smartSessionsAbi,
  transferCall,
  validatorNonceKey,
} from "../src";
import { cosigner, payee, sessionKey } from "./helpers";

/**
 * The Pimlico-sponsored path (ERC-7677 stub data → estimate → final paymaster data → send → receipt)
 * against a scripted bundler/paymaster. No network and no API key.
 */
describe("EvmChainGateway with a sponsoring paymaster (scripted Pimlico RPC)", () => {
  const contracts = baseSepoliaContracts();
  const account = getAddress("0x4b6c3b2C7b6aF2C3eA49d2C5E7cE6b1c4bD3A001");
  const permissionId = keccak256(toHex("permission"));
  const paymaster = getAddress("0x777777777777AEc03fd955926DbF81597e66834C");
  const nonce = (validatorNonceKey(contracts.smartSessions) << 64n) | 3n;

  function setup() {
    const bundlerCalls: { method: string; params: unknown[] }[] = [];
    let sentHash: Hex | undefined;
    const node = custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === "eth_chainId") return toHex(84532);
        if (method === "eth_getCode") return "0x60806040";
        if (method === "eth_call") {
          const [{ to, data }] = params as [{ to: Address; data: Hex }];
          if (getAddress(to) === contracts.smartSessions) {
            decodeFunctionData({ abi: smartSessionsAbi, data });
            return encodeAbiParameters([{ type: "bool" }], [true]);
          }
          if (getAddress(to) === contracts.entryPoint) {
            decodeFunctionData({ abi: entryPointAbi, data });
            return encodeAbiParameters([{ type: "uint256" }], [nonce]);
          }
        }
        throw new Error(`unexpected node call ${method}`);
      },
    });
    const bundler = custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        bundlerCalls.push({ method, params });
        switch (method) {
          case "pimlico_getUserOperationGasPrice": {
            const p = { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x5f5e100" };
            return { slow: p, standard: p, fast: p };
          }
          case "pm_getPaymasterStubData":
            return {
              paymaster,
              paymasterData: "0x00",
              paymasterVerificationGasLimit: "0x186a0",
              paymasterPostOpGasLimit: "0xc350",
            };
          case "eth_estimateUserOperationGas":
            return {
              preVerificationGas: "0xc350",
              verificationGasLimit: "0x30d40",
              callGasLimit: "0x186a0",
              paymasterVerificationGasLimit: "0x249f0",
              paymasterPostOpGasLimit: "0x1",
            };
          case "pm_getPaymasterData":
            return { paymaster, paymasterData: "0xabcdef" };
          case "eth_sendUserOperation":
            sentHash = hashUserOperation(
              formatUserOperation(params[0] as never) as never,
              84532,
              contracts.entryPoint,
            );
            return sentHash;
          case "eth_getUserOperationReceipt": {
            const hash = params[0] as Hex;
            if (hash !== sentHash) return null;
            const log = {
              address: contracts.usdc,
              topics: [
                EVENT_TOPICS.Transfer,
                pad(account.toLowerCase() as Hex, { size: 32 }),
                pad(payee.toLowerCase() as Hex, { size: 32 }),
              ],
              data: toHex(5n, { size: 32 }),
              blockNumber: "0x10",
              blockHash: keccak256("0x10"),
              transactionHash: keccak256("0x11"),
              logIndex: "0x3",
              transactionIndex: "0x0",
              removed: false,
            };
            return {
              userOpHash: hash,
              entryPoint: contracts.entryPoint,
              sender: account,
              nonce: toHex(nonce),
              paymaster,
              actualGasCost: "0x2386f26fc10000",
              actualGasUsed: "0x30d40",
              success: true,
              reason: "0x",
              logs: [log],
              receipt: {
                transactionHash: keccak256("0x11"),
                blockHash: keccak256("0x10"),
                blockNumber: "0x10",
                transactionIndex: "0x0",
                from: payee,
                to: contracts.entryPoint,
                cumulativeGasUsed: "0x1",
                gasUsed: "0x1",
                contractAddress: null,
                logs: [log],
                logsBloom: `0x${"0".repeat(512)}`,
                status: "0x1",
                effectiveGasPrice: "0x1",
                type: "0x2",
              },
            };
          }
          case "eth_getUserOperationByHash":
            return null;
          default:
            throw new Error(`unexpected bundler call ${method}`);
        }
      },
    });
    const gateway = new EvmChainGateway({
      chainId: 84532,
      rpcUrl: "http://node.invalid",
      transport: node,
      bundlerTransport: bundler,
      contracts,
    });
    return { gateway, bundlerCalls, sentHash: () => sentHash };
  }

  it("prepares, signs, submits and tracks a sponsored session operation", async () => {
    const { gateway, bundlerCalls } = setup();
    const op = await gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: contracts.usdc, to: payee, amount: 5n })],
    });
    expect(bundlerCalls.map((c) => c.method)).toEqual([
      "pimlico_getUserOperationGasPrice",
      "pm_getPaymasterStubData",
      "eth_estimateUserOperationGas",
      "pm_getPaymasterData",
    ]);
    // Estimation ran with the stub session signature (same length as the real one) and stub paymaster data.
    const estimated = bundlerCalls[2]?.params[0] as { signature: Hex; paymasterData: Hex };
    expect(estimated.signature.length).toBe(2 + 2 * (1 + 32 + 130));
    expect(estimated.paymasterData).toBe("0x00");
    expect(op.userOp).toMatchObject({
      sender: account,
      nonce: nonce.toString(),
      paymaster,
      paymasterData: "0xabcdef",
      paymasterVerificationGasLimit: (0x249f0).toString(),
      callGasLimit: ((0x186a0 * 110) / 100).toString(),
      verificationGasLimit: ((0x30d40 * 120) / 100).toString(),
      preVerificationGas: (0xc350).toString(),
      maxFeePerGas: (0x3b9aca00).toString(),
      signature: "0x",
    });
    expect(op.userOpHash).toBe(gateway.hashOperation(op));
    expect(op.calls[0]).toMatchObject({ kind: "erc20_transfer", recipient: payee, amount: "5" });

    const signature = encodeSessionSignature({
      permissionId,
      sessionSignature: await signOperationHash(sessionKey, op.userOpHash),
      cosignerSignature: await signOperationHash(cosigner, op.userOpHash),
    });
    const { userOpHash } = await gateway.submitOperation({ op, signature });
    expect(userOpHash).toBe(op.userOpHash);
    const sent = bundlerCalls.find((c) => c.method === "eth_sendUserOperation")?.params[0] as {
      signature: Hex;
    };
    expect(sent.signature).toBe(signature);

    const receipt = await gateway.getOperationReceipt(userOpHash);
    expect(receipt).toMatchObject({
      status: "succeeded",
      blockNumber: 16n,
      actualGasCost: 10_000_000_000_000_000n,
    });
    expect(receipt.logs).toEqual([
      expect.objectContaining({
        eventName: "Transfer",
        logIndex: 3,
        args: { from: account, to: payee, value: "5" },
      }),
    ]);
    expect((await gateway.getOperationReceipt(keccak256("0x99"))).status).toBe("not_found");
  });
});
