import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, maxUint256, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  accountSetupCalls,
  agentPolicyHookAbi,
  anvilForkContracts,
  CONTRACT_KIND,
  contractsFromDeployment,
  erc20Abi,
  ownableValidatorAbi,
  ownerRotationCalls,
  permitCall,
  policyHookConfig,
  safeAbi,
  safeNativeOwnerSyncCalls,
  SENTINEL_OWNERS,
  sessionPermissionId,
  sessionSalt,
  spendKeyPermitTypedData,
  transferCall,
  type ChainContracts,
  type EvmChainGateway,
  type SessionGrant,
} from "../../src";
import {
  cosigner,
  owner,
  payee,
  revenue,
  sessionKey,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "../helpers";
import { safeExecTransactionData, safeTxHash } from "../safeTx";
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

describe.skipIf(!RUN)("fork e2e: owner key rotation (Safe + OwnableValidator) and permit relay", () => {
  let gateway: EvmChainGateway;
  let contracts: ChainContracts;
  let account: Address;
  let permissionId: Hex;
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: BigInt(Date.now()) + 41n };
  // Fresh keys (Anvil's public development addresses carry EIP-7702 delegations on Base Sepolia).
  const next = privateKeyToAccount(generatePrivateKey());
  const recovered = privateKeyToAccount(generatePrivateKey());
  const exitRecipient = privateKeyToAccount(generatePrivateKey()).address;
  const spendKey = privateKeyToAccount(generatePrivateKey());

  const safeOwners = () =>
    forkClient.readContract({ address: account, abi: safeAbi, functionName: "getOwners" });
  const safeNonce = () => forkClient.readContract({ address: account, abi: safeAbi, functionName: "nonce" });
  const validator = (functionName: "getOwners" | "threshold" | "ownerCount") =>
    forkClient.readContract({
      address: contracts.ownableValidator,
      abi: ownableValidatorAbi,
      functionName,
      args: [account],
    } as never) as Promise<never>;
  const usdcBalance = (holder: Address) =>
    forkClient.readContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    });

  /** Owner operation paying `payee` (under the hook's caps), signed by `signer`. */
  async function ownerPayment(signer: PrivateKeyAccount) {
    const op = await gateway.prepareOwnerOperation({
      account,
      calls: [transferCall({ token: contracts.usdc, to: payee, amount: USDC(5) })],
    });
    return submitAsOwner(gateway, op, signer);
  }

  /** Safe-native `execTransaction` signed by `signer`, relayed by the keeper key. */
  async function execSafeTx(call: { to: Address; data: Hex }, signer: PrivateKeyAccount) {
    const data = await safeExecTransactionData(
      { chainId: 31337, safe: account, to: call.to, data: call.data, nonce: await safeNonce() },
      [signer],
    );
    return sendFromRelayer(account, data);
  }

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

  it("setup: accountSetupCalls allowlists the OwnableValidator (and Smart Sessions) as Generic", async () => {
    const issuedAt = Number((await forkClient.getBlock()).timestamp);
    const grant: SessionGrant = {
      sessionKey: sessionKey.address,
      cosigner: cosigner.address,
      salt: sessionSalt(`rotation-${deployment.salt}`),
      scope: {
        token: contracts.usdc,
        maxPerTx: USDC(25),
        maxPerDay: USDC(100),
        allowedRecipients: [payee],
        allowedContracts: [],
        issuedAt,
        expiresAt: issuedAt + 86_400,
      },
    };
    permissionId = sessionPermissionId(grant, contracts);
    const op = await gateway.prepareOwnerOperation({
      account,
      deployment,
      calls: accountSetupCalls({
        account,
        contracts,
        grant,
        hookConfig: policyHookConfig(grant.scope, contracts, { extraRecipients: [revenue] }),
      }),
    });
    const receipt = await waitForOperation(gateway, (await submitAsOwner(gateway, op)).userOpHash);
    expect(receipt.status).toBe("succeeded");
    for (const module of [contracts.ownableValidator, contracts.smartSessions]) {
      const kind = await forkClient.readContract({
        address: contracts.policyHook as Address,
        abi: agentPolicyHookAbi,
        functionName: "contractKind",
        args: [account, module],
      });
      expect(kind).toBe(CONTRACT_KIND.Generic);
    }
    expect(await safeOwners()).toEqual([owner.address]);
    expect(await validator("getOwners")).toEqual([owner.address]);
  }, 120_000);

  it("rotates the owner key in ONE owner operation signed by the old key", async () => {
    const calls = ownerRotationCalls({
      account,
      contracts,
      currentOwner: owner.address,
      newOwner: next.address,
      safeOwners: await safeOwners(),
      validatorOwners: await validator("getOwners"),
    });
    const op = await gateway.prepareOwnerOperation({ account, calls });
    expect(op.calls.map((c) => [c.kind, c.args?.function])).toEqual([
      ["module_config", "swapOwner"],
      ["module_config", "addOwner"],
      ["module_config", "removeOwner"],
    ]);
    const receipt = await waitForOperation(gateway, (await submitAsOwner(gateway, op, owner)).userOpHash);
    expect(receipt.status).toBe("succeeded");
    expect(await safeOwners()).toEqual([next.address]);
    expect(await validator("getOwners")).toEqual([next.address]);
    expect(await validator("threshold")).toBe(1n);
    expect(await validator("ownerCount")).toBe(1n);
  }, 120_000);

  it("after rotation: the new key's owner operations succeed, the old key's fail, sessions still work", async () => {
    await expect(ownerPayment(owner)).rejects.toMatchObject({ code: "signature_invalid" });
    const paid = await waitForOperation(gateway, (await ownerPayment(next)).userOpHash);
    expect(paid.status).toBe("succeeded");
    const sessionOp = await gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: contracts.usdc, to: payee, amount: USDC(5) })],
    });
    const viaSession = await waitForOperation(
      gateway,
      (await submitAsSession(gateway, sessionOp)).userOpHash,
    );
    expect(viaSession.status).toBe("succeeded");
  }, 120_000);

  it("Safe-native execTransaction: the new owner's works (outside the hook), the old owner's reverts", async () => {
    // Above maxPerTx and to a recipient outside the allowlist: only the owner's native path can do it.
    const exit = transferCall({ token: contracts.usdc, to: exitRecipient, amount: USDC(100) });
    const nonce = await safeNonce();
    const onchainHash = await forkClient.readContract({
      address: account,
      abi: safeAbi,
      functionName: "getTransactionHash",
      args: [exit.to, 0n, exit.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
    });
    expect(onchainHash).toBe(
      safeTxHash({ chainId: 31337, safe: account, to: exit.to, data: exit.data, nonce }),
    );
    await expect(execSafeTx(exit, owner)).rejects.toThrow(/GS026/);
    expect(await execSafeTx(exit, next)).toBe("success");
    expect(await usdcBalance(exitRecipient)).toBe(USDC(100));
    expect(await safeNonce()).toBe(nonce + 1n);
  }, 120_000);

  it("sessions cannot reach the OwnableValidator or swap the Safe owner", async () => {
    const attempts = [
      {
        to: contracts.ownableValidator,
        data: encodeFunctionData({
          abi: ownableValidatorAbi,
          functionName: "addOwner",
          args: [sessionKey.address],
        }),
      },
      ...ownerRotationCalls({ account, contracts, currentOwner: next.address, newOwner: sessionKey.address }),
    ];
    for (const call of attempts) {
      await expect(
        gateway.prepareOperation({ account, session: { permissionId }, calls: [call] }),
      ).rejects.toMatchObject({ code: "policy_denied" });
    }
  }, 120_000);

  it("after a Safe-only owner change (guardian recovery), safeNativeOwnerSyncCalls re-keys the validator", async () => {
    // A recovery swaps only the Safe owner (here through execTransaction signed by the current owner).
    const swap = encodeFunctionData({
      abi: safeAbi,
      functionName: "swapOwner",
      args: [SENTINEL_OWNERS, next.address, recovered.address],
    });
    expect(await execSafeTx({ to: account, data: swap }, next)).toBe("success");
    expect(await safeOwners()).toEqual([recovered.address]);
    expect(await validator("getOwners")).toEqual([next.address]);
    // Owner operations still validate against the stale OwnableValidator owner.
    await expect(ownerPayment(recovered)).rejects.toMatchObject({ code: "signature_invalid" });

    const sync = safeNativeOwnerSyncCalls({
      account,
      contracts,
      owners: { safe: await safeOwners(), validator: await validator("getOwners") },
    });
    expect(sync).toHaveLength(2);
    for (const call of sync) expect(await execSafeTx(call, recovered)).toBe("success");
    expect(await validator("getOwners")).toEqual([recovered.address]);
    const paid = await waitForOperation(gateway, (await ownerPayment(recovered)).userOpHash);
    expect(paid.status).toBe("succeeded");
    await expect(ownerPayment(next)).rejects.toMatchObject({ code: "signature_invalid" });
  }, 180_000);

  it("relayCall relays a spend key's USDC permit attached after setup; erc20Nonces tracks it", async () => {
    expect(await gateway.erc20Nonces(contracts.usdc, spendKey.address)).toBe(0n);
    const signature = await spendKey.signTypedData(
      spendKeyPermitTypedData({
        chainId: 31337,
        token: contracts.usdc,
        owner: spendKey.address,
        spender: account,
        value: maxUint256,
        nonce: await gateway.erc20Nonces(contracts.usdc, spendKey.address),
        deadline: maxUint256,
      }),
    );
    const call = permitCall(contracts.usdc, {
      owner: spendKey.address,
      spender: account,
      value: maxUint256,
      deadline: maxUint256,
      signature,
    });
    const { txHash } = await gateway.relayCall({ call });
    expect((await forkClient.waitForTransactionReceipt({ hash: txHash })).status).toBe("success");
    expect(
      await forkClient.readContract({
        address: contracts.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [spendKey.address, account],
      }),
    ).toBe(maxUint256);
    expect(await gateway.erc20Nonces(contracts.usdc, spendKey.address)).toBe(1n);
    // Replays fail the relay's dry run; other USDC functions are never relayed.
    await expect(gateway.relayCall({ call })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      gateway.relayCall({ call: transferCall({ token: contracts.usdc, to: payee, amount: 1n }) }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  }, 120_000);
});
