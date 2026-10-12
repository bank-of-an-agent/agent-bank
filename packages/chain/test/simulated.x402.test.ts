import { describe, expect, it } from "vitest";
import {
  concatHex,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  maxUint256,
  serializeErc6492Signature,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountFactoryArgs,
  erc20Abi,
  PERMIT_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferFromCall,
} from "../src";
import { SimulatedChain } from "../src/simulated";
import { cosigner, DEV_KEYS, owner, payee, setupAgent, stranger, submitAsOwner, USDC } from "./helpers";

const spendKey = privateKeyToAccount(DEV_KEYS[7] as Hex);

function domain(chain: SimulatedChain) {
  return { name: "USDC", version: "2", chainId: chain.chainId, verifyingContract: chain.contracts.usdc };
}

async function authorize(
  chain: SimulatedChain,
  overrides: Partial<{
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  }> = {},
  signer = spendKey,
) {
  const now = BigInt(chain.nowSeconds());
  const message = {
    from: spendKey.address,
    to: payee,
    value: USDC(1),
    validAfter: now - 10n,
    validBefore: now + 300n,
    nonce: keccak256(toHex(`pay_${Math.random()}`)),
    ...overrides,
  };
  const signature = await signer.signTypedData({
    domain: domain(chain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  return { message, signature };
}

describe("EIP-3009 settlement (x402 facilitator)", () => {
  it("settles a spend-key authorization once, and reports authorizationState", async () => {
    const chain = new SimulatedChain();
    chain.faucet(spendKey.address, USDC(25));
    const { message, signature } = await authorize(chain);
    const gw = chain.gateway;
    expect(await gw.authorizationState(chain.contracts.usdc, spendKey.address, message.nonce)).toBe(false);
    const { txHash } = await gw.settleAuthorization({ token: chain.contracts.usdc, ...message, signature });
    const tx = chain.transaction(txHash);
    expect(tx?.success).toBe(true);
    expect(tx?.logs.map((l) => l.eventName)).toEqual(["AuthorizationUsed", "Transfer"]);
    expect(tx?.logs[0]?.args).toEqual({ authorizer: spendKey.address, nonce: message.nonce });
    expect(chain.balanceOf(payee)).toBe(USDC(1));
    expect(await gw.authorizationState(chain.contracts.usdc, spendKey.address, message.nonce)).toBe(true);
    await expect(
      gw.settleAuthorization({ token: chain.contracts.usdc, ...message, signature }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      extensions: { revertReason: "FiatTokenV2: authorization is used or canceled" },
    });
  });

  it("rejects expired, not-yet-valid, tampered and wrongly signed authorizations", async () => {
    const chain = new SimulatedChain();
    chain.faucet(spendKey.address, USDC(25));
    const gw = chain.gateway;
    const usdc = chain.contracts.usdc;
    const now = BigInt(chain.nowSeconds());
    const expired = await authorize(chain, { validBefore: now - 1n });
    await expect(
      gw.settleAuthorization({ token: usdc, ...expired.message, signature: expired.signature }),
    ).rejects.toMatchObject({
      extensions: { revertReason: "FiatTokenV2: authorization is expired" },
    });
    const early = await authorize(chain, { validAfter: now + 100n });
    await expect(
      gw.settleAuthorization({ token: usdc, ...early.message, signature: early.signature }),
    ).rejects.toMatchObject({
      extensions: { revertReason: "FiatTokenV2: authorization is not yet valid" },
    });
    const ok = await authorize(chain);
    await expect(
      gw.settleAuthorization({ token: usdc, ...ok.message, value: USDC(2), signature: ok.signature }),
    ).rejects.toMatchObject({ extensions: { revertReason: "FiatTokenV2: invalid signature" } });
    const forged = await authorize(chain, {}, stranger);
    await expect(
      gw.settleAuthorization({ token: usdc, ...forged.message, signature: forged.signature }),
    ).rejects.toMatchObject({
      extensions: { revertReason: "FiatTokenV2: invalid signature" },
    });
    const tooMuch = await authorize(chain, { value: USDC(26) });
    await expect(
      gw.settleAuthorization({ token: usdc, ...tooMuch.message, signature: tooMuch.signature }),
    ).rejects.toMatchObject({
      extensions: { revertReason: "ERC20: transfer amount exceeds balance" },
    });
  });

  it("a deployed account can pay through ERC-1271 (owner's Safe signature, bytes overload); an undeployed one cannot", async () => {
    const chain = new SimulatedChain();
    const { account } = await setupAgent(chain);
    const gw = chain.gateway;
    const now = BigInt(chain.nowSeconds());
    const message = {
      from: account,
      to: payee,
      value: USDC(3),
      validAfter: now - 10n,
      validBefore: now + 300n,
      nonce: keccak256(toHex("x402-1271")),
    };
    const digest = hashTypedData({
      domain: domain(chain),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    const safeHash = hashTypedData({
      domain: { chainId: chain.chainId, verifyingContract: account },
      types: { SafeMessage: [{ name: "message", type: "bytes" }] },
      primaryType: "SafeMessage",
      message: { message: digest },
    });
    const ownerSig = await owner.sign({ hash: safeHash });
    const signature = concatHex([zeroAddress, ownerSig]);
    expect(await gw.verifySignature({ address: account, hash: digest, signature })).toBe(true);
    await gw.settleAuthorization({ token: chain.contracts.usdc, ...message, signature });
    expect(chain.balanceOf(payee)).toBe(USDC(3));
  });
});

describe("verifySignature", () => {
  it("EOA, deployed account (Safe and OwnableValidator routes) and counterfactual account (ERC-6492)", async () => {
    const chain = new SimulatedChain();
    const gw = chain.gateway;
    const hash = keccak256(toHex("hello"));
    expect(
      await gw.verifySignature({ address: spendKey.address, hash, signature: await spendKey.sign({ hash }) }),
    ).toBe(true);
    expect(
      await gw.verifySignature({ address: spendKey.address, hash, signature: await stranger.sign({ hash }) }),
    ).toBe(false);

    const { account } = await setupAgent(chain);
    // OwnableValidator route: `validator ‖ signature` over the raw hash.
    const viaValidator = concatHex([chain.contracts.ownableValidator, await owner.sign({ hash })]);
    expect(await gw.verifySignature({ address: account, hash, signature: viaValidator })).toBe(true);
    const wrong = concatHex([chain.contracts.ownableValidator, await cosigner.sign({ hash })]);
    expect(await gw.verifySignature({ address: account, hash, signature: wrong })).toBe(false);

    // Counterfactual account: ERC-6492 wrapper around the Safe-route signature.
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 42n };
    const counterfactual = await gw.predictAccountAddress(deployment);
    const safeHash = hashTypedData({
      domain: { chainId: chain.chainId, verifyingContract: counterfactual },
      types: { SafeMessage: [{ name: "message", type: "bytes" }] },
      primaryType: "SafeMessage",
      message: { message: hash },
    });
    const inner = concatHex([zeroAddress, await owner.sign({ hash: safeHash })]);
    const { factory, factoryData } = accountFactoryArgs(deployment, chain.contracts);
    const wrapped = serializeErc6492Signature({ address: factory, data: factoryData, signature: inner });
    expect(await gw.verifySignature({ address: counterfactual, hash, signature: wrapped })).toBe(true);
    expect(await gw.verifySignature({ address: counterfactual, hash, signature: inner })).toBe(false);
  });
});

describe("EIP-2612 permit and float recovery", () => {
  it("the spend key permits its account; an owner operation sweeps the float back", async () => {
    const chain = new SimulatedChain();
    const { account } = await setupAgent(chain);
    chain.faucet(spendKey.address, USDC(7));
    const usdc = chain.contracts.usdc;
    const signature = await spendKey.signTypedData({
      domain: domain(chain),
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: spendKey.address,
        spender: account,
        value: maxUint256,
        nonce: 0n,
        deadline: maxUint256,
      },
    });
    const { r, s, v } = {
      r: `0x${signature.slice(2, 66)}` as Hex,
      s: `0x${signature.slice(66, 130)}` as Hex,
      v: Number.parseInt(signature.slice(130), 16),
    };
    chain.sendTransaction({
      from: stranger.address,
      to: usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "permit",
        args: [spendKey.address, account, maxUint256, maxUint256, v, r, s],
      }),
    });
    expect(chain.usdc.allowance(spendKey.address, account)).toBe(maxUint256);
    const op = await chain.gateway.prepareOwnerOperation({
      account,
      calls: [transferFromCall({ token: usdc, from: spendKey.address, to: account, amount: USDC(7) })],
    });
    expect(op.calls[0]).toMatchObject({
      kind: "erc20_transfer_from",
      recipient: account,
      args: { from: spendKey.address },
    });
    await submitAsOwner(chain.gateway, op);
    expect(chain.balanceOf(spendKey.address)).toBe(0n);
    expect(chain.balanceOf(account)).toBe(USDC(1007));
  });
});
