import { beforeAll, describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  anvilForkContracts,
  contractsFromDeployment,
  disableModuleRegistryCall,
  paymentStreamsAbi,
  policyHookConfig,
  policyHookInstallCalls,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  streamCreateCalls,
  streamSettleCall,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type ChainContracts,
  type EvmChainGateway,
  type SessionGrant,
} from "../../src";
import { cosigner, owner, payee, sessionKey, submitAsOwner, submitAsSession, USDC } from "../helpers";
import {
  ensureAgentBankContracts,
  forkClient,
  forkGateway,
  fundEth,
  increaseTime,
  mintUsdc,
  sessionModules,
  startForkEnv,
  waitForOperation,
} from "./forkEnv";

const RUN = process.env.RUN_FORK_TESTS === "1";
// A fresh key: Anvil's public development addresses carry EIP-7702 delegations on Base Sepolia, which
// make FiatToken treat them as contracts (ERC-1271) and reject their plain ECDSA authorizations.
const spendKey = privateKeyToAccount(generatePrivateKey());

describe.skipIf(!RUN)("fork e2e: relayed settlement (x402) and keeper calls", () => {
  let gateway: EvmChainGateway;
  let contracts: ChainContracts;

  beforeAll(async () => {
    await startForkEnv();
    contracts = contractsFromDeployment(
      anvilForkContracts(sessionModules),
      await ensureAgentBankContracts(),
      { useDeploymentUsdc: false },
    );
    gateway = forkGateway(contracts);
  }, 900_000);

  it("settles an EIP-3009 authorization signed by a spend key on real USDC, once", async () => {
    await mintUsdc(contracts.usdc, spendKey.address, USDC(5));
    const now = BigInt((await forkClient.getBlock()).timestamp);
    const message = {
      from: spendKey.address,
      to: payee,
      value: USDC(2),
      validAfter: now - 60n,
      validBefore: now + 600n,
      nonce: keccak256(toHex(`x402-${Date.now()}`)),
    };
    const signature = await spendKey.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 31337, verifyingContract: contracts.usdc },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    const digest = hashTypedData({
      domain: { name: "USDC", version: "2", chainId: 31337, verifyingContract: contracts.usdc },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    expect(await gateway.verifySignature({ address: spendKey.address, hash: digest, signature })).toBe(true);
    const before = await gateway.getTokenBalance(contracts.usdc, payee);
    const { txHash } = await gateway.settleAuthorization({ token: contracts.usdc, ...message, signature });
    const receipt = await forkClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe("success");
    expect(await gateway.getTokenBalance(contracts.usdc, payee)).toBe(before + USDC(2));
    expect(await gateway.authorizationState(contracts.usdc, spendKey.address, message.nonce)).toBe(true);
    const logs = await gateway.getLogs({
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      events: ["AuthorizationUsed", "Transfer"],
      involving: [spendKey.address],
    });
    expect(logs.map((l) => l.eventName)).toEqual(["AuthorizationUsed", "Transfer"]);
    await expect(
      gateway.settleAuthorization({ token: contracts.usdc, ...message, signature }),
    ).rejects.toMatchObject({
      code: "invalid_state",
    });
  }, 120_000);

  it("a keeper settles a stream created by a session (relayCall)", async () => {
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: BigInt(Date.now()) + 11n };
    const account = await gateway.predictAccountAddress(deployment);
    await fundEth(account, "1");
    await mintUsdc(contracts.usdc, account, USDC(100));
    const issuedAt = Number((await forkClient.getBlock()).timestamp);
    const grant: SessionGrant = {
      sessionKey: sessionKey.address,
      cosigner: cosigner.address,
      salt: sessionSalt(`stream-${deployment.salt}`),
      scope: {
        token: contracts.usdc,
        maxPerTx: USDC(25),
        maxPerDay: USDC(100),
        allowedRecipients: [],
        allowedContracts: [contracts.streams as Address],
        issuedAt,
        expiresAt: issuedAt + 86_400,
      },
    };
    const setup = await gateway.prepareOwnerOperation({
      account,
      deployment,
      calls: [
        disableModuleRegistryCall({ account }),
        ...policyHookInstallCalls({ account, contracts, config: policyHookConfig(grant.scope, contracts) }),
        ...sessionInstallCalls({ contracts, grant }),
      ],
    });
    expect((await waitForOperation(gateway, (await submitAsOwner(gateway, setup)).userOpHash)).status).toBe(
      "succeeded",
    );
    const permissionId = sessionPermissionId(grant, contracts);
    const create = await gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: streamCreateCalls({
        streams: contracts.streams as Address,
        token: contracts.usdc,
        payee,
        deposit: USDC(10),
        amountPerInterval: USDC(1),
        interval: 3600n,
      }),
    });
    const created = await waitForOperation(gateway, (await submitAsSession(gateway, create)).userOpHash);
    expect(created.status).toBe("succeeded");
    const event = created.logs.find((l) => l.eventName === "StreamCreated");
    const streamId = BigInt(event?.args.id as string);
    await increaseTime(2 * 3600 + 30);
    const before = await gateway.getTokenBalance(contracts.usdc, payee);
    const { txHash } = await gateway.relayCall({
      call: streamSettleCall({ streams: contracts.streams as Address, streamId }),
    });
    const receipt = await forkClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe("success");
    expect(await gateway.getTokenBalance(contracts.usdc, payee)).toBe(before + USDC(2));
    const stream = await forkClient.readContract({
      address: contracts.streams as Address,
      abi: paymentStreamsAbi,
      functionName: "getStream",
      args: [streamId],
    });
    expect(stream.paid).toBe(USDC(2));
  }, 240_000);
});
