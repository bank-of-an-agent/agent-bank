import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  getAddress,
  maxUint256,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  accountSetupCalls,
  buildSmartSession,
  decodeCall,
  describeSession,
  erc20Abi,
  floatSweepCall,
  permitCall,
  policyHookConfig,
  sessionSalt,
  SIMULATED_CONTRACTS as C,
  spendKeyPermitTypedData,
  type OnchainSessionScope,
  type SessionGrant,
} from "../src";
import { cosigner, payee, revenue, sessionKey, USDC } from "./helpers";

const account = getAddress("0x2000000000000000000000000000000000000002");
const spendKey = privateKeyToAccount(generatePrivateKey());

function grant(scope: Partial<OnchainSessionScope> = {}): SessionGrant {
  return {
    sessionKey: sessionKey.address,
    cosigner: cosigner.address,
    salt: sessionSalt("ses_spend"),
    scope: {
      token: C.usdc,
      maxPerTx: USDC(25),
      maxPerDay: USDC(100),
      allowedRecipients: [payee, revenue],
      allowedContracts: [],
      issuedAt: 1_791_720_000,
      expiresAt: 1_791_806_400,
      ...scope,
    },
  };
}

describe("ADR 0001 acceptance (unit): agent sessions have no ERC-1271 signing rights", () => {
  it("configures no ERC-1271 policies and no ERC-7739 contents, whatever the scope", () => {
    for (const scope of [
      {},
      { allowedRecipients: [] },
      { allowedRecipients: [payee] },
      { allowedContracts: [C.escrow as Address, C.streams as Address, C.vaults as Address] },
    ]) {
      const session = buildSmartSession(grant(scope), C);
      expect(session.erc7739Policies.erc1271Policies).toEqual([]);
      expect(session.erc7739Policies.allowedERC7739Content).toEqual([]);
      expect(describeSession(session, C).erc1271).toBe(false);
      // Nothing in the session targets USDC's permit or EIP-3009 functions either.
      const usdcSelectors = session.actions
        .filter((a) => a.actionTarget === C.usdc)
        .map((a) => a.actionTargetSelector);
      expect(usdcSelectors.every((s) => s === "0xa9059cbb" || s === "0x095ea7b3")).toBe(true);
    }
  });
});

describe("spend key helpers", () => {
  it("builds the USDC EIP-2612 typed data the spend key signs", async () => {
    const typed = spendKeyPermitTypedData({
      chainId: 84532,
      token: C.usdc,
      owner: spendKey.address,
      spender: account,
      value: maxUint256,
      nonce: 0n,
      deadline: maxUint256,
    });
    expect(typed.domain).toEqual({ name: "USDC", version: "2", chainId: 84532, verifyingContract: C.usdc });
    expect(typed.primaryType).toBe("Permit");
    const signature = await spendKey.signTypedData(typed);
    expect(await verifyTypedData({ ...typed, address: spendKey.address, signature })).toBe(true);
  });

  it("encodes permit with the (v, r, s) overload for ECDSA and the bytes overload otherwise", async () => {
    const typed = spendKeyPermitTypedData({
      chainId: 1337,
      token: C.usdc,
      owner: spendKey.address,
      spender: account,
      value: 5n,
      nonce: 0n,
      deadline: 9n,
    });
    const signature = await spendKey.signTypedData(typed);
    const vrs = decodeFunctionData({
      abi: erc20Abi,
      data: permitCall(C.usdc, {
        owner: spendKey.address,
        spender: account,
        value: 5n,
        deadline: 9n,
        signature,
      }).data,
    });
    expect(vrs.functionName).toBe("permit");
    expect(vrs.args).toEqual([
      spendKey.address,
      account,
      5n,
      9n,
      Number.parseInt(signature.slice(130), 16),
      signature.slice(0, 66),
      `0x${signature.slice(66, 130)}`,
    ]);
    // v as 0/1 is normalised.
    const v0 =
      `${signature.slice(0, 130)}${(Number.parseInt(signature.slice(130), 16) - 27).toString(16).padStart(2, "0")}` as Hex;
    expect(
      permitCall(C.usdc, {
        owner: spendKey.address,
        spender: account,
        value: 5n,
        deadline: 9n,
        signature: v0,
      }).data,
    ).toBe(
      permitCall(C.usdc, { owner: spendKey.address, spender: account, value: 5n, deadline: 9n, signature })
        .data,
    );
    const long = `${signature}${"00".repeat(20)}` as Hex;
    const bytes = decodeFunctionData({
      abi: erc20Abi,
      data: permitCall(C.usdc, { owner: account, spender: payee, value: 1n, deadline: 2n, signature: long })
        .data,
    });
    expect(bytes.args).toEqual([account, payee, 1n, 2n, long]);
    const decoded = decodeCall(
      permitCall(C.usdc, { owner: spendKey.address, spender: account, value: 5n, deadline: 9n, signature }),
      { contracts: C, account },
    );
    expect(decoded).toMatchObject({
      kind: "erc20_permit",
      token: C.usdc,
      spender: account,
      amount: "5",
      args: { owner: spendKey.address, deadline: "9" },
    });
  });

  it("sweeps the float with transferFrom(spendKey → account)", () => {
    const call = floatSweepCall(C.usdc, spendKey.address, account, USDC(7));
    expect(decodeCall(call, { contracts: C, account })).toMatchObject({
      kind: "erc20_transfer_from",
      token: C.usdc,
      recipient: account,
      amount: USDC(7).toString(),
      args: { from: spendKey.address },
    });
  });
});

describe("accountSetupCalls", () => {
  it("composes registry, hook, session and permit in order", async () => {
    const g = grant();
    const hookConfig = policyHookConfig(g.scope, C, { extraRecipients: [spendKey.address] });
    const signature = await spendKey.signTypedData(
      spendKeyPermitTypedData({
        chainId: 1337,
        token: C.usdc,
        owner: spendKey.address,
        spender: account,
        value: maxUint256,
        nonce: 0n,
        deadline: maxUint256,
      }),
    );
    const calls = accountSetupCalls({
      account,
      contracts: C,
      grant: g,
      hookConfig,
      spendKeyPermit: { owner: spendKey.address, value: maxUint256, deadline: maxUint256, signature },
    });
    const decoded = calls.map((c) => decodeCall(c, { contracts: C, account }));
    expect(decoded.map((d) => d.kind)).toEqual([
      "module_config",
      "module_config",
      "session_install",
      "erc20_permit",
    ]);
    expect(decoded.map((d) => d.args?.function ?? null).slice(0, 2)).toEqual([
      "setRegistry",
      "installModule",
    ]);
    expect(decoded[3]).toMatchObject({ spender: account, args: { owner: spendKey.address } });
    expect(accountSetupCalls({ account, contracts: C, grant: g, hookConfig })).toHaveLength(3);
  });

  it("refuses a spend key the hook would not let the account refill", async () => {
    const g = grant();
    const signature = toHex(new Uint8Array(65));
    expect(() =>
      accountSetupCalls({
        account,
        contracts: C,
        grant: g,
        hookConfig: policyHookConfig(g.scope, C),
        spendKeyPermit: { owner: spendKey.address, value: 1n, deadline: 1n, signature },
      }),
    ).toThrow(/spend key must be an allowed recipient/);
  });
});
