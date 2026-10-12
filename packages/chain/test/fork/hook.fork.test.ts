import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import {
  agentPolicyHookAbi,
  anvilForkContracts,
  contractsFromDeployment,
  disableModuleRegistryCall,
  escrowLockCalls,
  MODULE_TYPE,
  policyHookConfig,
  policyHookInstallCalls,
  safe7579Abi,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  transferCall,
  type ChainContracts,
  type EvmChainGateway,
  type SessionGrant,
} from "../../src";
import {
  cosigner,
  otherPayee,
  owner,
  payee,
  revenue,
  sessionKey,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "../helpers";
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

describe.skipIf(!RUN)("fork e2e: AgentPolicyHook and AgentEscrow with Smart Sessions", () => {
  let gateway: EvmChainGateway;
  let contracts: ChainContracts;
  let account: Address;
  let permissionId: Hex;
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: BigInt(Date.now()) + 7n };

  const hookRead = <F extends "isInitialized" | "spentToday" | "tokenLimit">(
    functionName: F,
    args: readonly unknown[],
  ) =>
    forkClient.readContract({
      address: contracts.policyHook as Address,
      abi: agentPolicyHookAbi,
      functionName,
      args,
    } as never);

  async function pay(to: Address, amount: bigint) {
    const op = await gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: contracts.usdc, to, amount })],
    });
    const { userOpHash } = await submitAsSession(gateway, op);
    return waitForOperation(gateway, userOpHash);
  }

  beforeAll(async () => {
    await startForkEnv();
    const file = await ensureAgentBankContracts();
    contracts = contractsFromDeployment(anvilForkContracts(sessionModules), file, {
      useDeploymentUsdc: false,
    });
    gateway = forkGateway(contracts);
    account = await gateway.predictAccountAddress(deployment);
    await fundEth(account, "1");
    await mintUsdc(contracts.usdc, account, USDC(1000));
  }, 900_000);

  it("one owner operation deploys, disables the registry, installs the hook and enables a session", async () => {
    const issuedAt = Number((await forkClient.getBlock()).timestamp);
    const grant: SessionGrant = {
      sessionKey: sessionKey.address,
      cosigner: cosigner.address,
      salt: sessionSalt(`hook-${deployment.salt}`),
      scope: {
        token: contracts.usdc,
        maxPerTx: USDC(25),
        maxPerDay: USDC(100),
        allowedRecipients: [payee, revenue],
        allowedContracts: [contracts.escrow as Address],
        issuedAt,
        expiresAt: issuedAt + 3 * 86_400,
      },
    };
    permissionId = sessionPermissionId(grant, contracts);
    const config = policyHookConfig(grant.scope, contracts);
    const op = await gateway.prepareOwnerOperation({
      account,
      deployment,
      calls: [
        disableModuleRegistryCall({ account }),
        ...policyHookInstallCalls({ account, contracts, config }),
        ...sessionInstallCalls({ contracts, grant }),
      ],
    });
    expect(op.calls.map((c) => c.kind)).toEqual(["module_config", "module_config", "session_install"]);
    const { userOpHash } = await submitAsOwner(gateway, op);
    const receipt = await waitForOperation(gateway, userOpHash);
    expect(receipt.status).toBe("succeeded");
    expect(await hookRead("isInitialized", [account])).toBe(true);
    expect(await hookRead("tokenLimit", [account, contracts.usdc])).toEqual([USDC(25), USDC(100)]);
    expect(await gateway.isSessionEnabled(account, permissionId)).toBe(true);
  }, 180_000);

  it("a payment within the caps succeeds and the hook records it", async () => {
    const receipt = await pay(payee, USDC(25));
    expect(receipt.status).toBe("succeeded");
    expect(await hookRead("spentToday", [account, contracts.usdc])).toBe(USDC(25));
  }, 120_000);

  it("the hook refuses recipients outside its allowlist (caught when the bundler estimates gas)", async () => {
    await expect(pay(otherPayee, USDC(1))).rejects.toMatchObject({ code: "invalid_state" });
  }, 120_000);

  it("the hook's UTC-day cap holds and resets on the next UTC day", async () => {
    const now = Number((await forkClient.getBlock()).timestamp);
    // Stay within one UTC day for the first part.
    if (86_400 - (now % 86_400) < 600) await increaseTime(86_400 - (now % 86_400) + 60);
    const spent = (await hookRead("spentToday", [account, contracts.usdc])) as bigint;
    let total = spent;
    while (total + USDC(25) <= USDC(100)) {
      expect((await pay(payee, USDC(25))).status).toBe("succeeded");
      total += USDC(25);
    }
    await expect(pay(payee, USDC(25))).rejects.toMatchObject({ code: "invalid_state" });
    const t = Number((await forkClient.getBlock()).timestamp);
    await increaseTime(86_400 - (t % 86_400) + 60);
    expect((await pay(payee, USDC(25))).status).toBe("succeeded");
    expect(await hookRead("spentToday", [account, contracts.usdc])).toBe(USDC(25));
  }, 300_000);

  it("a session can lock an escrow for an allowlisted payee (approve + lock through session and hook)", async () => {
    const t = BigInt((await forkClient.getBlock()).timestamp);
    const op = await gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: escrowLockCalls({
        escrow: contracts.escrow as Address,
        token: contracts.usdc,
        payee,
        amount: USDC(10),
        expiresAt: t + 86_400n,
        termsHash: keccak256(toHex("esc_fork")),
      }),
    });
    expect(op.calls.map((c) => c.kind)).toEqual(["erc20_approve", "escrow_lock"]);
    const { userOpHash } = await submitAsSession(gateway, op);
    const receipt = await waitForOperation(gateway, userOpHash);
    expect(receipt.status).toBe("succeeded");
    const locked = receipt.logs.find((l) => l.eventName === "Locked");
    expect(locked?.args.payer).toBe(account);
    expect(locked?.args.amount).toBe(USDC(10).toString());
  }, 120_000);

  it("owner operations are hooked too: the owner uninstalls the hook, then withdraws everything", async () => {
    const balance = await gateway.getTokenBalance(contracts.usdc, account);
    const withdraw = [transferCall({ token: contracts.usdc, to: owner.address, amount: balance })];
    await expect(gateway.prepareOwnerOperation({ account, calls: withdraw })).rejects.toMatchObject({
      code: "invalid_state",
    });
    const uninstall = await gateway.prepareOwnerOperation({
      account,
      calls: [
        {
          to: account,
          data: encodeFunctionData({
            abi: safe7579Abi,
            functionName: "uninstallModule",
            args: [MODULE_TYPE.hook, contracts.policyHook as Address, ("0x" + "0".repeat(192)) as Hex],
          }),
        },
      ],
    });
    const u = await waitForOperation(gateway, (await submitAsOwner(gateway, uninstall)).userOpHash);
    expect(u.status).toBe("succeeded");
    const op = await gateway.prepareOwnerOperation({ account, calls: withdraw });
    const r = await waitForOperation(gateway, (await submitAsOwner(gateway, op)).userOpHash);
    expect(r.status).toBe("succeeded");
    expect(await gateway.getTokenBalance(contracts.usdc, account)).toBe(0n);
  }, 180_000);
});
