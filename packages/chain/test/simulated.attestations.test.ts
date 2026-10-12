import { describe, expect, it } from "vitest";
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  numberToHex,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentAttestationRegistryAbi,
  ATTESTATION_MAX_VALIDITY_SECONDS,
  ContractNotConfiguredError,
  eventSourceAddress,
  EVENT_PARTIES,
  formatContractError,
  isSimulatedAttester,
  ownableErrorsAbi,
  publishAttestationRootCall,
  revokeAttestationRootsCall,
  setAttesterCall,
  SNARK_SCALAR_FIELD,
  type PublishAttestationRootInput,
} from "../src";
import {
  SIMULATED_ADMIN,
  SIMULATED_ATTESTER,
  SIMULATED_ATTESTER_KEY,
  SIMULATED_CONTRACTS,
  SimAttestationRegistry,
  simulatedAttesterAccount,
  SimulatedChain,
} from "../src/simulated";
import { Journal } from "../src/simulated/journal";
import { SimRevert, type ExecContext } from "../src/simulated/vm";
import type { World } from "../src/simulated/world";
import { DEV_KEYS, stranger } from "./helpers";

const DAY = 86_400n;
const attester = simulatedAttesterAccount(1337);
const nextAttester = privateKeyToAccount(DEV_KEYS[7] as Hex);

/** A field element root (keccak mod r, never zero in practice). */
function rootOf(label: string): Hex {
  return numberToHex(BigInt(keccak256(toHex(label))) % SNARK_SCALAR_FIELD, { size: 32 });
}

function setup(options: ConstructorParameters<typeof SimulatedChain>[0] = {}) {
  const chain = new SimulatedChain(options);
  const gw = chain.gateway;
  const registry = chain.contracts.attestationRegistry as Address;
  /** Arguments valid for the next block (epoch 1, a one-hour window). */
  const input = (overrides: Partial<PublishAttestationRootInput> = {}): PublishAttestationRootInput => {
    const now = BigInt(chain.nextTimestamp());
    return {
      root: rootOf("root-1"),
      epoch: 1n,
      snapshotAt: now - 10n,
      validUntil: now + 3600n,
      leafCount: 8,
      attester,
      ...overrides,
    };
  };
  return { chain, gw, registry, input };
}

describe("simulated attester key", () => {
  it("is a public dev key usable only on the simulated chain", () => {
    expect(privateKeyToAccount(SIMULATED_ATTESTER_KEY).address).toBe(SIMULATED_ATTESTER);
    expect(simulatedAttesterAccount(1337).address).toBe(SIMULATED_ATTESTER);
    for (const chainId of [84532, 31337, 8453, 1]) {
      expect(() => simulatedAttesterAccount(chainId)).toThrow(/only signs on the simulated chain/);
    }
    expect(isSimulatedAttester(SIMULATED_ATTESTER.toLowerCase() as Address)).toBe(true);
    expect(isSimulatedAttester(stranger.address)).toBe(false);
  });
});

describe("SimulatedChain: AgentAttestationRegistry defaults and wiring", () => {
  it("deploys the registry at its fixed address with the default attester and admin", async () => {
    const { chain, gw, registry } = setup();
    expect(registry).toBe(SIMULATED_CONTRACTS.attestationRegistry);
    expect(SIMULATED_CONTRACTS.claimsVerifier).toBe(getAddress("0x000000000000000000000000000000000000ab07"));
    expect(chain.attestations.address).toBe(registry);
    expect(chain.attestations.attester).toBe(SIMULATED_ATTESTER);
    expect(chain.attestations.owner).toBe(SIMULATED_ADMIN);
    expect(chain.attestations.latestEpoch()).toBe(0n);
    expect(chain.attestations.latestRoot()).toBe(zeroHash);
    expect(await gw.getAttestationRoot(rootOf("unknown"))).toBeNull();
    // The registry has code (a contract, not an EOA): ECDSA signatures never verify for it.
    const sig = await privateKeyToAccount(SIMULATED_ATTESTER_KEY).sign({ hash: zeroHash });
    expect(await gw.verifySignature({ address: registry, hash: zeroHash, signature: sig })).toBe(false);
    // The claims verifier is an address only.
    const tx = chain.sendTransaction({
      from: stranger.address,
      to: SIMULATED_CONTRACTS.claimsVerifier!,
      data: "0x",
    });
    expect(chain.transaction(tx)?.revertReason).toMatch(/no contract/);
  });

  it("takes the attester and admin from options", async () => {
    const { chain, gw, input } = setup({ attester: nextAttester.address, registryOwner: stranger.address });
    expect(chain.attestations.attester).toBe(nextAttester.address);
    expect(chain.attestations.owner).toBe(stranger.address);
    await expect(gw.publishAttestationRoot(input())).rejects.toMatchObject({
      code: "invalid_state",
      message: `Transaction would revert: NotAttester(${SIMULATED_ATTESTER})`,
    });
    await gw.publishAttestationRoot(input({ attester: nextAttester }));
    expect(chain.attestations.latestEpoch()).toBe(1n);
  });

  it("needs a registry address", () => {
    expect(() => new SimulatedChain({ contracts: { attestationRegistry: undefined } })).toThrow(
      /attestationRegistry/,
    );
  });
});

