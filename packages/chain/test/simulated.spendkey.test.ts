import { describe, expect, it } from "vitest";
import { hashStruct, hashTypedData, keccak256, maxUint256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  accountSetupCalls,
  floatSweepCall,
  PERMIT_TYPES,
  permitCall,
  policyHookConfig,
  sessionPermissionId,
  sessionSalt,
  spendKeyPermitTypedData,
  streamCancelCall,
  streamCreateCalls,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferCall,
  type SessionGrant,
} from "../src";
import { SimulatedChain } from "../src/simulated";
import { ownerErc1271Signature, sessionErc1271Attempts } from "./erc1271";
import {
  cosigner,
  owner,
  payee,
  revenue,
  scope,
  sessionKey,
  setupAgent,
  stranger,
  submitAsOwner,
  submitAsSession,
  USDC,
} from "./helpers";

const TWA_TYPE =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
const PERMIT_TYPE = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";

/** Deploy an agent with `accountSetupCalls` (registry off, hook, session, spend-key permit) in one owner operation. */
async function provision(chain: SimulatedChain) {
  const gw = chain.gateway;
  const c = chain.contracts;
  const spendKey = privateKeyToAccount(generatePrivateKey());
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 5n };
  const account = await gw.predictAccountAddress(deployment);
  chain.faucet(account, USDC(500));
  const grant: SessionGrant = {
    sessionKey: sessionKey.address,
    cosigner: cosigner.address,
    salt: sessionSalt("ses_float"),
    scope: scope(chain, { allowedRecipients: [payee, revenue, spendKey.address] }),
  };
  const hookConfig = policyHookConfig(grant.scope, c);
  const signature = await spendKey.signTypedData(
    spendKeyPermitTypedData({
      chainId: chain.chainId,
      token: c.usdc,
      owner: spendKey.address,
      spender: account,
      value: maxUint256,
      nonce: chain.usdc.nonces(spendKey.address),
      deadline: maxUint256,
    }),
  );
  const op = await gw.prepareOwnerOperation({
    account,
    deployment,
    calls: accountSetupCalls({
      account,
      contracts: c,
      grant,
      hookConfig,
      spendKeyPermit: { owner: spendKey.address, value: maxUint256, deadline: maxUint256, signature },
    }),
  });
  const receipt = await gw.getOperationReceipt((await submitAsOwner(gw, op)).userOpHash);
  expect(receipt.status).toBe("succeeded");
  return { account, spendKey, permissionId: sessionPermissionId(grant, c) };
}

