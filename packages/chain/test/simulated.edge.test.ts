import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import {
  agentPolicyHookAbi,
  approveCall,
  checkPreparedOperation,
  disableModuleRegistryCall,
  encodeExecute,
  escrowLockCalls,
  policyHookConfig,
  policyHookInstallCalls,
  streamCreateCalls,
  topUpCall,
  topUpExecutorAbi,
  topUpExecutorInstallCalls,
  transferCall,
  validatorNonceKey,
  vaultCreateCall,
  vaultDepositCalls,
  type Call,
} from "../src";
import { SimulatedChain } from "../src/simulated";
import { cosigner, otherPayee, owner, payee, scope, setupAgent, submitAsOwner, USDC } from "./helpers";

describe("checkPreparedOperation (what the co-signer relies on)", () => {
  it("rejects operations for other chains, entry points, senders or signer paths", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const gw = chain.gateway;
    const op = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: 1n })],
    });
    expect(() => checkPreparedOperation(op, gw)).not.toThrow();
    expect(() => checkPreparedOperation({ ...op, chainId: 8453 }, gw)).toThrow(/mainnet/i);
    expect(() => checkPreparedOperation({ ...op, chainId: 84532 }, gw)).toThrow(/chain 84532/);
    expect(() => checkPreparedOperation({ ...op, entryPoint: payee }, gw)).toThrow(/EntryPoint/);
    expect(() => checkPreparedOperation({ ...op, account: payee }, gw)).toThrow(/sender/);
    // An operation claiming the session path but routed to the owner validator (or vice versa).
    expect(() => checkPreparedOperation({ ...op, signer: "owner" }, gw)).toThrow(/signer/);
    const ownerNonce = ((validatorNonceKey(chain.contracts.ownableValidator) << 64n) | 1n).toString();
    expect(() => checkPreparedOperation({ ...op, userOp: { ...op.userOp, nonce: ownerNonce } }, gw)).toThrow(
      /signer/,
    );
    expect(() => gw.decodeOperation({ ...op, userOp: { ...op.userOp, callData: "0x12" } })).not.toThrow();
    expect(gw.decodeOperation({ ...op, userOp: { ...op.userOp, callData: "0x12" } })[0]?.kind).toBe(
      "unknown",
    );
  });
});

