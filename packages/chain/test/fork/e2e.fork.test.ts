import { beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { toSafeSmartAccount } from "permissionless/accounts";
import {
  accountSaltNonce,
  encodeOwnableValidatorConfig,
  encodeSessionSignature,
  RHINESTONE_ATTESTER,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  signOperationHash,
  transferCall,
  type EvmChainGateway,
  type SessionGrant,
} from "../../src";
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
  forkClient,
  forkGateway,
  fundEth,
  increaseTime,
  mintUsdc,
  startForkEnv,
  waitForOperation,
} from "./forkEnv";

const RUN = process.env.RUN_FORK_TESTS === "1";

describe.skipIf(!RUN)(
  "fork e2e: Safe7579 + Smart Sessions on an Anvil fork of Base Sepolia, Alto bundler",
  () => {
    let gateway: EvmChainGateway;
    let account: Address;
    let permissionId: Hex;
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: BigInt(Date.now()) };

    beforeAll(async () => {
      await startForkEnv();
      gateway = forkGateway();
      account = await gateway.predictAccountAddress(deployment);
      await fundEth(account, "1");
      await mintUsdc(gateway.contracts.usdc, account, USDC(1000));
    }, 900_000);

    it("predicts the same counterfactual address as permissionless", async () => {
      const reference = await toSafeSmartAccount({
        client: forkClient,
        owners: [owner],
        version: "1.4.1",
        entryPoint: { address: gateway.contracts.entryPoint, version: "0.7" },
        safe4337ModuleAddress: gateway.contracts.safe7579,
        erc7579LaunchpadAddress: gateway.contracts.safe7579Launchpad,
        safeSingletonAddress: gateway.contracts.safeSingleton,
        attesters: [RHINESTONE_ATTESTER],
        attestersThreshold: 1,
        validators: [
          {
            address: gateway.contracts.ownableValidator,
            context: encodeOwnableValidatorConfig(1, [owner.address]),
          },
          { address: gateway.contracts.smartSessions, context: "0x" },
        ],
        saltNonce: accountSaltNonce(deployment),
      });
      expect(await reference.getAddress()).toBe(account);
    });

    it("owner operation deploys the account and installs a 2-of-2 session", async () => {
      const now = Math.floor(Date.now() / 1000);
      const block = await forkClient.getBlock();
      const issuedAt = Number(block.timestamp);
      const grant: SessionGrant = {
        sessionKey: sessionKey.address,
        cosigner: cosigner.address,
        salt: sessionSalt(`fork-${now}`),
        scope: {
          token: gateway.contracts.usdc,
          maxPerTx: USDC(25),
          maxPerDay: USDC(100),
          allowedRecipients: [],
          allowedContracts: [],
          issuedAt,
          expiresAt: issuedAt + 24 * 3600,
        },
      };
      permissionId = sessionPermissionId(grant, gateway.contracts);
      expect(await gateway.isDeployed(account)).toBe(false);
      const op = await gateway.prepareOwnerOperation({
        account,
        deployment,
        calls: sessionInstallCalls({ contracts: gateway.contracts, grant }),
      });
      expect(op.userOp.factory).toBe(gateway.contracts.safeProxyFactory);
      expect(op.calls[0]?.kind).toBe("session_install");
      const { userOpHash } = await submitAsOwner(gateway, op);
      const receipt = await waitForOperation(gateway, userOpHash);
      expect(receipt.status).toBe("succeeded");
      expect(await gateway.isDeployed(account)).toBe(true);
      expect(await gateway.isSessionEnabled(account, permissionId)).toBe(true);
      const created = receipt.logs.find((l) => l.eventName === "SessionCreated");
      expect(created?.args.permissionId).toBe(permissionId);
      // AccountDeployed is emitted during validation: not in the receipt's logs, but on-chain.
      expect(receipt.logs.some((l) => l.eventName === "AccountDeployed")).toBe(false);
      const deployedLogs = await gateway.getLogs({
        fromBlock: receipt.blockNumber as bigint,
        toBlock: receipt.blockNumber as bigint,
        events: ["AccountDeployed", "UserOperationEvent"],
        involving: [account],
      });
      expect(deployedLogs.map((l) => l.eventName)).toEqual(["AccountDeployed", "UserOperationEvent"]);
      expect(deployedLogs[1]?.args.userOpHash).toBe(userOpHash);
    }, 120_000);

    it("session key + co-signer transfer within scope succeeds (with a batched fee)", async () => {
      const op = await gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [
          transferCall({ token: gateway.contracts.usdc, to: payee, amount: USDC(20) }),
          transferCall({ token: gateway.contracts.usdc, to: revenue, amount: 40_000n }),
        ],
      });
      const before = await gateway.getTokenBalance(gateway.contracts.usdc, payee);
      const { userOpHash } = await submitAsSession(gateway, op);
      const receipt = await waitForOperation(gateway, userOpHash);
      expect(receipt.status).toBe("succeeded");
      expect(await gateway.getTokenBalance(gateway.contracts.usdc, payee)).toBe(before + USDC(20));
      expect(
        receipt.logs.filter((l) => l.eventName === "Transfer").map((l) => getAddress(l.args.to as string)),
      ).toEqual([payee, revenue]);
    }, 120_000);

    it("the co-signer alone fails", async () => {
      const op = await gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: gateway.contracts.usdc, to: payee, amount: USDC(1) })],
      });
      const sig = await signOperationHash(cosigner, op.userOpHash);
      await expect(
        gateway.submitOperation({
          op,
          signature: encodeSessionSignature({ permissionId, sessionSignature: sig, cosignerSignature: sig }),
        }),
      ).rejects.toMatchObject({ code: "signature_invalid" });
    }, 120_000);

    it("the session key alone fails (also with a third key as 'co-signer')", async () => {
      const op = await gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: gateway.contracts.usdc, to: payee, amount: USDC(1) })],
      });
      const sig = await signOperationHash(sessionKey, op.userOpHash);
      await expect(
        gateway.submitOperation({
          op,
          signature: encodeSessionSignature({ permissionId, sessionSignature: sig, cosignerSignature: sig }),
        }),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      await expect(submitAsSession(gateway, op, { cosigner: stranger })).rejects.toMatchObject({
        code: "signature_invalid",
      });
    }, 120_000);

    it("an over-limit transfer fails", async () => {
      const op = await gateway
        .prepareOperation({
          account,
          session: { permissionId },
          calls: [transferCall({ token: gateway.contracts.usdc, to: payee, amount: USDC(26) })],
        })
        .catch((error: unknown) => error);
      // The bundler rejects it during gas estimation (policy revert) or at submission.
      if (op instanceof Error) {
        expect(op).toMatchObject({ code: "policy_denied" });
        return;
      }
      await expect(
        submitAsSession(gateway, op as Awaited<ReturnType<EvmChainGateway["prepareOperation"]>>),
      ).rejects.toMatchObject({
        code: "policy_denied",
      });
    }, 120_000);

    it("an operation prepared before the session expired is rejected at submission (AA22)", async () => {
      const issuedAt = Number((await forkClient.getBlock()).timestamp);
      const grant: SessionGrant = {
        sessionKey: sessionKey.address,
        cosigner: cosigner.address,
        salt: sessionSalt(`short-${issuedAt}`),
        scope: {
          token: gateway.contracts.usdc,
          maxPerTx: USDC(25),
          maxPerDay: USDC(100),
          allowedRecipients: [],
          allowedContracts: [],
          issuedAt,
          expiresAt: issuedAt + 600,
        },
      };
      const shortId = sessionPermissionId(grant, gateway.contracts);
      const install = await gateway.prepareOwnerOperation({
        account,
        calls: sessionInstallCalls({ contracts: gateway.contracts, grant }),
      });
      expect(
        (await waitForOperation(gateway, (await submitAsOwner(gateway, install)).userOpHash)).status,
      ).toBe("succeeded");
      const op = await gateway.prepareOperation({
        account,
        session: { permissionId: shortId },
        calls: [transferCall({ token: gateway.contracts.usdc, to: payee, amount: 1n })],
      });
      await increaseTime(1200);
      await expect(submitAsSession(gateway, op)).rejects.toMatchObject({ code: "session_expired" });
    }, 120_000);

    it("the owner alone can withdraw everything", async () => {
      const balance = await gateway.getTokenBalance(gateway.contracts.usdc, account);
      const ownerBefore = await gateway.getTokenBalance(gateway.contracts.usdc, owner.address);
      const op = await gateway.prepareOwnerOperation({
        account,
        calls: [transferCall({ token: gateway.contracts.usdc, to: owner.address, amount: balance })],
      });
      const { userOpHash } = await submitAsOwner(gateway, op);
      const receipt = await waitForOperation(gateway, userOpHash);
      expect(receipt.status).toBe("succeeded");
      expect(await gateway.getTokenBalance(gateway.contracts.usdc, account)).toBe(0n);
      expect(await gateway.getTokenBalance(gateway.contracts.usdc, owner.address)).toBe(
        ownerBefore + balance,
      );
    }, 120_000);
  },
);
