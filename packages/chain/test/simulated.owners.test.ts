import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  accountSetupCalls,
  disableModuleRegistryCall,
  encodePolicyHookConfig,
  MODULE_TYPE,
  ownableValidatorAbi,
  ownerRotationCalls,
  permitCall,
  policyHookConfig,
  safe7579Abi,
  safeAbi,
  safeNativeOwnerSyncCalls,
  SENTINEL_OWNERS,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  spendKeyPermitTypedData,
  transferCall,
  type Call,
  type SessionGrant,
} from "../src";
import { SimulatedChain } from "../src/simulated";
import {
  cosigner,
  owner,
  payee,
  revenue,
  scope,
  sessionKey,
  stranger,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "./helpers";
import { safeExecTransactionData } from "./safeTx";

function grantFor(chain: SimulatedChain): SessionGrant {
  return {
    sessionKey: sessionKey.address,
    cosigner: cosigner.address,
    salt: sessionSalt("ses_rotation"),
    scope: scope(chain, { allowedRecipients: [payee] }),
  };
}

/** Deploy an agent account with `accountSetupCalls` (or custom setup calls) in one owner operation. */
async function provision(chain: SimulatedChain, setup?: (account: Address, grant: SessionGrant) => Call[]) {
  const gw = chain.gateway;
  const c = chain.contracts;
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 7n };
  const account = await gw.predictAccountAddress(deployment);
  chain.faucet(account, USDC(500));
  const grant = grantFor(chain);
  const hookConfig = policyHookConfig(grant.scope, c, { extraRecipients: [revenue] });
  const calls = setup?.(account, grant) ?? accountSetupCalls({ account, contracts: c, grant, hookConfig });
  const op = await gw.prepareOwnerOperation({ account, deployment, calls });
  const receipt = await gw.getOperationReceipt((await submitAsOwner(gw, op)).userOpHash);
  expect(receipt.status).toBe("succeeded");
  return { account, permissionId: sessionPermissionId(grant, c) };
}

/** Send a Safe-native `execTransaction` signed by `signer` (who also sends it). */
async function execSafeTx(
  chain: SimulatedChain,
  account: Address,
  call: { to: Address; data: Hex },
  signer: PrivateKeyAccount,
) {
  const data = await safeExecTransactionData(
    {
      chainId: chain.chainId,
      safe: account,
      to: call.to,
      data: call.data,
      nonce: chain.account(account)?.safeNonce ?? 0n,
    },
    [signer],
  );
  return chain.transaction(chain.sendTransaction({ from: signer.address, to: account, data }));
}

function ownerPayment(chain: SimulatedChain, account: Address, amount = USDC(5)) {
  return chain.gateway.prepareOwnerOperation({
    account,
    calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount })],
  });
}