describe("ChainGateway attestation methods on the simulator", () => {
  it("publishes, reads, revokes and reports receipts", async () => {
    const { chain, gw, registry, input } = setup();
    const args = input();
    const publishedAt = BigInt(chain.nextTimestamp());
    const { txHash } = await gw.publishAttestationRoot(args);
    const receipt = await gw.getTransactionReceipt(txHash);
    expect(receipt).toEqual({ status: "success", blockNumber: chain.head.number });
    expect(await gw.getAttestationRoot(args.root)).toEqual({
      epoch: 1n,
      snapshotAt: args.snapshotAt,
      publishedAt,
      validUntil: args.validUntil,
      leafCount: 8,
      revoked: false,
      valid: true,
    });
    // Upper-case hex reads the same root.
    expect((await gw.getAttestationRoot(args.root.toUpperCase().replace("0X", "0x") as Hex))?.epoch).toBe(1n);
    expect(chain.attestations.latestRoot()).toBe(args.root);
    expect(chain.attestations.latestEpoch()).toBe(1n);

    const published = await gw.getLogs({
      fromBlock: 0n,
      toBlock: chain.head.number,
      events: ["RootPublished"],
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      address: registry,
      txHash,
      eventName: "RootPublished",
      args: {
        root: args.root,
        epoch: "1",
        snapshotAt: args.snapshotAt.toString(),
        validUntil: args.validUntil.toString(),
        leafCount: "8",
      },
    });

    const revoke = await gw.revokeAttestationRoots({ roots: [args.root], attester });
    expect(await gw.getTransactionReceipt(revoke.txHash)).toMatchObject({ status: "success" });
    expect(await gw.getAttestationRoot(args.root)).toMatchObject({ revoked: true, valid: false });
    const revoked = await gw.getLogs({ fromBlock: 0n, toBlock: chain.head.number, events: ["RootRevoked"] });
    expect(revoked.map((l) => l.args)).toEqual([{ root: args.root, by: SIMULATED_ATTESTER }]);
    // latestRoot/latestEpoch still describe the last publication.
    expect(chain.attestations.latestRoot()).toBe(args.root);

    // Revoking again is a no-op that succeeds (already-revoked roots are skipped).
    const again = await gw.revokeAttestationRoots({ roots: [args.root, args.root], attester });
    expect(chain.transaction(again.txHash)).toMatchObject({ success: true, logs: [] });

    expect(await gw.getTransactionReceipt(keccak256("0x01"))).toBeNull();
  });

  it("returns no receipt while a transaction is pending, and none after a reorg drops it", async () => {
    const { chain, gw, input } = setup({ automine: false });
    const args = input();
    const { txHash } = await gw.publishAttestationRoot(args);
    expect(await gw.getTransactionReceipt(txHash)).toBeNull();
    expect(await gw.getAttestationRoot(args.root)).toBeNull();
    chain.mine();
    expect(await gw.getTransactionReceipt(txHash)).toMatchObject({ status: "success" });
    expect(await gw.getAttestationRoot(args.root)).not.toBeNull();

    const reorg = chain.injectReorg(1, { drop: [txHash] });
    expect(reorg.dropped).toEqual([txHash]);
    expect(await gw.getTransactionReceipt(txHash)).toBeNull();
    expect(await gw.getAttestationRoot(args.root)).toBeNull();
    expect(chain.attestations.latestEpoch()).toBe(0n);
    expect(chain.attestations.latestRoot()).toBe(zeroHash);
  });

  it("reports a reverted transaction's receipt", async () => {
    const { chain, gw, registry } = setup();
    const tx = chain.sendTransaction({
      from: stranger.address,
      to: registry,
      data: setAttesterCall({ registry, attester: stranger.address }).data,
    });
    expect(await gw.getTransactionReceipt(tx)).toEqual({
      status: "reverted",
      blockNumber: chain.head.number,
    });
  });

  it("enforces every publishRoot rule with the registry's custom errors", async () => {
    const { chain, gw, input } = setup();
    const reject = (args: PublishAttestationRootInput, reason: string) =>
      expect(gw.publishAttestationRoot(args)).rejects.toMatchObject({
        code: "invalid_state",
        message: `Transaction would revert: ${reason}`,
        extensions: { revertReason: reason },
      });
    const now = () => BigInt(chain.nextTimestamp());
    const strangerAccount = stranger as LocalAccount;

    await reject(input({ attester: strangerAccount }), `NotAttester(${stranger.address})`);
    // The caller is checked first.
    await reject(input({ attester: strangerAccount, root: zeroHash }), `NotAttester(${stranger.address})`);
    await reject(input({ root: zeroHash }), `InvalidRoot(${zeroHash})`);
    const field = numberToHex(SNARK_SCALAR_FIELD, { size: 32 });
    await reject(input({ root: field }), `InvalidRoot(${field})`);
    const max = numberToHex(maxUint256, { size: 32 });
    await reject(input({ root: max }), `InvalidRoot(${max})`);
    await reject(input({ epoch: 0n }), "EpochNotIncreasing(0, 0)");
    await reject(input({ snapshotAt: now() + 1n }), `SnapshotInFuture(${now() + 1n})`);
    await reject(input({ validUntil: now() }), `InvalidValidity(${now()})`);
    await reject(input({ validUntil: now() - 1n }), `InvalidValidity(${now() - 1n})`);
    const tooLong = now() + ATTESTATION_MAX_VALIDITY_SECONDS + 1n;
    await reject(input({ validUntil: tooLong }), `InvalidValidity(${tooLong})`);
    await reject(input({ leafCount: 0 }), "EmptyTree()");
    // Nothing above changed state or emitted logs.
    expect(chain.head.number).toBe(0n);

    // Boundaries: the largest field element, snapshot exactly now, validity exactly 7 days.
    const largest = numberToHex(SNARK_SCALAR_FIELD - 1n, { size: 32 });
    await gw.publishAttestationRoot(
      input({ root: largest, snapshotAt: now(), validUntil: now() + ATTESTATION_MAX_VALIDITY_SECONDS }),
    );
    expect(await gw.getAttestationRoot(largest)).toMatchObject({ epoch: 1n, valid: true });

    await reject(input({ root: largest, epoch: 2n }), `RootAlreadyPublished(${largest})`);
    await reject(input({ root: rootOf("root-2"), epoch: 1n }), "EpochNotIncreasing(1, 1)");
    await reject(input({ root: rootOf("root-2"), epoch: 0n }), "EpochNotIncreasing(1, 0)");
    // Epochs may skip numbers; they only have to increase.
    await gw.publishAttestationRoot(input({ root: rootOf("root-2"), epoch: 5n, leafCount: 2 ** 32 - 1 }));
    expect(chain.attestations.latestEpoch()).toBe(5n);
    expect(chain.attestations.latestRoot()).toBe(rootOf("root-2"));
    // A revoked root can never be published again.
    await gw.revokeAttestationRoots({ roots: [rootOf("root-2")], attester });
    await reject(input({ root: rootOf("root-2"), epoch: 6n }), `RootAlreadyPublished(${rootOf("root-2")})`);
  });

  it("checks argument types before sending", async () => {
    const { gw, input } = setup();
    const bad: Partial<PublishAttestationRootInput>[] = [
      { root: "0x1234" },
      { root: "not hex" as Hex },
      { epoch: -1n },
      { epoch: 2n ** 64n },
      { snapshotAt: 2n ** 64n },
      { validUntil: -5n },
      { epoch: 1 as unknown as bigint },
      { leafCount: 1.5 },
      { leafCount: -1 },
      { leafCount: 2 ** 32 },
    ];
    for (const overrides of bad) {
      await expect(
        gw.publishAttestationRoot(input(overrides)),
        Object.keys(overrides)[0],
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await expect(gw.revokeAttestationRoots({ roots: [], attester })).rejects.toMatchObject({
      code: "invalid_request",
      message: "at least one root is required",
    });
    await expect(gw.revokeAttestationRoots({ roots: ["0x12"], attester })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/roots\[0\]/),
    });
    await expect(gw.getAttestationRoot("0x12")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("revokes for the attester or the owner only, atomically, and refuses unknown roots", async () => {
    const { chain, gw, registry, input } = setup();
    const a = rootOf("a");
    const b = rootOf("b");
    await gw.publishAttestationRoot(input({ root: a, epoch: 1n }));
    await gw.publishAttestationRoot(input({ root: b, epoch: 2n }));

    await expect(gw.revokeAttestationRoots({ roots: [a], attester: stranger })).rejects.toMatchObject({
      message: `Transaction would revert: NotAttesterOrOwner(${stranger.address})`,
    });
    const unknown = rootOf("never");
    await expect(gw.revokeAttestationRoots({ roots: [a, unknown], attester })).rejects.toMatchObject({
      message: `Transaction would revert: UnknownRoot(${unknown})`,
    });
    expect(await gw.getAttestationRoot(a)).toMatchObject({ revoked: false });

    // The owner (governance multisig) revokes through its own transaction.
    const tx = chain.sendTransaction({
      from: SIMULATED_ADMIN,
      to: registry,
      data: revokeAttestationRootsCall({ registry, roots: [a, b] }).data,
    });
    const result = chain.transaction(tx);
    expect(result?.success).toBe(true);
    expect(result?.logs.map((l) => [l.eventName, l.args.root, l.args.by])).toEqual([
      ["RootRevoked", a, SIMULATED_ADMIN],
      ["RootRevoked", b, SIMULATED_ADMIN],
    ]);
    expect(await gw.getAttestationRoot(b)).toMatchObject({ revoked: true, valid: false });
  });

  it("lets only the owner rotate the attester", async () => {
    const { chain, gw, registry, input } = setup();
    const rotate = (from: Address, to: Address) =>
      chain.transaction(
        chain.sendTransaction({ from, to: registry, data: setAttesterCall({ registry, attester: to }).data }),
      );

    expect(rotate(SIMULATED_ATTESTER, nextAttester.address)).toMatchObject({
      success: false,
      revertReason: `OwnableUnauthorizedAccount(${SIMULATED_ATTESTER})`,
    });
    expect(rotate(SIMULATED_ADMIN, zeroAddress)).toMatchObject({
      success: false,
      revertReason: "ZeroAddress()",
    });
    const rotated = rotate(SIMULATED_ADMIN, nextAttester.address);
    expect(rotated?.success).toBe(true);
    expect(rotated?.logs.map((l) => [l.eventName, l.args])).toEqual([
      ["AttesterChanged", { previousAttester: SIMULATED_ATTESTER, newAttester: nextAttester.address }],
    ]);
    expect(chain.attestations.attester).toBe(nextAttester.address);

    await expect(gw.publishAttestationRoot(input())).rejects.toMatchObject({
      message: `Transaction would revert: NotAttester(${SIMULATED_ATTESTER})`,
    });
    await gw.publishAttestationRoot(input({ attester: nextAttester }));
    // The old attester can no longer revoke; the new one can.
    await expect(gw.revokeAttestationRoots({ roots: [input().root], attester })).rejects.toMatchObject({
      message: `Transaction would revert: NotAttesterOrOwner(${SIMULATED_ATTESTER})`,
    });
    await gw.revokeAttestationRoots({ roots: [input().root], attester: nextAttester });
  });

  it("expires roots after validUntil (valid while block.timestamp <= validUntil)", async () => {
    const { chain, gw, input } = setup();
    const args = input({ validUntil: BigInt(chain.nextTimestamp()) + 100n });
    await gw.publishAttestationRoot(args);
    const head = BigInt(chain.head.timestamp);
    chain.advanceTime(Number(args.validUntil - head) - 2);
    chain.mine();
    expect(BigInt(chain.head.timestamp)).toBe(args.validUntil);
    expect(await gw.getAttestationRoot(args.root)).toMatchObject({ valid: true });
    chain.mine();
    expect(await gw.getAttestationRoot(args.root)).toMatchObject({ valid: false, revoked: false });
    // Expired roots can still be revoked.
    await gw.revokeAttestationRoots({ roots: [args.root], attester });
    expect(await gw.getAttestationRoot(args.root)).toMatchObject({ revoked: true });
  });

  it("keeps registry events out of `involving` queries (they name no party)", async () => {
    const { chain, gw, registry, input } = setup();
    await gw.publishAttestationRoot(input());
    expect(EVENT_PARTIES.RootPublished).toEqual([]);
    expect(eventSourceAddress("RootRevoked", chain.contracts)).toBe(registry);
    const head = chain.head.number;
    expect(await gw.getLogs({ fromBlock: 0n, toBlock: head, involving: [SIMULATED_ATTESTER] })).toEqual([]);
    expect(await gw.getLogs({ fromBlock: 0n, toBlock: head, addresses: [registry] })).toHaveLength(1);
    expect(eventSourceAddress("RootPublished", { ...chain.contracts, attestationRegistry: undefined })).toBe(
      undefined,
    );
  });

  it("serves the registry's views through calls", async () => {
    const { chain, gw, registry, input } = setup();
    const args = input();
    await gw.publishAttestationRoot(args);
    const view = (functionName: string, fnArgs: readonly unknown[] = []): unknown => {
      const data = encodeFunctionData({
        abi: agentAttestationRegistryAbi,
        functionName,
        args: fnArgs,
      } as never);
      const ctx = context(BigInt(chain.head.timestamp));
      return decodeFunctionResult({
        abi: agentAttestationRegistryAbi,
        functionName,
        data: chain.attestations.handle(ctx, stranger.address, data),
      } as never);
    };
    expect(view("MAX_VALIDITY")).toBe(7n * DAY);
    expect(view("SNARK_SCALAR_FIELD")).toBe(SNARK_SCALAR_FIELD);
    expect(view("attester")).toBe(SIMULATED_ATTESTER);
    expect(view("latestEpoch")).toBe(1n);
    expect(view("latestRoot")).toBe(args.root);
    expect(view("isValidRoot", [args.root])).toBe(true);
    expect(view("isValidRoot", [rootOf("x")])).toBe(false);
    expect(view("rootInfo", [args.root])).toMatchObject({ epoch: 1n, leafCount: 8, revoked: false });
    expect(view("rootInfo", [rootOf("x")])).toEqual({
      epoch: 0n,
      snapshotAt: 0n,
      publishedAt: 0n,
      validUntil: 0n,
      leafCount: 0,
      revoked: false,
    });
    const tx = chain.sendTransaction({ from: stranger.address, to: registry, data: "0xdeadbeef" });
    expect(chain.transaction(tx)?.revertReason).toBe("AgentAttestationRegistry: unsupported function");
  });
});

function context(timestamp: bigint, journal = new Journal()): ExecContext {
  return { blockNumber: 1n, timestamp: Number(timestamp), txHash: zeroHash, logs: [], journal };
}

describe("SimAttestationRegistry (direct calls)", () => {
  const address = SIMULATED_CONTRACTS.attestationRegistry as Address;
  const T = 1_800_000_000n;

  function registry() {
    const journal = new Journal();
    const world = { journal } as unknown as World;
    const reg = new SimAttestationRegistry(world, address, {
      owner: SIMULATED_ADMIN,
      attester: SIMULATED_ATTESTER,
    });
    return { reg, journal, ctx: () => context(T, journal) };
  }

  function revertOf(fn: () => void): { reason: string; errorName: string; args: readonly unknown[] } {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(SimRevert);
      const { reason, data } = error as SimRevert;
      const decoded = decodeErrorResult({
        abi: [...agentAttestationRegistryAbi, ...ownableErrorsAbi],
        data: data as Hex,
      });
      expect(formatContractError(decoded.errorName, decoded.args ?? [])).toBe(reason);
      return { reason, errorName: decoded.errorName, args: decoded.args ?? [] };
    }
    throw new Error("expected a revert");
  }

  it("refuses zero addresses at construction", () => {
    const world = { journal: new Journal() } as unknown as World;
    expect(
      () => new SimAttestationRegistry(world, address, { owner: zeroAddress, attester: SIMULATED_ATTESTER }),
    ).toThrow(/owner/);
    expect(
      () => new SimAttestationRegistry(world, address, { owner: SIMULATED_ADMIN, attester: zeroAddress }),
    ).toThrow(/attester/);
  });

  it("reverts with ABI-encoded custom errors", () => {
    const { reg, ctx } = registry();
    const root = rootOf("direct");
    expect(revertOf(() => reg.publishRoot(ctx(), stranger.address, root, 1n, T, T + 1n, 1))).toEqual({
      reason: `NotAttester(${stranger.address})`,
      errorName: "NotAttester",
      args: [stranger.address],
    });
    expect(revertOf(() => reg.publishRoot(ctx(), SIMULATED_ATTESTER, root, 1n, T, T, 1)).errorName).toBe(
      "InvalidValidity",
    );
    expect(
      revertOf(() => reg.publishRoot(ctx(), SIMULATED_ATTESTER, root, 1n, T + 1n, T + 1n, 1)),
    ).toMatchObject({
      errorName: "SnapshotInFuture",
      args: [T + 1n],
    });
    expect(revertOf(() => reg.publishRoot(ctx(), SIMULATED_ATTESTER, root, 1n, T, T + 1n, 0)).reason).toBe(
      "EmptyTree()",
    );
    expect(revertOf(() => reg.revokeRoots(ctx(), stranger.address, [root])).errorName).toBe(
      "NotAttesterOrOwner",
    );
    expect(revertOf(() => reg.revokeRoots(ctx(), SIMULATED_ADMIN, [root])).args).toEqual([root]);
    expect(revertOf(() => reg.setAttester(ctx(), SIMULATED_ATTESTER, stranger.address))).toMatchObject({
      errorName: "OwnableUnauthorizedAccount",
      args: [SIMULATED_ATTESTER],
    });
    expect(revertOf(() => reg.setAttester(ctx(), SIMULATED_ADMIN, zeroAddress)).reason).toBe("ZeroAddress()");
  });

  it("journals every change so a revert or reorg restores the previous state", () => {
    const { reg, journal, ctx } = registry();
    const root = rootOf("journal");
    const c = ctx();
    const mark = journal.mark();
    reg.publishRoot(c, SIMULATED_ATTESTER, root, 3n, T - 5n, T + DAY, 4);
    reg.revokeRoots(c, SIMULATED_ADMIN, [root]);
    reg.setAttester(c, SIMULATED_ADMIN, stranger.address);
    expect(c.logs).toHaveLength(3);
    expect(reg.rootInfo(root)).toEqual({
      epoch: 3n,
      snapshotAt: T - 5n,
      publishedAt: T,
      validUntil: T + DAY,
      leafCount: 4,
      revoked: true,
    });
    expect(reg.isValidRoot(root, T)).toBe(false);
    journal.revertTo(mark);
    expect(c.logs).toHaveLength(0);
    expect(reg.rootInfo(root).publishedAt).toBe(0n);
    expect(reg.latestEpoch()).toBe(0n);
    expect(reg.latestRoot()).toBe(zeroHash);
    expect(reg.attester).toBe(SIMULATED_ATTESTER);
  });

  it("validity is publication .. validUntil inclusive", () => {
    const { reg, ctx } = registry();
    const root = rootOf("window");
    reg.publishRoot(ctx(), SIMULATED_ATTESTER, root, 1n, T, T + 10n, 1);
    expect(reg.isValidRoot(root, T)).toBe(true);
    expect(reg.isValidRoot(root, T + 10n)).toBe(true);
    expect(reg.isValidRoot(root, T + 11n)).toBe(false);
    expect(reg.isValidRoot(rootOf("other"), T)).toBe(false);
  });
});

describe("attestation call builders", () => {
  it("build calldata for the registry and check ABI types", () => {
    const registry = SIMULATED_CONTRACTS.attestationRegistry as Address;
    const call = publishAttestationRootCall({
      registry: registry.toLowerCase() as Address,
      root: rootOf("b").toUpperCase().replace("0X", "0x") as Hex,
      epoch: 1n,
      snapshotAt: 2n,
      validUntil: 3n,
      leafCount: 4,
    });
    expect(call.to).toBe(registry);
    expect(call.data).toBe(
      encodeFunctionData({
        abi: agentAttestationRegistryAbi,
        functionName: "publishRoot",
        args: [rootOf("b"), 1n, 2n, 3n, 4],
      }),
    );
    expect(setAttesterCall({ registry, attester: stranger.address }).data).toBe(
      encodeFunctionData({
        abi: agentAttestationRegistryAbi,
        functionName: "setAttester",
        args: [stranger.address],
      }),
    );
    expect(() => revokeAttestationRootsCall({ registry, roots: undefined as unknown as Hex[] })).toThrow(
      /at least one/,
    );
    expect(formatContractError("X", [[1n, stranger.address.toLowerCase()], true, "0xab"])).toBe(
      `X([1, ${stranger.address}], true, 0xab)`,
    );
  });

  it("ContractNotConfiguredError is a typed invalid_state error", () => {
    const error = new ContractNotConfiguredError("attestationRegistry", 84532);
    expect(error).toMatchObject({
      name: "ContractNotConfiguredError",
      code: "invalid_state",
      contract: "attestationRegistry",
      extensions: { contract: "attestationRegistry", chainId: 84532 },
    });
    expect(error.message).toBe("attestationRegistry is not configured on chain 84532");
  });
});
