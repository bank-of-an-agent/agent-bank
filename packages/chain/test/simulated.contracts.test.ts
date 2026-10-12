import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  disableModuleRegistryCall,
  EARLY_WITHDRAWAL_TYPES,
  escrowDisputeCall,
  escrowLockCalls,
  escrowRefundCall,
  escrowReleaseByValidationCall,
  escrowReleaseCall,
  escrowResolveCall,
  MODULE_TYPE,
  policyHookConfig,
  policyHookInstallCalls,
  safe7579Abi,
  sessionInstallCalls,
  streamCancelCall,
  streamCreateCalls,
  streamSettleCall,
  streamTopUpCalls,
  TIME_LOCK_VAULTS_EIP712,
  topUpCall,
  topUpExecutorInstallCalls,
  transferCall,
  vaultCreateCall,
  vaultDepositCalls,
  vaultWithdrawCall,
  vaultWithdrawWithSignatureCall,
  type Call,
  type SessionGrant,
} from "../src";
import { SimulatedChain } from "../src/simulated";
import {
  cosigner,
  DEV_KEYS,
  otherPayee,
  owner,
  payee,
  revenue,
  scope,
  sessionKey,
  setupAgent,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "./helpers";

const arbiter = privateKeyToAccount(DEV_KEYS[6] as Hex);
const DAY = 86_400;

async function ownerOp(chain: SimulatedChain, account: Address, calls: Call[]) {
  const op = await chain.gateway.prepareOwnerOperation({ account, calls });
  const { userOpHash } = await submitAsOwner(chain.gateway, op);
  return chain.gateway.getOperationReceipt(userOpHash);
}

async function sessionOp(chain: SimulatedChain, account: Address, permissionId: Hex, calls: Call[]) {
  const op = await chain.gateway.prepareOperation({ account, session: { permissionId }, calls });
  const { userOpHash } = await submitAsSession(chain.gateway, op);
  return chain.gateway.getOperationReceipt(userOpHash);
}

describe("AgentPolicyHook in the simulator (same scenario as the fork test)", () => {
  async function setup() {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 7n };
    const account = await chain.gateway.predictAccountAddress(deployment);
    chain.faucet(account, USDC(1000));
    const now = chain.nowSeconds();
    const grant: SessionGrant = {
      sessionKey: sessionKey.address,
      cosigner: cosigner.address,
      salt: keccak256(toHex("hook")),
      scope: scope(chain, {
        allowedRecipients: [payee, revenue],
        allowedContracts: [c.escrow as Address],
        issuedAt: now,
        expiresAt: now + 3 * DAY,
      }),
    };
    const op = await chain.gateway.prepareOwnerOperation({
      account,
      deployment,
      calls: [
        disableModuleRegistryCall({ account }),
        ...policyHookInstallCalls({ account, contracts: c, config: policyHookConfig(grant.scope, c) }),
        ...sessionInstallCalls({ contracts: c, grant }),
      ],
    });
    const { userOpHash } = await submitAsOwner(chain.gateway, op);
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("succeeded");
    const { sessionPermissionId } = await import("../src");
    return { chain, account, permissionId: sessionPermissionId(grant, c) };
  }

  it("enforces recipients, the per-operation cap including fees, and UTC-day caps that reset", async () => {
    const { chain, account, permissionId } = await setup();
    const usdc = chain.contracts.usdc;
    const r1 = await sessionOp(chain, account, permissionId, [
      transferCall({ token: usdc, to: payee, amount: USDC(25) }),
    ]);
    expect(r1.logs.map((l) => l.eventName)).toEqual(["SpendRecorded", "Transfer"]);
    expect(chain.hook.spentToday(account, usdc, chain.nextTimestamp())).toBe(USDC(25));
    // Not allowlisted: execution would revert, caught when the operation is prepared.
    await expect(
      chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: usdc, to: otherPayee, amount: 1n })],
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // Payment + fee in one operation counts against the per-operation cap.
    await expect(
      chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [
          transferCall({ token: usdc, to: payee, amount: USDC(25) }),
          transferCall({ token: usdc, to: revenue, amount: 1n }),
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // Make sure the rest of the day has room for three more payments, then hit the cap.
    const now = chain.nowSeconds();
    if (DAY - (now % DAY) < 3600) chain.advanceTime(DAY - (now % DAY) + 60);
    let spent = chain.hook.spentToday(account, usdc, chain.nextTimestamp());
    while (spent + USDC(25) <= USDC(100)) {
      expect(
        (
          await sessionOp(chain, account, permissionId, [
            transferCall({ token: usdc, to: payee, amount: USDC(25) }),
          ])
        ).status,
      ).toBe("succeeded");
      spent += USDC(25);
    }
    await expect(
      chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: usdc, to: payee, amount: USDC(25) })],
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const t = chain.nowSeconds();
    chain.advanceTime(DAY - (t % DAY) + 60);
    expect(
      (
        await sessionOp(chain, account, permissionId, [
          transferCall({ token: usdc, to: payee, amount: USDC(25) }),
        ])
      ).status,
    ).toBe("succeeded");
  });

  it("an operation that passed estimation reverts on inclusion if the cap was used up meanwhile", async () => {
    const { chain, account, permissionId } = await setup();
    const usdc = chain.contracts.usdc;
    const now = chain.nowSeconds();
    if (DAY - (now % DAY) < 3600) chain.advanceTime(DAY - (now % DAY) + 60);
    for (let i = 0; i < 3; i++) {
      await sessionOp(chain, account, permissionId, [
        transferCall({ token: usdc, to: payee, amount: USDC(25) }),
      ]);
    }
    const stale = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: usdc, to: payee, amount: USDC(25) })],
    });
    // Owner operations use another nonce key and are hooked too: this one uses up the day.
    expect(
      (await ownerOp(chain, account, [transferCall({ token: usdc, to: payee, amount: USDC(25) })])).status,
    ).toBe("succeeded");
    const before = chain.balanceOf(account);
    const { userOpHash } = await submitAsSession(chain.gateway, stale);
    const receipt = await chain.gateway.getOperationReceipt(userOpHash);
    expect(receipt.status).toBe("reverted");
    expect(receipt.revertReason).toMatch(/DailyLimitExceeded/);
    expect(receipt.logs.map((l) => l.eventName)).toEqual(["UserOperationRevertReason"]);
    expect(chain.balanceOf(account)).toBe(before);
  });

  it("installing Agent Bank modules needs the registry disabled first", async () => {
    const chain = new SimulatedChain();
    const { account } = await setupAgent(chain);
    const config = policyHookConfig(scope(chain), chain.contracts);
    await expect(
      chain.gateway.prepareOwnerOperation({
        account,
        calls: policyHookInstallCalls({ account, contracts: chain.contracts, config }),
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const r = await ownerOp(chain, account, [
      disableModuleRegistryCall({ account }),
      ...policyHookInstallCalls({ account, contracts: chain.contracts, config }),
    ]);
    expect(r.status).toBe("succeeded");
    expect(chain.account(account)?.globalHook).toBe(chain.contracts.policyHook);
  });

  it("owner operations are hooked: uninstall the hook, then withdraw", async () => {
    const { chain, account } = await setup();
    const usdc = chain.contracts.usdc;
    const withdraw = [transferCall({ token: usdc, to: owner.address, amount: USDC(1000) })];
    await expect(chain.gateway.prepareOwnerOperation({ account, calls: withdraw })).rejects.toMatchObject({
      code: "invalid_state",
    });
    const uninstall: Call = {
      to: account,
      data: encodeFunctionData({
        abi: safe7579Abi,
        functionName: "uninstallModule",
        args: [MODULE_TYPE.hook, chain.contracts.policyHook as Address, `0x${"0".repeat(192)}`],
      }),
    };
    expect((await ownerOp(chain, account, [uninstall])).status).toBe("succeeded");
    expect((await ownerOp(chain, account, withdraw)).status).toBe("succeeded");
    expect(chain.balanceOf(owner.address)).toBe(USDC(1000));
  });
});

describe("AgentEscrow", () => {
  async function agent(chain: SimulatedChain) {
    return setupAgent(chain, { scope: { allowedContracts: [chain.contracts.escrow as Address] } });
  }

  it("lock (approve + lock) and release by the payer", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await agent(chain);
    const c = chain.contracts;
    const expiresAt = BigInt(chain.nowSeconds() + DAY);
    const lock = await sessionOp(chain, account, permissionId, [
      ...escrowLockCalls({
        escrow: c.escrow as Address,
        token: c.usdc,
        payee,
        amount: USDC(10),
        expiresAt,
        termsHash: keccak256(toHex("esc_1")),
      }),
      transferCall({ token: c.usdc, to: revenue, amount: USDC(1) }),
    ]);
    expect(lock.status).toBe("succeeded");
    const locked = lock.logs.find((l) => l.eventName === "Locked");
    expect(locked?.args).toMatchObject({ id: "1", payer: account, payee, amount: USDC(10).toString() });
    expect(chain.balanceOf(c.escrow as Address)).toBe(USDC(10));
    expect(chain.escrow.totalLocked(c.usdc)).toBe(USDC(10));
    const release = await sessionOp(chain, account, permissionId, [
      escrowReleaseCall({ escrow: c.escrow as Address, escrowId: 1n }),
    ]);
    expect(release.logs.find((l) => l.eventName === "Released")?.args).toMatchObject({
      id: "1",
      payee,
      caller: account,
      reason: "0",
    });
    expect(chain.balanceOf(payee)).toBe(USDC(10));
    expect(chain.getEscrow(1n)?.status).toBe("Released");
    await expect(
      chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [escrowReleaseCall({ escrow: c.escrow as Address, escrowId: 1n })],
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refund by the payee, refund after expiry by a keeper, dispute and resolve by the arbiter", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await agent(chain);
    const c = chain.contracts;
    const escrow = c.escrow as Address;
    const now = BigInt(chain.nowSeconds());
    for (let i = 0; i < 3; i++) {
      await sessionOp(
        chain,
        account,
        permissionId,
        escrowLockCalls({
          escrow,
          token: c.usdc,
          payee,
          amount: USDC(5),
          expiresAt: now + BigInt(DAY),
          arbiter: arbiter.address,
          termsHash: keccak256(toHex(`esc_${i}`)),
        }),
      );
    }
    // 1: the payee refunds voluntarily (an EOA transaction).
    chain.sendTransaction({ from: payee, to: escrow, data: escrowRefundCall({ escrow, escrowId: 1n }).data });
    expect(chain.getEscrow(1n)?.status).toBe("Refunded");
    // 2: disputed by the payer, resolved 60/40 by the arbiter.
    await sessionOp(chain, account, permissionId, [escrowDisputeCall({ escrow, escrowId: 2n })]);
    expect(chain.getEscrow(2n)?.status).toBe("Disputed");
    chain.sendTransaction({
      from: arbiter.address,
      to: escrow,
      data: escrowResolveCall({ escrow, escrowId: 2n, payeeAmount: USDC(3) }).data,
    });
    expect(chain.getEscrow(2n)?.status).toBe("Resolved");
    expect(chain.balanceOf(payee)).toBe(USDC(3));
    // 3: a keeper cannot refund before expiry, can after.
    await expect(
      chain.gateway.relayCall({ call: escrowRefundCall({ escrow, escrowId: 3n }) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    chain.advanceTime(DAY + 1);
    await chain.gateway.relayCall({ call: escrowRefundCall({ escrow, escrowId: 3n }) });
    const refunded = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: chain.head.number,
      events: ["Refunded"],
    });
    expect(refunded.map((l) => [l.args.id, l.args.reason])).toEqual([
      ["1", "0"],
      ["3", "1"],
    ]);
    expect(chain.balanceOf(account)).toBe(USDC(1000) - USDC(15) + USDC(5) + USDC(2) + USDC(5));
    expect(chain.escrow.totalLocked(c.usdc)).toBe(0n);
  });

  it("releaseByValidation with an ERC-8004 response", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await agent(chain);
    const c = chain.contracts;
    const escrow = c.escrow as Address;
    const requestHash = keccak256(toHex("validation-request"));
    await sessionOp(
      chain,
      account,
      permissionId,
      escrowLockCalls({
        escrow,
        token: c.usdc,
        payee,
        amount: USDC(4),
        expiresAt: BigInt(chain.nowSeconds() + DAY),
        validator: arbiter.address,
        validationRequestHash: requestHash,
        validationThreshold: 80,
        termsHash: keccak256(toHex("v")),
      }),
    );
    await expect(
      chain.gateway.relayCall({ call: escrowReleaseByValidationCall({ escrow, escrowId: 1n }) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    chain.setValidationStatus(requestHash, { validator: arbiter.address, response: 79 });
    await expect(
      chain.gateway.relayCall({ call: escrowReleaseByValidationCall({ escrow, escrowId: 1n }) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    chain.setValidationStatus(requestHash, { validator: arbiter.address, response: 90 });
    await chain.gateway.relayCall({ call: escrowReleaseByValidationCall({ escrow, escrowId: 1n }) });
    expect(chain.getEscrow(1n)?.status).toBe("Released");
    expect(chain.balanceOf(payee)).toBe(USDC(4));
  });
});

describe("PaymentStreams", () => {
  it("create, accrue, keeper settle, top up and cancel with refund", async () => {
    const chain = new SimulatedChain();
    const streams = chain.contracts.streams as Address;
    const { account, permissionId } = await setupAgent(chain, { scope: { allowedContracts: [streams] } });
    const usdc = chain.contracts.usdc;
    const created = await sessionOp(
      chain,
      account,
      permissionId,
      streamCreateCalls({
        streams,
        token: usdc,
        payee,
        deposit: USDC(10),
        amountPerInterval: USDC(1),
        interval: 3600n,
      }),
    );
    const event = created.logs.find((l) => l.eventName === "StreamCreated");
    expect(event?.args).toMatchObject({
      id: "1",
      payer: account,
      payee,
      deposit: USDC(10).toString(),
      interval: "3600",
    });
    chain.advanceTime(2 * 3600 + 10);
    const { txHash } = await chain.gateway.relayCall({ call: streamSettleCall({ streams, streamId: 1n }) });
    expect(chain.transaction(txHash)?.logs.find((l) => l.eventName === "StreamSettled")?.args.amount).toBe(
      USDC(2).toString(),
    );
    expect(chain.balanceOf(payee)).toBe(USDC(2));
    await sessionOp(
      chain,
      account,
      permissionId,
      streamTopUpCalls({ streams, token: usdc, streamId: 1n, amount: USDC(5) }),
    );
    expect(chain.getStream(1n)?.deposit).toBe(USDC(15));
    chain.advanceTime(3600);
    const cancel = await sessionOp(chain, account, permissionId, [
      streamCancelCall({ streams, streamId: 1n }),
    ]);
    const canceled = cancel.logs.find((l) => l.eventName === "StreamCanceled");
    expect(canceled?.args).toMatchObject({
      payeeAmount: USDC(1).toString(),
      refundAmount: USDC(12).toString(),
    });
    expect(chain.balanceOf(payee)).toBe(USDC(3));
    expect(chain.streams.totalOutstanding(usdc)).toBe(0n);
  });
});

describe("TimeLockVaults", () => {
  it("deposits by the agent, no early withdrawal without the owner, owner-signed early withdrawal, withdrawal after unlock", async () => {
    const chain = new SimulatedChain();
    const vaults = chain.contracts.vaults as Address;
    const { account, permissionId } = await setupAgent(chain, { scope: { allowedContracts: [vaults] } });
    const usdc = chain.contracts.usdc;
    const unlockAt = BigInt(chain.nowSeconds() + 30 * DAY);
    const created = await sessionOp(chain, account, permissionId, [
      vaultCreateCall({ vaults, token: usdc, unlockAt, owner: owner.address }),
    ]);
    expect(created.logs.find((l) => l.eventName === "VaultCreated")?.args).toMatchObject({
      id: "1",
      account,
      owner: owner.address,
    });
    await sessionOp(
      chain,
      account,
      permissionId,
      vaultDepositCalls({ vaults, token: usdc, vaultId: 1n, amount: USDC(20) }),
    );
    expect(chain.vaults.totalHeld(usdc)).toBe(USDC(20));
    await expect(
      chain.gateway.relayCall({ call: vaultWithdrawCall({ vaults, vaultId: 1n, amount: USDC(5) }) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const deadline = BigInt(chain.nowSeconds() + 3600);
    const signature = await owner.signTypedData({
      domain: { ...TIME_LOCK_VAULTS_EIP712, chainId: chain.chainId, verifyingContract: vaults },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal",
      message: { vaultId: 1n, amount: USDC(5), nonce: 0n, deadline },
    });
    // A session key's signature is not the owner's.
    const forged = await sessionKey.signTypedData({
      domain: { ...TIME_LOCK_VAULTS_EIP712, chainId: chain.chainId, verifyingContract: vaults },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal",
      message: { vaultId: 1n, amount: USDC(5), nonce: 0n, deadline },
    });
    await expect(
      chain.gateway.relayCall({
        call: vaultWithdrawWithSignatureCall({
          vaults,
          vaultId: 1n,
          amount: USDC(5),
          deadline,
          signature: forged,
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const before = chain.balanceOf(account);
    await chain.gateway.relayCall({
      call: vaultWithdrawWithSignatureCall({ vaults, vaultId: 1n, amount: USDC(5), deadline, signature }),
    });
    expect(chain.balanceOf(account)).toBe(before + USDC(5));
    // The signature is single-use (nonce).
    await expect(
      chain.gateway.relayCall({
        call: vaultWithdrawWithSignatureCall({ vaults, vaultId: 1n, amount: USDC(5), deadline, signature }),
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    chain.advanceTime(31 * DAY);
    await chain.gateway.relayCall({ call: vaultWithdrawCall({ vaults, vaultId: 1n, amount: USDC(15) }) });
    expect(chain.balanceOf(account)).toBe(before + USDC(20));
    const withdrawn = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: chain.head.number,
      events: ["Withdrawn"],
    });
    expect(withdrawn.map((l) => l.args.early)).toEqual(["true", "false"]);
  });
});

describe("TopUpExecutor", () => {
  it("a keeper refills an agent from its treasury within the treasury's daily cap", async () => {
    const chain = new SimulatedChain();
    const executor = chain.contracts.topUpExecutor as Address;
    const usdc = chain.contracts.usdc;
    const { account: agentAccount } = await setupAgent(chain, { fund: USDC(5) });
    const treasury = await chain.gateway.predictAccountAddress({
      owner: owner.address,
      cosigner: cosigner.address,
      salt: 99n,
    });
    chain.faucet(treasury, USDC(500));
    const op = await chain.gateway.prepareOwnerOperation({
      account: treasury,
      deployment: { owner: owner.address, cosigner: cosigner.address, salt: 99n },
      calls: [
        disableModuleRegistryCall({ account: treasury }),
        ...topUpExecutorInstallCalls({
          account: treasury,
          contracts: chain.contracts,
          rules: [
            {
              agent: agentAccount,
              token: usdc,
              refillTo: USDC(50),
              whenBelow: USDC(20),
              maxPerDay: USDC(60),
            },
          ],
        }),
      ],
    });
    await submitAsOwner(chain.gateway, op);
    const { txHash } = await chain.gateway.relayCall({
      call: topUpCall({ executor, treasury, agent: agentAccount }),
    });
    expect(chain.transaction(txHash)?.logs.map((l) => l.eventName)).toEqual(["ToppedUp", "Transfer"]);
    expect(chain.balanceOf(agentAccount)).toBe(USDC(50));
    await expect(
      chain.gateway.relayCall({ call: topUpCall({ executor, treasury, agent: agentAccount }) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // Drain the agent, refill again: capped by the remaining daily allowance (60 - 45 = 15).
    await ownerOp(chain, agentAccount, [transferCall({ token: usdc, to: owner.address, amount: USDC(50) })]);
    await chain.gateway.relayCall({ call: topUpCall({ executor, treasury, agent: agentAccount }) });
    expect(chain.balanceOf(agentAccount)).toBe(USDC(15));
  });
});