describe("owner key rotation on the simulator", () => {
  it("rotates Safe and OwnableValidator owners in one owner operation signed by the current owner", async () => {
    const chain = new SimulatedChain();
    const gw = chain.gateway;
    const c = chain.contracts;
    const { account, permissionId } = await provision(chain);
    const next = privateKeyToAccount(generatePrivateKey());
    expect(chain.account(account)?.safeOwners).toEqual([owner.address]);
    expect(chain.account(account)?.ownerValidator).toEqual({ threshold: 1, owners: [owner.address] });
    expect(chain.hook.contractKind(account, c.ownableValidator)).toBe("Generic");

    const rotation = await gw.prepareOwnerOperation({
      account,
      calls: ownerRotationCalls({
        account,
        contracts: c,
        currentOwner: owner.address,
        newOwner: next.address,
      }),
    });
    expect(rotation.calls.map((call) => call.args?.function)).toEqual([
      "swapOwner",
      "addOwner",
      "removeOwner",
    ]);
    await expect(submitAsOwner(gw, rotation, next)).rejects.toMatchObject({ code: "signature_invalid" });
    const receipt = await gw.getOperationReceipt((await submitAsOwner(gw, rotation, owner)).userOpHash);
    expect(receipt.status).toBe("succeeded");
    expect(chain.account(account)?.safeOwners).toEqual([next.address]);
    expect(chain.account(account)?.ownerValidator).toEqual({ threshold: 1, owners: [next.address] });

    // Owner operations: the new key signs, the old key no longer does.
    await expect(submitAsOwner(gw, await ownerPayment(chain, account), owner)).rejects.toMatchObject({
      code: "signature_invalid",
    });
    const paid = await submitAsOwner(gw, await ownerPayment(chain, account), next);
    expect((await gw.getOperationReceipt(paid.userOpHash)).status).toBe("succeeded");

    // The session path is unaffected.
    const sessionOp = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: c.usdc, to: payee, amount: USDC(5) })],
    });
    expect((await gw.getOperationReceipt((await submitAsSession(gw, sessionOp)).userOpHash)).status).toBe(
      "succeeded",
    );

    // Safe-native path (no hook: above maxPerTx, to a recipient outside the allowlist): the new owner's
    // execTransaction works, the old owner's is refused.
    const exit = transferCall({ token: c.usdc, to: stranger.address, amount: USDC(100) });
    expect(await execSafeTx(chain, account, exit, owner)).toMatchObject({
      success: false,
      revertReason: "GS026",
    });
    expect(await execSafeTx(chain, account, exit, next)).toMatchObject({ success: true });
    expect(chain.balanceOf(stranger.address)).toBe(USDC(100));
    expect(chain.balanceOf(account)).toBe(USDC(500) - USDC(110));
    expect(chain.account(account)?.safeNonce).toBe(1n);
  });

  it("without the OwnableValidator allowlisted, AgentPolicyHook blocks the rotation", async () => {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const { account } = await provision(chain, (account, grant) => {
      const config = policyHookConfig(grant.scope, c);
      const legacy = {
        ...config,
        allowedContracts: config.allowedContracts.filter((x) => x.target !== c.ownableValidator),
      };
      const hookData = encodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
        [0, "0x00000000", encodePolicyHookConfig(legacy)],
      );
      return [
        disableModuleRegistryCall({ account }),
        {
          to: account,
          data: encodeFunctionData({
            abi: safe7579Abi,
            functionName: "installModule",
            args: [MODULE_TYPE.hook, c.policyHook as Address, hookData],
          }),
        },
        ...sessionInstallCalls({ contracts: c, grant }),
      ];
    });
    const next = privateKeyToAccount(generatePrivateKey());
    await expect(
      chain.gateway.prepareOwnerOperation({
        account,
        calls: ownerRotationCalls({
          account,
          contracts: c,
          currentOwner: owner.address,
          newOwner: next.address,
        }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      extensions: { revertReason: `TargetNotAllowed(${c.ownableValidator})` },
    });
  });

  it("enforces the Safe and OwnableValidator linked-list rules", async () => {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const { account } = await provision(chain);
    const validatorCall = (data: Hex) => ({ to: c.ownableValidator, data });
    const addOwner = (o: Address) =>
      validatorCall(encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [o] }));
    const removeOwner = (prev: Address, o: Address) =>
      validatorCall(
        encodeFunctionData({ abi: ownableValidatorAbi, functionName: "removeOwner", args: [prev, o] }),
      );
    const expectRevert = async (calls: Call[], revertReason: string) =>
      expect(chain.gateway.prepareOwnerOperation({ account, calls })).rejects.toMatchObject({
        code: "invalid_state",
        extensions: { revertReason },
      });

    // A 1-of-1 validator cannot remove its only owner first.
    await expectRevert([removeOwner(SENTINEL_OWNERS, owner.address)], "CannotRemoveOwner()");
    // addOwner inserts at the head, so after it the old owner's predecessor is the new owner.
    await expectRevert(
      [addOwner(stranger.address), removeOwner(SENTINEL_OWNERS, owner.address)],
      `LinkedList_InvalidEntry(${owner.address})`,
    );
    await expectRevert([addOwner(owner.address)], `LinkedList_EntryAlreadyInList(${owner.address})`);
    await expectRevert(
      [
        {
          to: account,
          data: encodeFunctionData({
            abi: safeAbi,
            functionName: "swapOwner",
            args: [payee, owner.address, stranger.address],
          }),
        },
      ],
      "GS205",
    );
    await expectRevert(
      [
        {
          to: account,
          data: encodeFunctionData({
            abi: safeAbi,
            functionName: "swapOwner",
            args: [SENTINEL_OWNERS, owner.address, account],
          }),
        },
      ],
      "GS203",
    );
    // Valid: add then remove with the right predecessor.
    await expect(
      chain.gateway.prepareOwnerOperation({
        account,
        calls: [addOwner(stranger.address), removeOwner(stranger.address, owner.address)],
      }),
    ).resolves.toMatchObject({ signer: "owner" });
  });

  it("sessions can never call the OwnableValidator or swap the Safe owner", async () => {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const { account, permissionId } = await provision(chain);
    for (const call of [
      {
        to: c.ownableValidator,
        data: encodeFunctionData({
          abi: ownableValidatorAbi,
          functionName: "addOwner",
          args: [stranger.address],
        }),
      },
      ...ownerRotationCalls({
        account,
        contracts: c,
        currentOwner: owner.address,
        newOwner: stranger.address,
      }),
    ]) {
      await expect(
        chain.gateway.prepareOperation({ account, session: { permissionId }, calls: [call] }),
      ).rejects.toMatchObject({ code: "policy_denied" });
    }
  });

  it("re-syncs the OwnableValidator over the Safe-native path after a Safe-only owner change", async () => {
    const chain = new SimulatedChain();
    const gw = chain.gateway;
    const c = chain.contracts;
    const { account } = await provision(chain);
    const recovered = privateKeyToAccount(generatePrivateKey());

    // A recovery changes only the Safe owner (here: a Safe-native swapOwner signed by the old key).
    const swap = encodeFunctionData({
      abi: safeAbi,
      functionName: "swapOwner",
      args: [SENTINEL_OWNERS, owner.address, recovered.address],
    });
    expect(await execSafeTx(chain, account, { to: account, data: swap }, owner)).toMatchObject({
      success: true,
    });
    const drifted = chain.account(account);
    expect(drifted?.safeOwners).toEqual([recovered.address]);
    expect(drifted?.ownerValidator.owners).toEqual([owner.address]);
    // Owner operations still validate against the stale OwnableValidator owner.
    await expect(submitAsOwner(gw, await ownerPayment(chain, account), recovered)).rejects.toMatchObject({
      code: "signature_invalid",
    });

    const sync = safeNativeOwnerSyncCalls({
      account,
      contracts: c,
      owners: { safe: drifted?.safeOwners ?? [], validator: drifted?.ownerValidator.owners ?? [] },
    });
    expect(sync).toHaveLength(2);
    for (const call of sync) {
      expect(await execSafeTx(chain, account, call, recovered)).toMatchObject({ success: true });
    }
    expect(chain.account(account)?.ownerValidator).toEqual({ threshold: 1, owners: [recovered.address] });
    expect(chain.account(account)?.safeNonce).toBe(3n);
    const paid = await submitAsOwner(gw, await ownerPayment(chain, account), recovered);
    expect((await gw.getOperationReceipt(paid.userOpHash)).status).toBe("succeeded");
    await expect(submitAsOwner(gw, await ownerPayment(chain, account), owner)).rejects.toMatchObject({
      code: "signature_invalid",
    });
    // A failed inner call with safeTxGas = 0 reverts the whole Safe transaction (GS013).
    const tooMuch = transferCall({ token: c.usdc, to: stranger.address, amount: USDC(10_000) });
    expect(await execSafeTx(chain, account, tooMuch, recovered)).toMatchObject({
      success: false,
      revertReason: "GS013",
    });
    expect(chain.account(account)?.safeNonce).toBe(3n);
  });
});