describe("AgentPolicyHook edge cases", () => {
  async function hooked(allowedRecipients: Address[] = [payee]) {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const { account } = await setupAgent(chain);
    const config = policyHookConfig(
      scope(chain, {
        allowedRecipients,
        allowedContracts: [c.escrow as Address, c.streams as Address, c.vaults as Address],
      }),
      c,
    );
    const op = await chain.gateway.prepareOwnerOperation({
      account,
      calls: [
        disableModuleRegistryCall({ account }),
        ...policyHookInstallCalls({ account, contracts: c, config }),
      ],
    });
    await submitAsOwner(chain.gateway, op);
    const prepare = (calls: Call[]) => chain.gateway.prepareOwnerOperation({ account, calls });
    return { chain, c, account, prepare };
  }

  it("covers payees routed through Agent Bank contracts by the recipient allowlist", async () => {
    const { chain, c, prepare } = await hooked();
    const expiresAt = BigInt(chain.nowSeconds() + 3600);
    const lock = (to: Address) =>
      escrowLockCalls({
        escrow: c.escrow as Address,
        token: c.usdc,
        payee: to,
        amount: 1n,
        expiresAt,
        termsHash: keccak256("0x01"),
      });
    await expect(prepare(lock(payee))).resolves.toBeDefined();
    await expect(prepare(lock(otherPayee))).rejects.toMatchObject({ code: "invalid_state" });
    const stream = (to: Address) =>
      streamCreateCalls({
        streams: c.streams as Address,
        token: c.usdc,
        payee: to,
        deposit: 1n,
        amountPerInterval: 1n,
        interval: 60n,
      });
    await expect(prepare(stream(payee))).resolves.toBeDefined();
    await expect(prepare(stream(otherPayee))).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("checks a vault deposit's parent account, approvals' spenders, unknown targets and hook calls", async () => {
    const { chain, c, account, prepare } = await hooked();
    const vaults = c.vaults as Address;
    const unlockAt = BigInt(chain.nowSeconds() + 86_400);
    const created = await prepare([
      vaultCreateCall({ vaults, token: c.usdc, unlockAt, owner: owner.address }),
    ]);
    await submitAsOwner(chain.gateway, created);
    expect(chain.getVault(1n)?.account).toBe(account);
    // Depositing into the account's own vault is allowed (its parent is the account itself).
    await expect(
      prepare(vaultDepositCalls({ vaults, token: c.usdc, vaultId: 1n, amount: 1n })),
    ).resolves.toBeDefined();
    await expect(
      prepare([approveCall({ token: c.usdc, spender: otherPayee, amount: 1n })]),
    ).rejects.toMatchObject({
      code: "invalid_state",
      extensions: { revertReason: expect.stringMatching(/SpenderNotAllowed/) },
    });
    // Revoking an approval to anyone is fine.
    await expect(
      prepare([approveCall({ token: c.usdc, spender: otherPayee, amount: 0n })]),
    ).resolves.toBeDefined();
    await expect(prepare([{ to: c.topUpExecutor as Address, data: "0x12345678" }])).rejects.toMatchObject({
      extensions: { revertReason: expect.stringMatching(/TargetNotAllowed/) },
    });
    const hookCall = encodeFunctionData({
      abi: agentPolicyHookAbi,
      functionName: "setRecipientAllowlistEnabled",
      args: [false],
    });
    await expect(prepare([{ to: c.policyHook as Address, data: hookCall }])).rejects.toMatchObject({
      extensions: { revertReason: expect.stringMatching(/HookCallBlocked/) },
    });
    const permit = "0xd505accf" as Hex;
    await expect(prepare([{ to: c.usdc, data: permit }])).rejects.toMatchObject({
      extensions: { revertReason: expect.stringMatching(/UnsupportedTokenCall/) },
    });
    // Transfers back into the account itself are not outflows.
    await expect(
      prepare([transferCall({ token: c.usdc, to: account, amount: USDC(500) })]),
    ).resolves.toBeDefined();
  });

  it("without a recipient allowlist any recipient is fine but caps still apply", async () => {
    const { c, prepare } = await hooked([]);
    await expect(
      prepare([transferCall({ token: c.usdc, to: otherPayee, amount: USDC(25) })]),
    ).resolves.toBeDefined();
    await expect(
      prepare([transferCall({ token: c.usdc, to: otherPayee, amount: USDC(26) })]),
    ).rejects.toMatchObject({
      extensions: { revertReason: expect.stringMatching(/PerTxLimitExceeded/) },
    });
  });
});

describe("TopUpExecutor configuration", () => {
  it("treasury rules can be changed and removed; triggers fail without a rule or above the threshold", async () => {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const executor = c.topUpExecutor as Address;
    const { account: agent } = await setupAgent(chain, { fund: USDC(30) });
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 77n };
    const treasury = await chain.gateway.predictAccountAddress(deployment);
    chain.faucet(treasury, USDC(100));
    await submitAsOwner(
      chain.gateway,
      await chain.gateway.prepareOwnerOperation({
        account: treasury,
        deployment,
        calls: [
          disableModuleRegistryCall({ account: treasury }),
          ...topUpExecutorInstallCalls({ account: treasury, contracts: c, rules: [] }),
        ],
      }),
    );
    await expect(
      chain.gateway.relayCall({ call: topUpCall({ executor, treasury, agent }) }),
    ).rejects.toMatchObject({
      extensions: { revertReason: expect.stringMatching(/RuleNotFound/) },
    });
    const setRule = encodeFunctionData({
      abi: topUpExecutorAbi,
      functionName: "setRule",
      args: [agent, c.usdc, USDC(50), USDC(20), USDC(100)],
    });
    const op = await chain.gateway.prepareOwnerOperation({
      account: treasury,
      calls: [{ to: executor, data: setRule }],
    });
    expect(op.calls[0]?.kind).toBe("module_config");
    await submitAsOwner(chain.gateway, op);
    // 30 is not below 20: nothing to do.
    await expect(
      chain.gateway.relayCall({ call: topUpCall({ executor, treasury, agent }) }),
    ).rejects.toMatchObject({
      extensions: { revertReason: expect.stringMatching(/NotBelowThreshold/) },
    });
    const remove = encodeFunctionData({ abi: topUpExecutorAbi, functionName: "removeRule", args: [agent] });
    await submitAsOwner(
      chain.gateway,
      await chain.gateway.prepareOwnerOperation({
        account: treasury,
        calls: [{ to: executor, data: remove }],
      }),
    );
    expect(chain.topUp.getRule(treasury, agent)).toBeUndefined();
    expect(chain.topUp.preview(treasury, agent, chain.nextTimestamp())).toBe(0n);
  });
});

describe("raw execute calldata", () => {
  it("decodes what prepareOwnerOperation encodes", async () => {
    const chain = new SimulatedChain();
    const { account } = await setupAgent(chain);
    const calls = [transferCall({ token: chain.contracts.usdc, to: payee, amount: 1n })];
    const op = await chain.gateway.prepareOwnerOperation({ account, calls });
    expect(op.userOp.callData).toBe(encodeExecute(calls));
    expect(op.userOp.factory).toBeNull();
    expect(toHex(BigInt(op.userOp.nonce) >> 64n)).toBe(
      toHex(validatorNonceKey(chain.contracts.ownableValidator)),
    );
  });
});