describe("x402 spend key lifecycle (ADR 0001) on the simulator", () => {
  it("provision with permit, refill under the session and hook, pay x402, sweep the float back as an inflow", async () => {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const gw = chain.gateway;
    const { account, spendKey, permissionId } = await provision(chain);
    expect(chain.usdc.allowance(spendKey.address, account)).toBe(maxUint256);
    expect(chain.account(account)?.globalHook).toBe(c.policyHook);

    // Refill: an ordinary session payment to the spend key (session + co-signer + hook).
    const refill = await gw.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: c.usdc, to: spendKey.address, amount: USDC(20) })],
    });
    await submitAsSession(gw, refill);
    expect(chain.balanceOf(spendKey.address)).toBe(USDC(20));
    const spentAfterRefill = chain.hook.spentToday(account, c.usdc, chain.nextTimestamp());
    expect(spentAfterRefill).toBe(USDC(20));

    // The spend key pays an x402 seller with a plain EIP-3009 authorization.
    const now = BigInt(chain.nowSeconds());
    const message = {
      from: spendKey.address,
      to: payee,
      value: USDC(3),
      validAfter: now - 1n,
      validBefore: now + 300n,
      nonce: keccak256(toHex("x402")),
    };
    const signature = await spendKey.signTypedData({
      domain: { name: "USDC", version: "2", chainId: chain.chainId, verifyingContract: c.usdc },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    await gw.settleAuthorization({ token: c.usdc, ...message, signature });
    expect(chain.balanceOf(spendKey.address)).toBe(USDC(17));

    // The owner sweeps the float back: transferFrom into the account is an inflow for the hook.
    const sweep = await gw.prepareOwnerOperation({
      account,
      calls: [floatSweepCall(c.usdc, spendKey.address, account, USDC(17))],
    });
    expect(sweep.calls[0]?.kind).toBe("erc20_transfer_from");
    const r = await gw.getOperationReceipt((await submitAsOwner(gw, sweep)).userOpHash);
    expect(r.status).toBe("succeeded");
    expect(r.logs.map((l) => l.eventName)).toEqual(["Transfer"]);
    expect(chain.balanceOf(spendKey.address)).toBe(0n);
    expect(chain.balanceOf(account)).toBe(USDC(500) - USDC(3));
    expect(chain.hook.spentToday(account, c.usdc, chain.nextTimestamp())).toBe(spentAfterRefill);
    // Sessions cannot sweep (no transferFrom action), and cannot submit permits.
    await expect(
      gw.prepareOperation({
        account,
        session: { permissionId },
        calls: [floatSweepCall(c.usdc, spendKey.address, account, 1n)],
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("the hook refuses permit calls on the hooked path (hence the setup operation)", async () => {
    const chain = new SimulatedChain();
    const { account, spendKey } = await provision(chain);
    const signature = await spendKey.signTypedData(
      spendKeyPermitTypedData({
        chainId: chain.chainId,
        token: chain.contracts.usdc,
        owner: spendKey.address,
        spender: account,
        value: 1n,
        nonce: chain.usdc.nonces(spendKey.address),
        deadline: maxUint256,
      }),
    );
    const call = permitCall(chain.contracts.usdc, {
      owner: spendKey.address,
      spender: account,
      value: 1n,
      deadline: maxUint256,
      signature,
    });
    await expect(chain.gateway.prepareOwnerOperation({ account, calls: [call] })).rejects.toMatchObject({
      code: "invalid_state",
      extensions: { revertReason: expect.stringMatching(/UnsupportedTokenCall/) },
    });
  });
});

describe("ADR 0001 acceptance on the simulator: sessions cannot sign ERC-1271 for the account", () => {
  it("USDC rejects session and co-signer ERC-1271 signatures for transferWithAuthorization and permit; the owner's works", async () => {
    const chain = new SimulatedChain();
    const c = chain.contracts;
    const gw = chain.gateway;
    const { account, permissionId } = await provision(chain);
    const domain = { name: "USDC", version: "2", chainId: chain.chainId, verifyingContract: c.usdc } as const;
    const appDomainSeparator = keccak256("0x00") as Hex; // only used inside the ERC-7739 wrapper; any value
    const now = BigInt(chain.nowSeconds());

    // EIP-3009 from the agent account.
    const twa = {
      from: account,
      to: stranger.address,
      value: USDC(400),
      validAfter: now - 1n,
      validBefore: now + 600n,
      nonce: keccak256(toHex("drain")),
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
    for (const attempt of await sessionErc1271Attempts({
      chainId: chain.chainId,
      account,
      contracts: c,
      permissionId,
      digest: twaDigest,
      appDomainSeparator,
      contents: twaContents,
      contentsType: TWA_TYPE,
    })) {
      await expect(
        gw.settleAuthorization({ token: c.usdc, ...twa, signature: attempt.signature }),
        attempt.label,
      ).rejects.toMatchObject({
        extensions: { revertReason: "FiatTokenV2: invalid signature" },
      });
    }
    expect(chain.balanceOf(stranger.address)).toBe(0n);

    // EIP-2612 permit on behalf of the agent account.
    const permit = {
      owner: account,
      spender: stranger.address,
      value: maxUint256,
      nonce: chain.usdc.nonces(account),
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
      chainId: chain.chainId,
      account,
      contracts: c,
      permissionId,
      digest: permitDigest,
      appDomainSeparator,
      contents: permitContents,
      contentsType: PERMIT_TYPE,
    })) {
      const tx = chain.sendTransaction({
        from: stranger.address,
        to: c.usdc,
        data: permitCall(c.usdc, { ...permit, signature: attempt.signature }).data,
      });
      expect(chain.transaction(tx), attempt.label).toMatchObject({
        success: false,
        revertReason: "EIP2612: invalid signature",
      });
    }
    expect(chain.usdc.allowance(account, stranger.address)).toBe(0n);

    // Positive control: the owner's Safe signature is accepted on the same paths.
    const ownerSig = await ownerErc1271Signature(chain.chainId, account, twaDigest);
    // Bound to the signed values: a different amount is refused even with the owner's signature.
    await expect(
      gw.settleAuthorization({ token: c.usdc, ...twa, value: USDC(1), signature: ownerSig }),
    ).rejects.toMatchObject({
      extensions: { revertReason: "FiatTokenV2: invalid signature" },
    });
    await gw.settleAuthorization({ token: c.usdc, ...twa, signature: ownerSig });
    expect(chain.balanceOf(stranger.address)).toBe(USDC(400));
    const ownerPermit = await ownerErc1271Signature(chain.chainId, account, permitDigest);
    const tx = chain.sendTransaction({
      from: stranger.address,
      to: c.usdc,
      data: permitCall(c.usdc, { ...permit, signature: ownerPermit }).data,
    });
    expect(chain.transaction(tx)?.success).toBe(true);
    expect(chain.usdc.allowance(account, stranger.address)).toBe(maxUint256);
  });
});

describe("PaymentStreams cancel is payer-only", () => {
  it("refuses a cancel by the payee", async () => {
    const chain = new SimulatedChain();
    const streams = chain.contracts.streams as Address;
    const { account, permissionId } = await setupAgent(chain, { scope: { allowedContracts: [streams] } });
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: streamCreateCalls({
        streams,
        token: chain.contracts.usdc,
        payee,
        deposit: USDC(5),
        amountPerInterval: USDC(1),
        interval: 60n,
      }),
    });
    await submitAsSession(chain.gateway, op);
    const tx = chain.sendTransaction({
      from: payee,
      to: streams,
      data: streamCancelCall({ streams, streamId: 1n }).data,
    });
    expect(chain.transaction(tx)).toMatchObject({ success: false, revertReason: `Unauthorized(${payee})` });
  });
});
