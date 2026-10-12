import { beforeAll, describe, expect, it } from "vitest";
import {
  hashStruct,
  hashTypedData,
  keccak256,
  maxUint256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  accountSetupCalls,
  agentPolicyHookAbi,
  anvilForkContracts,
  contractsFromDeployment,
  erc20Abi,
  floatSweepCall,
  PERMIT_TYPES,
  permitCall,
  policyHookConfig,
  sessionPermissionId,
  sessionSalt,
  smartSessionsAbi,
  spendKeyPermitTypedData,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferCall,
  type ChainContracts,
  type EvmChainGateway,
  type SessionGrant,
} from "../../src";
import { ownerErc1271Signature, sessionErc1271Attempts } from "../erc1271";
import {
  cosigner,
  owner,
  payee,
  revenue,
  sessionKey,
  stranger,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "../helpers";
import {
  ensureAgentBankContracts,
  forkClient,
  forkGateway,
  fundEth,
  mintUsdc,
  sendFromRelayer,
  sessionModules,
  startForkEnv,
  waitForOperation,
} from "./forkEnv";

const RUN = process.env.RUN_FORK_TESTS === "1";
const TWA_TYPE =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
const PERMIT_TYPE = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";

describe.skipIf(!RUN)("fork e2e: x402 spend key lifecycle and the ADR 0001 ERC-1271 acceptance test", () => {
  let gateway: EvmChainGateway;
  let contracts: ChainContracts;
  let account: Address;
  let permissionId: Hex;
  // A fresh key: public development addresses carry EIP-7702 delegations on Base Sepolia.
  const spendKey = privateKeyToAccount(generatePrivateKey());
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: BigInt(Date.now()) + 23n };
  const usdcRead = <F extends "allowance" | "balanceOf" | "nonces" | "DOMAIN_SEPARATOR">(
    functionName: F,
    args: readonly unknown[] = [],
  ) =>
    forkClient.readContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName,
      args,
    } as never) as Promise<never>;
  const spentToday = () =>
    forkClient.readContract({
      address: contracts.policyHook as Address,
      abi: agentPolicyHookAbi,
      functionName: "spentToday",
      args: [account, contracts.usdc],
    });

  beforeAll(async () => {
    await startForkEnv();
    contracts = contractsFromDeployment(
      anvilForkContracts(sessionModules),
      await ensureAgentBankContracts(),
      { useDeploymentUsdc: false },
    );
    gateway = forkGateway(contracts);
    account = await gateway.predictAccountAddress(deployment);
    await fundEth(account, "1");
    await mintUsdc(contracts.usdc, account, USDC(500));
  }, 900_000);

  it("accountSetupCalls: one owner operation deploys, disables the registry, installs the hook, enables the session and submits the spend key's permit", async () => {
    const issuedAt = Number((await forkClient.getBlock()).timestamp);
    const grant: SessionGrant = {
      sessionKey: sessionKey.address,
      cosigner: cosigner.address,
      salt: sessionSalt(`float-${deployment.salt}`),
      scope: {
        token: contracts.usdc,
        maxPerTx: USDC(25),
        maxPerDay: USDC(100),
        allowedRecipients: [payee, revenue, spendKey.address],
        allowedContracts: [],
        issuedAt,
        expiresAt: issuedAt + 86_400,
      },
    };
    permissionId = sessionPermissionId(grant, contracts);
    const signature = await spendKey.signTypedData(
      spendKeyPermitTypedData({
        chainId: 31337,
        token: contracts.usdc,
        owner: spendKey.address,
        spender: account,
        value: maxUint256,
        nonce: await usdcRead("nonces", [spendKey.address]),
        deadline: maxUint256,
      }),
    );
    const op = await gateway.prepareOwnerOperation({
      account,
      deployment,
      calls: accountSetupCalls({
        account,
        contracts,
        grant,
        hookConfig: policyHookConfig(grant.scope, contracts),
        spendKeyPermit: { owner: spendKey.address, value: maxUint256, deadline: maxUint256, signature },
      }),
    });
    expect(op.calls.map((c) => c.kind)).toEqual([
      "module_config",
      "module_config",
      "session_install",
      "erc20_permit",
    ]);
    const receipt = await waitForOperation(gateway, (await submitAsOwner(gateway, op)).userOpHash);
    expect(receipt.status).toBe("succeeded");
    expect(await gateway.isSessionEnabled(account, permissionId)).toBe(true);
    expect(await usdcRead("allowance", [spendKey.address, account])).toBe(maxUint256);
    expect(
      await forkClient.readContract({
        address: contracts.policyHook as Address,
        abi: agentPolicyHookAbi,
        functionName: "isInitialized",
        args: [account],
      }),
    ).toBe(true);
  }, 180_000);

  it("refill (session + co-signer + hook), x402 payment by the spend key, then the owner sweeps the float back as an inflow", async () => {
    const refill = await gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: contracts.usdc, to: spendKey.address, amount: USDC(20) })],
    });
    expect(
      (await waitForOperation(gateway, (await submitAsSession(gateway, refill)).userOpHash)).status,
    ).toBe("succeeded");
    expect(await usdcRead("balanceOf", [spendKey.address])).toBe(USDC(20));
    const spentAfterRefill = await spentToday();

    const now = BigInt((await forkClient.getBlock()).timestamp);
    const message = {
      from: spendKey.address,
      to: payee,
      value: USDC(3),
      validAfter: now - 60n,
      validBefore: now + 600n,
      nonce: keccak256(toHex(`float-x402-${now}`)),
    };
    const signature = await spendKey.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 31337, verifyingContract: contracts.usdc },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    await forkClient.waitForTransactionReceipt({
      hash: (await gateway.settleAuthorization({ token: contracts.usdc, ...message, signature })).txHash,
    });
    expect(await usdcRead("balanceOf", [spendKey.address])).toBe(USDC(17));

    const before = await usdcRead("balanceOf", [account]);
    const sweep = await gateway.prepareOwnerOperation({
      account,
      calls: [floatSweepCall(contracts.usdc, spendKey.address, account, USDC(17))],
    });
    expect(sweep.calls[0]?.kind).toBe("erc20_transfer_from");
    expect((await waitForOperation(gateway, (await submitAsOwner(gateway, sweep)).userOpHash)).status).toBe(
      "succeeded",
    );
    expect(await usdcRead("balanceOf", [spendKey.address])).toBe(0n);
    expect(await usdcRead("balanceOf", [account])).toBe((before as bigint) + USDC(17));
    // An inflow: the hook's UTC-day spend did not move.
    expect(await spentToday()).toBe(spentAfterRefill);
  }, 240_000);

  it("ADR 0001 acceptance: Base Sepolia USDC rejects session-key + co-signer ERC-1271 signatures for transferWithAuthorization and permit; the owner's own signature works", async () => {
    const appDomainSeparator = (await usdcRead("DOMAIN_SEPARATOR")) as Hex;
    // On-chain: the session holds no ERC-1271 policies and no ERC-7739 contents.
    expect(
      await forkClient.readContract({
        address: contracts.smartSessions,
        abi: smartSessionsAbi,
        functionName: "getERC1271Policies",
        args: [account, permissionId],
      }),
    ).toEqual([]);
    for (const content of ["TransferWithAuthorization", TWA_TYPE, "Permit", PERMIT_TYPE]) {
      expect(
        await forkClient.readContract({
          address: contracts.smartSessions,
          abi: smartSessionsAbi,
          functionName: "isERC7739ContentEnabled",
          args: [account, permissionId, appDomainSeparator, content],
        }),
      ).toBe(false);
    }
    // The Safe has no EIP-5267 eip712Domain(), which Smart Sessions' ERC-7739 path requires.
    await expect(
      forkClient.readContract({
        address: account,
        abi: parseAbi([
          "function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])",
        ]),
        functionName: "eip712Domain",
      }),
    ).rejects.toThrow();

    const domain = { name: "USDC", version: "2", chainId: 31337, verifyingContract: contracts.usdc } as const;
    const now = BigInt((await forkClient.getBlock()).timestamp);
    const twa = {
      from: account,
      to: stranger.address,
      value: USDC(100),
      validAfter: now - 60n,
      validBefore: now + 600n,
      nonce: keccak256(toHex(`drain-${now}`)),
    };
    const twaDigest = hashTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: twa,
    });
    const twaContents = hashStruct({
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      data: twa,
    });
    const strangerBefore = await usdcRead("balanceOf", [stranger.address]);
    for (const attempt of await sessionErc1271Attempts({
      chainId: 31337,
      account,
      contracts,
      permissionId,
      digest: twaDigest,
      appDomainSeparator,
      contents: twaContents,
      contentsType: TWA_TYPE,
    })) {
      await expect(
        gateway.settleAuthorization({ token: contracts.usdc, ...twa, signature: attempt.signature }),
        attempt.label,
      ).rejects.toMatchObject({
        code: "invalid_state",
        extensions: { revertReason: expect.stringContaining("FiatTokenV2: invalid signature") },
      });
    }

    const permit = {
      owner: account,
      spender: stranger.address,
      value: maxUint256,
      nonce: await usdcRead("nonces", [account]),
      deadline: maxUint256,
    };
    const permitDigest = hashTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: permit,
    });
    const permitContents = hashStruct({ types: PERMIT_TYPES, primaryType: "Permit", data: permit });
    for (const attempt of await sessionErc1271Attempts({
      chainId: 31337,
      account,
      contracts,
      permissionId,
      digest: permitDigest,
      appDomainSeparator,
      contents: permitContents,
      contentsType: PERMIT_TYPE,
    })) {
      await expect(
        forkClient.call({
          account: stranger.address,
          to: contracts.usdc,
          data: permitCall(contracts.usdc, { ...permit, signature: attempt.signature }).data,
        }),
        attempt.label,
      ).rejects.toThrow(/EIP2612: invalid signature/);
    }
    expect(await usdcRead("allowance", [account, stranger.address])).toBe(0n);
    expect(await usdcRead("balanceOf", [stranger.address])).toBe(strangerBefore);

    // Positive control: the owner's ERC-1271 signature passes both checks (and bypasses the hook, as ADR 0001 explains).
    await forkClient.waitForTransactionReceipt({
      hash: (
        await gateway.settleAuthorization({
          token: contracts.usdc,
          ...twa,
          signature: await ownerErc1271Signature(31337, account, twaDigest),
        })
      ).txHash,
    });
    expect(await usdcRead("balanceOf", [stranger.address])).toBe((strangerBefore as bigint) + USDC(100));
    const status = await sendFromRelayer(
      contracts.usdc,
      permitCall(contracts.usdc, {
        ...permit,
        signature: await ownerErc1271Signature(31337, account, permitDigest),
      }).data,
    );
    expect(status).toBe("success");
    expect(await usdcRead("allowance", [account, stranger.address])).toBe(maxUint256);
  }, 240_000);
});
