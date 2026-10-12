import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { encodeSessionSignature, sessionRevokeCall, signOperationHash, transferCall } from "../src";
import { SimulatedChain } from "../src/simulated";
import {
  cosigner,
  DEV_KEYS,
  otherPayee,
  owner,
  payee,
  revenue,
  sessionKey,
  setupAgent,
  stranger,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "./helpers";

describe("SimulatedChain: accounts and the validation rule", () => {
  it("deploys an account and installs a session in one owner operation", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    expect(await chain.gateway.isDeployed(account)).toBe(true);
    expect(await chain.gateway.isSessionEnabled(account, permissionId)).toBe(true);
    const record = chain.account(account);
    expect(record?.stage).toBe("ready");
    expect(record?.sessions).toHaveLength(1);
    expect(await chain.gateway.getTokenBalance(chain.contracts.usdc, account)).toBe(USDC(1000));
  });

  it("session key + co-signer can pay within scope", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const gw = chain.gateway;
    const op = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [
        transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(20) }),
        transferCall({ token: chain.contracts.usdc, to: revenue, amount: 40_000n }),
      ],
    });
    expect(op.signer).toBe("session");
    expect(op.calls.map((c) => c.kind)).toEqual(["erc20_transfer", "erc20_transfer"]);
    expect(gw.hashOperation(op)).toBe(op.userOpHash);
    const { userOpHash } = await submitAsSession(gw, op);
    const receipt = await gw.getOperationReceipt(userOpHash);
    expect(receipt.status).toBe("succeeded");
    // Like bundler receipts: execution-phase logs only (no AccountDeployed, no UserOperationEvent).
    expect(receipt.logs.map((l) => l.eventName)).toEqual(["Transfer", "Transfer"]);
    expect(chain.balanceOf(payee)).toBe(USDC(20));
    expect(chain.balanceOf(account)).toBe(USDC(1000) - USDC(20) - 40_000n);
  });

  it("the co-signer alone cannot move funds", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    const sig = await signOperationHash(cosigner, op.userOpHash);
    await expect(
      chain.gateway.submitOperation({
        op,
        signature: encodeSessionSignature({ permissionId, sessionSignature: sig, cosignerSignature: sig }),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
    expect(chain.balanceOf(payee)).toBe(0n);
  });

  it("the session key alone cannot move funds", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    const sig = await signOperationHash(sessionKey, op.userOpHash);
    await expect(
      chain.gateway.submitOperation({
        op,
        signature: encodeSessionSignature({ permissionId, sessionSignature: sig, cosignerSignature: sig }),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
    // A third key does not help either.
    await expect(submitAsSession(chain.gateway, op, { cosigner: stranger })).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });

  it("the owner signature alone cannot use the session path, and session keys cannot use the owner path", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const sessionOp = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    await expect(
      submitAsSession(chain.gateway, sessionOp, { session: owner, cosigner: owner }),
    ).rejects.toMatchObject({
      code: "signature_invalid",
    });
    const ownerOp = await chain.gateway.prepareOwnerOperation({
      account,
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    await expect(submitAsOwner(chain.gateway, ownerOp, sessionKey)).rejects.toMatchObject({
      code: "signature_invalid",
    });
    await expect(submitAsOwner(chain.gateway, ownerOp, cosigner)).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });

  it("over-limit transfers are rejected at validation (already when the bundler estimates gas)", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    await expect(
      chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(26) })],
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    expect(chain.balanceOf(payee)).toBe(0n);
  });

  it("calls outside the session's actions are rejected (other tokens, approvals, self-calls)", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const gw = chain.gateway;
    const fakeToken = "0x0000000000000000000000000000000000c0ffee";
    for (const call of [
      transferCall({ token: fakeToken, to: payee, amount: 1n }),
      { to: chain.contracts.usdc, data: "0x095ea7b3" + "0".repeat(128) } as { to: Hex; data: Hex },
      sessionRevokeCall({ contracts: gw.contracts, permissionId }),
    ]) {
      await expect(
        gw.prepareOperation({ account, session: { permissionId }, calls: [call] }),
      ).rejects.toMatchObject({
        code: "policy_denied",
      });
    }
  });

  it("the lifetime cap of the session's spending-limit policy holds", async () => {
    const chain = new SimulatedChain();
    // A one-day session: the lifetime cap equals maxPerDay (100) unless the session spans midnight.
    const now = chain.nowSeconds();
    const dayEnd = (Math.floor(now / 86_400) + 1) * 86_400;
    const { account, permissionId } = await setupAgent(chain, {
      scope: { issuedAt: now, expiresAt: dayEnd },
    });
    const pay = async (amount: bigint) => {
      const op = await chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount })],
      });
      return submitAsSession(chain.gateway, op);
    };
    // The cap is checked again at inclusion: an operation prepared before the cap was reached fails then.
    for (let i = 0; i < 4; i++) await pay(USDC(25));
    await expect(pay(1n)).rejects.toMatchObject({ code: "policy_denied" });
    expect(chain.balanceOf(payee)).toBe(USDC(100));
  });

  it("pins the recipient when the scope allows exactly one", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain, { scope: { allowedRecipients: [payee] } });
    const gw = chain.gateway;
    const ok = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    await submitAsSession(gw, ok);
    await expect(
      gw.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: chain.contracts.usdc, to: otherPayee, amount: USDC(1) })],
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("expired sessions are rejected by the EntryPoint time range", async () => {
    const chain = new SimulatedChain();
    const now = chain.nowSeconds();
    const { account, permissionId } = await setupAgent(chain, { scope: { expiresAt: now + 3600 } });
    chain.advanceTime(3600 + 10);
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    await expect(submitAsSession(chain.gateway, op)).rejects.toMatchObject({ code: "session_expired" });
  });

  it("revoked sessions are rejected, and revocation is owner-only", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const gw = chain.gateway;
    const revoke = await gw.prepareOwnerOperation({
      account,
      calls: [sessionRevokeCall({ contracts: gw.contracts, permissionId })],
    });
    expect(revoke.calls[0]?.kind).toBe("session_revoke");
    const { userOpHash } = await submitAsOwner(gw, revoke);
    const receipt = await gw.getOperationReceipt(userOpHash);
    expect(receipt.logs.some((l) => l.eventName === "SessionRemoved")).toBe(true);
    expect(await gw.isSessionEnabled(account, permissionId)).toBe(false);
    await expect(
      gw.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: 1n })],
      }),
    ).rejects.toMatchObject({ code: "session_revoked" });
  });

  it("the owner alone can withdraw everything", async () => {
    const chain = new SimulatedChain();
    const { account } = await setupAgent(chain);
    const op = await chain.gateway.prepareOwnerOperation({
      account,
      calls: [transferCall({ token: chain.contracts.usdc, to: owner.address, amount: USDC(1000) })],
    });
    expect(op.signer).toBe("owner");
    const { userOpHash } = await submitAsOwner(chain.gateway, op);
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("succeeded");
    expect(chain.balanceOf(owner.address)).toBe(USDC(1000));
    expect(chain.balanceOf(account)).toBe(0n);
  });

  it("rejects replays, reused nonces and passed deadlines", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const gw = chain.gateway;
    const call = transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) });
    const a = await gw.prepareOperation({ account, session: { permissionId }, calls: [call] });
    const b = await gw.prepareOperation({ account, session: { permissionId }, calls: [call, call] });
    expect(a.userOp.nonce).toBe(b.userOp.nonce);
    const first = await submitAsSession(gw, a);
    // Resubmitting the same operation is idempotent; a different operation with the same nonce fails.
    expect((await submitAsSession(gw, a)).userOpHash).toBe(first.userOpHash);
    await expect(submitAsSession(gw, b)).rejects.toMatchObject({ code: "invalid_state" });
    const late = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [call],
      validUntil: chain.nowSeconds() + 5,
    });
    chain.advanceTime(60);
    await expect(submitAsSession(gw, late)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refuses to submit an operation whose calldata was tampered with after signing", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const gw = chain.gateway;
    const op = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(1) })],
    });
    const sessionSignature = await signOperationHash(sessionKey, op.userOpHash);
    const cosignerSignature = await signOperationHash(cosigner, op.userOpHash);
    const evil = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: stranger.address, amount: USDC(25) })],
    });
    // Keep the original (signed) hash but swap in the attacker's calldata: the hash is recomputed.
    const tampered = { ...op, userOp: { ...op.userOp, callData: evil.userOp.callData } };
    expect(gw.hashOperation(tampered)).not.toBe(op.userOpHash);
    expect(gw.decodeOperation(tampered)[0]?.recipient).toBe(stranger.address);
    await expect(
      gw.submitOperation({
        op: tampered,
        signature: encodeSessionSignature({ permissionId, sessionSignature, cosignerSignature }),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("prepared operations are JSON-safe", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(2) })],
    });
    const roundTripped = JSON.parse(JSON.stringify(op));
    expect(roundTripped).toEqual(op);
    const { userOpHash } = await submitAsSession(chain.gateway, roundTripped);
    expect(userOpHash).toBe(op.userOpHash);
  });

  it("supports several accounts per owner (salt) and binds the address to the co-signer", async () => {
    const chain = new SimulatedChain();
    const gw = chain.gateway;
    const a = await gw.predictAccountAddress({ owner: owner.address, cosigner: cosigner.address, salt: 1n });
    const b = await gw.predictAccountAddress({ owner: owner.address, cosigner: cosigner.address, salt: 2n });
    const c = await gw.predictAccountAddress({
      owner: owner.address,
      cosigner: privateKeyToAccount(DEV_KEYS[7] as Hex).address,
      salt: 1n,
    });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(await gw.isDeployed(a)).toBe(false);
  });
});