describe("keeper relay of a spend key's USDC permit", () => {
  it("relays permit only, and reports EIP-2612 nonces", async () => {
    const chain = new SimulatedChain();
    const gw = chain.gateway;
    const c = chain.contracts;
    const { account } = await provision(chain);
    const spendKey = privateKeyToAccount(generatePrivateKey());
    expect(await gw.erc20Nonces(c.usdc, spendKey.address)).toBe(0n);
    const signature = await spendKey.signTypedData(
      spendKeyPermitTypedData({
        chainId: chain.chainId,
        token: c.usdc,
        owner: spendKey.address,
        spender: account,
        value: maxUint256,
        nonce: await gw.erc20Nonces(c.usdc, spendKey.address),
        deadline: maxUint256,
      }),
    );
    const call = permitCall(c.usdc, {
      owner: spendKey.address,
      spender: account,
      value: maxUint256,
      deadline: maxUint256,
      signature,
    });
    const { txHash } = await gw.relayCall({ call });
    expect(chain.transaction(txHash)?.success).toBe(true);
    expect(chain.usdc.allowance(spendKey.address, account)).toBe(maxUint256);
    expect(await gw.erc20Nonces(c.usdc, spendKey.address)).toBe(1n);
    // Replays fail the relay's dry run; other USDC functions are never relayed.
    await expect(gw.relayCall({ call })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      gw.relayCall({ call: transferCall({ token: c.usdc, to: payee, amount: 1n }) }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await gw.erc20Nonces(payee, spendKey.address)).toBe(0n);
  });
});
