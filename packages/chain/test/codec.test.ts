import { describe, expect, it } from "vitest";
import {
  concatHex,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashMessage,
  keccak256,
  pad,
  recoverAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { toSafeSmartAccount } from "permissionless/accounts";
import { OPERATION_HASH_SIGNING } from "@agentbank/core";
import {
  accountFactoryArgs,
  accountSaltNonce,
  CALL_KINDS,
  CHAIN_EVENT_NAMES,
  CHAIN_EVENTS,
  decodeCall,
  decodeCalls,
  decodeExecute,
  decodeNonce,
  decodeSessionSignature,
  disableModuleRegistryCall,
  encodeExecute,
  encodeOwnableValidatorConfig,
  encodeOwnerSignature,
  encodeSessionSignature,
  escrowLockCalls,
  escrowRefundCall,
  escrowReleaseByValidationCall,
  EVENT_PARTIES,
  eventArgToString,
  MODE_BATCH_DEFAULT,
  normalizeLog,
  parseUint,
  partyTopicPositions,
  policyHookConfig,
  policyHookInstallCalls,
  predictAccountAddress,
  RHINESTONE_ATTESTER,
  safe7579Abi,
  SAFE_PROXY_CREATION_CODE,
  sessionInstallCalls,
  sessionRevokeCall,
  sessionSalt,
  signOperationHash,
  recoverOperationSigner,
  SIMULATED_CONTRACTS as C,
  streamCancelCall,
  streamCreateCalls,
  streamSettleCall,
  streamTopUpCalls,
  stubOwnerSignature,
  stubSessionSignature,
  toJsonValue,
  topUpCall,
  topUpExecutorInstallCalls,
  transferCall,
  transferFromCall,
  userOperationFromJson,
  userOperationToJson,
  validatorNonceKey,
  vaultCreateCall,
  vaultDepositCalls,
  vaultWithdrawCall,
  vaultWithdrawWithSignatureCall,
  wrapSetupSafe,
  type Call,
  type UserOperationV07,
} from "../src";
import { cosigner, owner, payee, revenue, sessionKey, USDC } from "./helpers";

const account = getAddress("0x1000000000000000000000000000000000000001");

describe("ERC-7579 execution codec", () => {
  const a: Call = transferCall({ token: C.usdc, to: payee, amount: 5n });
  const b: Call = transferCall({ token: C.usdc, to: revenue, amount: 1n });

  it("round-trips single and batch executions", () => {
    const single = decodeExecute(encodeExecute([a]));
    expect(single).toMatchObject({
      ok: true,
      deploys: false,
      calls: [{ to: a.to, value: 0n, data: a.data }],
    });
    const batch = decodeExecute(encodeExecute([a, b]));
    expect(batch.ok && batch.calls.map((c) => c.data)).toEqual([a.data, b.data]);
    expect(batch.ok && batch.mode.callType).toBe(1);
    expect(() => encodeExecute([])).toThrow();
  });

  it("rejects delegatecall, try mode, mode selectors, empty batches and other calldata", () => {
    const exec = (mode: Hex, data: Hex) =>
      encodeFunctionData({ abi: safe7579Abi, functionName: "execute", args: [mode, data] });
    const packed = concatHex([a.to, toHex(0n, { size: 32 }), a.data]);
    expect(decodeExecute(exec(pad("0xff", { size: 32, dir: "right" }), packed))).toMatchObject({ ok: false });
    expect(decodeExecute(exec(pad("0x0001", { size: 32, dir: "right" }), packed))).toMatchObject({
      ok: false,
    });
    expect(
      decodeExecute(exec(pad("0x000000000000deadbeef", { size: 32, dir: "right" }), packed)),
    ).toMatchObject({ ok: false });
    const empty = encodeAbiParameters(
      [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
      [[]],
    );
    expect(decodeExecute(exec(MODE_BATCH_DEFAULT, empty))).toMatchObject({
      ok: false,
      reason: "empty batch",
    });
    expect(decodeExecute("0xdeadbeef")).toMatchObject({ ok: false });
    const install = encodeFunctionData({
      abi: safe7579Abi,
      functionName: "installModule",
      args: [1n, payee, "0x"],
    });
    expect(decodeExecute(install)).toMatchObject({ ok: false });
  });

  it("unwraps the launchpad's setupSafe of a deploying operation", () => {
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 1n };
    const wrapped = wrapSetupSafe(deployment, C, encodeExecute([a, b]));
    expect(decodeExecute(wrapped)).toMatchObject({ ok: true, deploys: true });
  });

  it("encodes validator nonce keys like module-sdk (validator in the top 20 bytes of the key)", () => {
    const key = validatorNonceKey(C.smartSessions);
    expect(toHex(key, { size: 24 })).toBe(
      pad(C.smartSessions.toLowerCase() as Hex, { size: 24, dir: "right" }),
    );
    const nonce = (validatorNonceKey(C.ownableValidator, 7) << 64n) | 42n;
    expect(decodeNonce(nonce)).toEqual({
      validator: C.ownableValidator,
      lane: 7,
      key: validatorNonceKey(C.ownableValidator, 7),
      sequence: 42n,
    });
    expect(() => validatorNonceKey(C.smartSessions, -1)).toThrow();
  });
});

describe("operation signatures", () => {
  const hash = keccak256(toHex("user op"));

  it("follows core's convention: EIP-191 over the raw 32 bytes", async () => {
    expect(OPERATION_HASH_SIGNING).toBe("eip191-raw-bytes32");
    const sig = await signOperationHash(sessionKey, hash);
    expect(await recoverAddress({ hash: hashMessage({ raw: hash }), signature: sig })).toBe(
      sessionKey.address,
    );
    expect(await recoverOperationSigner(hash, sig)).toBe(sessionKey.address);
    // Signing the hex text instead of the bytes gives a different signer.
    const textSig = await sessionKey.signMessage({ message: hash });
    expect(await recoverOperationSigner(hash, textSig)).not.toBe(sessionKey.address);
    await expect(signOperationHash(sessionKey, "0x1234")).rejects.toThrow(/32 bytes/);
  });

  it("encodes owner and session signatures for their validators", async () => {
    const sig = await signOperationHash(owner, hash);
    const v0 = concatHex([
      sig.slice(0, 130) as Hex,
      toHex(Number.parseInt(sig.slice(130), 16) - 27, { size: 1 }),
    ]);
    expect(encodeOwnerSignature(v0)).toBe(sig);
    expect(() => encodeOwnerSignature("0x1234")).toThrow(/65-byte/);
    expect(() => encodeOwnerSignature(concatHex([sig.slice(0, 130) as Hex, "0x05"]))).toThrow(/v value/);

    const permissionId = keccak256(toHex("permission"));
    const s1 = await signOperationHash(sessionKey, hash);
    const s2 = await signOperationHash(cosigner, hash);
    const encoded = encodeSessionSignature({ permissionId, sessionSignature: s1, cosignerSignature: s2 });
    expect(encoded.slice(0, 4)).toBe("0x00");
    expect(encoded.slice(4, 68)).toBe(permissionId.slice(2));
    const decoded = decodeSessionSignature(encoded);
    expect(decoded?.permissionId).toBe(permissionId);
    expect(decoded?.signatures.map((s) => Number.parseInt(s.slice(130), 16))).toEqual([
      Number.parseInt(s1.slice(130), 16) + 4,
      Number.parseInt(s2.slice(130), 16) + 4,
    ]);
    expect(await recoverOperationSigner(hash, decoded!.signatures[0]!)).toBe(sessionKey.address);
    expect(decodeSessionSignature("0x01")).toBeNull();
    expect(stubSessionSignature(permissionId).length).toBe(encoded.length);
    expect(stubOwnerSignature().length).toBe(s1.length);
    expect(() =>
      encodeSessionSignature({ permissionId: "0x12", sessionSignature: s1, cosignerSignature: s2 }),
    ).toThrow();
  });
});

describe("decoder", () => {
  const ctx = { contracts: C, account };
  const escrow = C.escrow as Address;
  const streams = C.streams as Address;
  const vaults = C.vaults as Address;

  it("classifies every builder", () => {
    const calls: Call[] = [
      transferCall({ token: C.usdc, to: payee, amount: 5n }),
      transferFromCall({ token: C.usdc, from: payee, to: account, amount: 6n }),
      ...escrowLockCalls({
        escrow,
        token: C.usdc,
        payee,
        amount: 7n,
        expiresAt: 100n,
        termsHash: keccak256("0x01"),
      }),
      escrowReleaseByValidationCall({ escrow, escrowId: 3n }),
      escrowRefundCall({ escrow, escrowId: 3n }),
      ...streamCreateCalls({
        streams,
        token: C.usdc,
        payee,
        deposit: 9n,
        amountPerInterval: 1n,
        interval: 60n,
      }),
      ...streamTopUpCalls({ streams, token: C.usdc, streamId: 2n, amount: 4n }),
      streamSettleCall({ streams, streamId: 2n }),
      streamCancelCall({ streams, streamId: 2n }),
      vaultCreateCall({ vaults, token: C.usdc, unlockAt: 1000n, owner: owner.address }),
      ...vaultDepositCalls({ vaults, token: C.usdc, vaultId: 1n, amount: 3n }),
      vaultWithdrawCall({ vaults, vaultId: 1n, amount: 1n }),
      vaultWithdrawWithSignatureCall({ vaults, vaultId: 1n, amount: 1n, deadline: 5n, signature: "0x" }),
      sessionRevokeCall({ contracts: C, permissionId: keccak256("0x02") }),
      disableModuleRegistryCall({ account }),
      topUpCall({ executor: C.topUpExecutor as Address, treasury: account, agent: payee }),
    ];
    const decoded = calls.map((c) => decodeCall(c, ctx));
    expect(decoded.map((d) => d.kind)).toEqual([
      "erc20_transfer",
      "erc20_transfer_from",
      "erc20_approve",
      "escrow_lock",
      "escrow_release",
      "escrow_refund",
      "erc20_approve",
      "stream_create",
      "erc20_approve",
      "stream_topup",
      "stream_settle",
      "stream_cancel",
      "vault_create",
      "erc20_approve",
      "vault_deposit",
      "vault_withdraw",
      "vault_withdraw",
      "session_revoke",
      "module_config",
      "unknown",
    ]);
    expect(decoded[0]).toMatchObject({ token: C.usdc, recipient: payee, amount: "5", value: "0" });
    expect(decoded[3]).toMatchObject({
      token: C.usdc,
      recipient: payee,
      amount: "7",
      args: { expiresAt: "100", arbiter: zeroAddress },
    });
    expect(decoded[4]?.args).toEqual({ escrowId: "3", byValidation: true });
    expect(decoded[7]).toMatchObject({
      recipient: payee,
      amount: "9",
      args: { interval: "60", start: "0", stop: "0" },
    });
    expect(decoded[16]?.args).toMatchObject({ early: true });
    expect(new Set(decoded.map((d) => d.kind)).size).toBeLessThanOrEqual(CALL_KINDS.length);
    expect(JSON.parse(JSON.stringify(decoded))).toEqual(decoded);
  });

  it("recognises Agent Bank functions only at their configured addresses", () => {
    const lookalike = { ...escrowRefundCall({ escrow, escrowId: 1n }), to: payee };
    expect(decodeCall(lookalike, ctx).kind).toBe("unknown");
    expect(decodeCall({ to: C.usdc, data: "0x" }, ctx).kind).toBe("unknown");
    expect(decodeCall({ to: C.usdc, data: "0xd505accf" }, ctx).kind).toBe("unknown");
    const viaOtherAccount = disableModuleRegistryCall({ account: payee });
    expect(decodeCall(viaOtherAccount, ctx).kind).toBe("unknown");
  });

  it("describes session installs and module configuration", () => {
    const grant = {
      sessionKey: sessionKey.address,
      cosigner: cosigner.address,
      salt: sessionSalt("ses_x"),
      scope: {
        token: C.usdc,
        maxPerTx: 1n,
        maxPerDay: 2n,
        allowedRecipients: [],
        allowedContracts: [],
        issuedAt: 1_000,
        expiresAt: 90_000,
      },
    };
    const [install] = sessionInstallCalls({ contracts: C, grant });
    const d = decodeCall(install!, ctx);
    expect(d.kind).toBe("session_install");
    const session = (d.args?.sessions as Record<string, unknown>[])[0];
    expect(session).toMatchObject({
      threshold: 2,
      validUntil: 90_000,
      validAfter: 0,
      erc1271: false,
      permitERC4337Paymaster: true,
    });
    expect(new Set(session?.signers as string[])).toEqual(new Set([sessionKey.address, cosigner.address]));
    const hook = policyHookInstallCalls({
      account,
      contracts: C,
      config: policyHookConfig(grant.scope, C),
      replace: true,
    });
    const decodedHook = hook.map((c) => decodeCall(c, ctx));
    expect(decodedHook.map((x) => x.args?.function)).toEqual(["uninstallModule", "installModule"]);
    expect(decodedHook[1]?.args).toMatchObject({ name: "AgentPolicyHook", moduleType: "4" });
    expect((decodedHook[1]?.args?.policy as { tokenLimits: unknown[] }).tokenLimits).toHaveLength(1);
    const exec = topUpExecutorInstallCalls({
      account,
      contracts: C,
      rules: [{ agent: payee, token: C.usdc, refillTo: 5n, whenBelow: 2n, maxPerDay: 9n }],
    });
    expect(decodeCall(exec[0]!, ctx).args).toMatchObject({ name: "TopUpExecutor", moduleType: "2" });
  });

  it("decodes whole operations and refuses anything that is not a plain execution", () => {
    const callData = encodeExecute([transferCall({ token: C.usdc, to: payee, amount: 1n })]);
    expect(decodeCalls(callData, ctx).map((c) => c.kind)).toEqual(["erc20_transfer"]);
    const delegate = encodeFunctionData({
      abi: safe7579Abi,
      functionName: "execute",
      args: [pad("0xff", { size: 32, dir: "right" }), concatHex([payee, toHex(0n, { size: 32 }), "0x"])],
    });
    expect(decodeCalls(delegate, ctx)).toEqual([
      {
        to: account,
        value: "0",
        data: delegate,
        kind: "unknown",
        args: { reason: "unsupported call type 0xff" },
      },
    ]);
  });
});

describe("account address derivation", () => {
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 3n };

  it("matches permissionless's Safe7579 derivation (offline, with the embedded proxy creation code)", async () => {
    const client = createPublicClient({
      transport: custom({
        async request({ method }) {
          if (method === "eth_chainId") return "0x539";
          if (method === "eth_getCode") return "0x";
          if (method === "eth_call")
            return encodeAbiParameters([{ type: "bytes" }], [SAFE_PROXY_CREATION_CODE]);
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    const reference = await toSafeSmartAccount({
      client,
      owners: [owner],
      version: "1.4.1",
      entryPoint: { address: C.entryPoint, version: "0.7" },
      safe4337ModuleAddress: C.safe7579,
      erc7579LaunchpadAddress: C.safe7579Launchpad,
      safeSingletonAddress: C.safeSingleton,
      attesters: [RHINESTONE_ATTESTER],
      attestersThreshold: 1,
      validators: [
        { address: C.ownableValidator, context: encodeOwnableValidatorConfig(1, [owner.address]) },
        { address: C.smartSessions, context: "0x" },
      ],
      saltNonce: accountSaltNonce(deployment),
    });
    expect(await reference.getAddress()).toBe(predictAccountAddress(deployment, C));
    const { factory, factoryData } = await reference.getFactoryArgs();
    expect({ factory, factoryData }).toEqual(accountFactoryArgs(deployment, C));
  });

  it("commits to owner, co-signer and salt", () => {
    const base = predictAccountAddress(deployment, C);
    expect(predictAccountAddress({ ...deployment, salt: 4n }, C)).not.toBe(base);
    expect(predictAccountAddress({ ...deployment, cosigner: sessionKey.address }, C)).not.toBe(base);
    expect(predictAccountAddress({ ...deployment, owner: sessionKey.address }, C)).not.toBe(base);
    expect(() => accountSaltNonce({ cosigner: cosigner.address, salt: -1n })).toThrow();
  });
});

describe("JSON codec", () => {
  const op: UserOperationV07 = {
    sender: account,
    nonce: (validatorNonceKey(C.smartSessions) << 64n) | 5n,
    callData: "0xabcdef",
    callGasLimit: 1n,
    verificationGasLimit: 2n,
    preVerificationGas: 3n,
    maxFeePerGas: 4n,
    maxPriorityFeePerGas: 5n,
    paymaster: C.usdc,
    paymasterVerificationGasLimit: 6n,
    paymasterPostOpGasLimit: 7n,
    paymasterData: "0x01",
    factory: C.safeProxyFactory,
    factoryData: "0x02",
    signature: "0x",
  };

  it("round-trips user operations with bigints as decimal strings", () => {
    const json = userOperationToJson(op);
    expect(json.nonce).toBe(op.nonce.toString());
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(userOperationFromJson(json)).toEqual(op);
    const bare = userOperationToJson({ ...op, paymaster: undefined, factory: undefined });
    expect(bare).toMatchObject({ paymaster: null, factory: null, paymasterData: null, factoryData: null });
  });

  it("validates untrusted JSON", () => {
    const json = userOperationToJson(op);
    expect(() => userOperationFromJson({ ...json, nonce: "0x05" })).toThrow(/unsigned integer/);
    expect(() => userOperationFromJson({ ...json, callData: "abc" as Hex })).toThrow(/hex/);
    expect(() => userOperationFromJson({ ...json, sender: "0x123" as Address })).toThrow(/address/);
    expect(() => parseUint("-1")).toThrow();
    expect(toJsonValue({ a: 1n, b: [payee.toLowerCase(), true], c: null })).toEqual({
      a: "1",
      b: [payee, true],
      c: null,
    });
  });
});

describe("events", () => {
  it("declares party arguments that exist and are addresses", () => {
    for (const name of CHAIN_EVENT_NAMES) {
      const inputs = CHAIN_EVENTS[name].inputs;
      for (const party of EVENT_PARTIES[name]) {
        expect(inputs.find((i) => i.name === party)?.type, `${name}.${party}`).toBe("address");
      }
    }
    expect(partyTopicPositions("Transfer")).toEqual([1, 2]);
    expect(partyTopicPositions("UserOperationEvent")).toEqual([2]);
    expect(partyTopicPositions("Locked")).toBeNull();
    expect(partyTopicPositions("SessionCreated")).toBeNull();
  });

  it("normalizes known events from their own contract only", () => {
    const topics = [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      pad(account.toLowerCase() as Hex, { size: 32 }),
      pad(payee.toLowerCase() as Hex, { size: 32 }),
    ] as Hex[];
    const raw = {
      topics,
      data: toHex(USDC(1), { size: 32 }),
      blockNumber: 5n,
      blockHash: keccak256("0x05"),
      transactionHash: keccak256("0x06"),
      logIndex: 2,
    };
    expect(normalizeLog({ ...raw, address: C.usdc }, 1337, C)).toEqual({
      chainId: 1337,
      blockNumber: 5n,
      blockHash: raw.blockHash,
      txHash: raw.transactionHash,
      logIndex: 2,
      address: C.usdc,
      eventName: "Transfer",
      args: { from: account, to: payee, value: "1000000" },
    });
    expect(normalizeLog({ ...raw, address: payee }, 1337, C)).toBeNull();
    expect(normalizeLog({ ...raw, topics: [keccak256("0x07")], address: C.usdc }, 1337, C)).toBeNull();
    expect(eventArgToString(true)).toBe("true");
    expect(eventArgToString(3)).toBe("3");
    expect(eventArgToString("0xABCDEF")).toBe("0xabcdef");
  });
});
