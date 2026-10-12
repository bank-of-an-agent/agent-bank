import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  agentAttestationRegistryAbi,
  ATTESTATION_MAX_VALIDITY_SECONDS,
  ownableErrorsAbi,
  SNARK_SCALAR_FIELD,
} from "../abis";
import { JMap } from "./journal";
import { emitLog, eventOf, revert, revertWith, type ExecContext } from "./vm";
import type { World } from "./world";

const ABI = agentAttestationRegistryAbi;
const ROOT_PUBLISHED = eventOf(ABI, "RootPublished");
const ROOT_REVOKED = eventOf(ABI, "RootRevoked");
const ATTESTER_CHANGED = eventOf(ABI, "AttesterChanged");

/** One root's record (mirrors `IAgentAttestationRegistry.RootInfo`). */
export interface SimRootInfo {
  epoch: bigint;
  snapshotAt: bigint;
  publishedAt: bigint;
  validUntil: bigint;
  leafCount: number;
  revoked: boolean;
}

interface RegistryState {
  owner: Address;
  attester: Address;
  latestEpoch: bigint;
  latestRoot: Hex;
}

const ZERO_INFO: SimRootInfo = Object.freeze({
  epoch: 0n,
  snapshotAt: 0n,
  publishedAt: 0n,
  validUntil: 0n,
  leafCount: 0,
  revoked: false,
});

/**
 * `AgentAttestationRegistry` semantics (contracts/src/interfaces/IAgentAttestationRegistry.sol):
 * the attester publishes roots of attested-facts trees; the attester or the owner revokes them; the
 * owner rotates the attester. Checks run in the interface's order and revert with its custom errors
 * (ABI-encoded in `SimRevert.data`). A root is published when its stored epoch is non-zero (every
 * accepted epoch is above `latestEpoch >= 0`). No funds, so no token calls. Not modeled: the
 * deployed contract's `Ownable2Step` transfers (tests choose the owner when constructing) and the
 * constructor's `AttesterChanged(0, attester)` (the registry exists from genesis, before any block).
 */
export class SimAttestationRegistry {
  private readonly roots: JMap<string, SimRootInfo>;
  private readonly state: JMap<"state", RegistryState>;

  constructor(
    world: World,
    readonly address: Address,
    init: { owner: Address; attester: Address },
  ) {
    if (isAddressEqual(init.owner, zeroAddress))
      throw new Error("registry owner must not be the zero address");
    if (isAddressEqual(init.attester, zeroAddress))
      throw new Error("registry attester must not be the zero address");
    this.roots = new JMap(world.journal);
    this.state = new JMap(world.journal);
    this.state.set("state", {
      owner: getAddress(init.owner),
      attester: getAddress(init.attester),
      latestEpoch: 0n,
      latestRoot: zeroHash,
    });
  }

  private get s(): RegistryState {
    return this.state.get("state") as RegistryState;
  }

  /** The owner (admin): may revoke roots and rotate the attester. */
  get owner(): Address {
    return this.s.owner;
  }

  /** `attester()`. */
  get attester(): Address {
    return this.s.attester;
  }

  /** `latestEpoch()`. */
  latestEpoch(): bigint {
    return this.s.latestEpoch;
  }

  /** `latestRoot()`: the root published last (zero before the first publication). */
  latestRoot(): Hex {
    return this.s.latestRoot;
  }

  /** `rootInfo(root)`: a zero struct for a root that was never published. */
  rootInfo(root: Hex): SimRootInfo {
    return this.roots.get(root.toLowerCase()) ?? ZERO_INFO;
  }

  /** `isValidRoot(root)` at block time `timestamp`: published, not revoked, `timestamp <= validUntil`. */
  isValidRoot(root: Hex, timestamp: number | bigint): boolean {
    const info = this.rootInfo(root);
    return info.epoch !== 0n && !info.revoked && BigInt(timestamp) <= info.validUntil;
  }

  /** `publishRoot(...)`, attester only. */
  publishRoot(
    ctx: ExecContext,
    caller: Address,
    root: Hex,
    epoch: bigint,
    snapshotAt: bigint,
    validUntil: bigint,
    leafCount: number,
  ): void {
    const s = this.s;
    if (!isAddressEqual(caller, s.attester)) revertWith(ABI, "NotAttester", [getAddress(caller)]);
    const r = root.toLowerCase() as Hex;
    if (BigInt(r) === 0n || BigInt(r) >= SNARK_SCALAR_FIELD) revertWith(ABI, "InvalidRoot", [r]);
    if (this.rootInfo(r).epoch !== 0n) revertWith(ABI, "RootAlreadyPublished", [r]);
    if (epoch <= s.latestEpoch) revertWith(ABI, "EpochNotIncreasing", [s.latestEpoch, epoch]);
    const now = BigInt(ctx.timestamp);
    if (snapshotAt > now) revertWith(ABI, "SnapshotInFuture", [snapshotAt]);
    if (validUntil <= now || validUntil > now + ATTESTATION_MAX_VALIDITY_SECONDS)
      revertWith(ABI, "InvalidValidity", [validUntil]);
    if (leafCount === 0) revertWith(ABI, "EmptyTree");

    this.roots.set(r, { epoch, snapshotAt, publishedAt: now, validUntil, leafCount, revoked: false });
    this.state.set("state", { ...s, latestEpoch: epoch, latestRoot: r });
    emitLog(ctx, this.address, ROOT_PUBLISHED, { root: r, epoch, snapshotAt, validUntil, leafCount });
  }

  /** `revokeRoots(roots)`, attester or owner. Already-revoked roots are skipped; unknown roots revert. */
  revokeRoots(ctx: ExecContext, caller: Address, roots: readonly Hex[]): void {
    const s = this.s;
    if (!isAddressEqual(caller, s.attester) && !isAddressEqual(caller, s.owner))
      revertWith(ABI, "NotAttesterOrOwner", [getAddress(caller)]);
    for (const root of roots) {
      const r = root.toLowerCase() as Hex;
      const info = this.rootInfo(r);
      if (info.epoch === 0n) revertWith(ABI, "UnknownRoot", [r]);
      if (info.revoked) continue;
      this.roots.set(r, { ...info, revoked: true });
      emitLog(ctx, this.address, ROOT_REVOKED, { root: r, by: getAddress(caller) });
    }
  }

  /** `setAttester(newAttester)`, owner only. */
  setAttester(ctx: ExecContext, caller: Address, newAttester: Address): void {
    const s = this.s;
    if (!isAddressEqual(caller, s.owner))
      revertWith(ownableErrorsAbi, "OwnableUnauthorizedAccount", [getAddress(caller)]);
    if (isAddressEqual(newAttester, zeroAddress)) revertWith(ABI, "ZeroAddress");
    const next = getAddress(newAttester);
    this.state.set("state", { ...s, attester: next });
    emitLog(ctx, this.address, ATTESTER_CHANGED, { previousAttester: s.attester, newAttester: next });
  }

  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: ABI, data });
    } catch {
      revert("AgentAttestationRegistry: unsupported function");
    }
    switch (decoded.functionName) {
      case "publishRoot": {
        const [root, epoch, snapshotAt, validUntil, leafCount] = decoded.args;
        this.publishRoot(ctx, from, root, epoch, snapshotAt, validUntil, leafCount);
        return "0x";
      }
      case "revokeRoots":
        this.revokeRoots(ctx, from, decoded.args[0]);
        return "0x";
      case "setAttester":
        this.setAttester(ctx, from, decoded.args[0]);
        return "0x";
      case "MAX_VALIDITY":
        return encodeFunctionResult({
          abi: ABI,
          functionName: "MAX_VALIDITY",
          result: ATTESTATION_MAX_VALIDITY_SECONDS,
        });
      case "SNARK_SCALAR_FIELD":
        return encodeFunctionResult({
          abi: ABI,
          functionName: "SNARK_SCALAR_FIELD",
          result: SNARK_SCALAR_FIELD,
        });
      case "attester":
        return encodeFunctionResult({ abi: ABI, functionName: "attester", result: this.attester });
      case "latestEpoch":
        return encodeFunctionResult({ abi: ABI, functionName: "latestEpoch", result: this.latestEpoch() });
      case "latestRoot":
        return encodeFunctionResult({ abi: ABI, functionName: "latestRoot", result: this.latestRoot() });
      case "rootInfo":
        return encodeFunctionResult({
          abi: ABI,
          functionName: "rootInfo",
          result: this.rootInfo(decoded.args[0]),
        });
      case "isValidRoot":
        return encodeFunctionResult({
          abi: ABI,
          functionName: "isValidRoot",
          result: this.isValidRoot(decoded.args[0], ctx.timestamp),
        });
    }
  }
}
