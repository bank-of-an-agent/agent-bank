import { AgentBankError, assertTestnet, CHAINS, ManualClock, unixSeconds, type Clock } from "@agentbank/core";
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  size,
  slice,
  stringToHex,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { accountFactoryArgs, predictAccountAddress, wrapSetupSafe } from "../account";
import { erc20Abi } from "../abis";
import {
  parseAttestationRoot,
  publishAttestationRootCall,
  revokeAttestationRootsCall,
  toAttestationRootInfo,
} from "../attestations";
import {
  DEFAULT_OWNER_OP_TTL_SECONDS,
  DEFAULT_SESSION_OP_TTL_SECONDS,
  SIMULATED_ATTESTER,
  SIMULATED_CONTRACTS,
} from "../constants";
import { decodeCalls } from "../decode";
import { encodeExecute, validatorNonceKey } from "../erc7579";
import { userOperationToJson, type UserOperationV07 } from "../json";
import { assertRelayableCall } from "../relay";
import { stubOwnerSignature, stubSessionSignature } from "../signing";
import { logInvolves, normalizeLog, sortLogs, type RawLog } from "../logs";
import type {
  AccountDeployment,
  AttestationRootInfo,
  BlockRef,
  BlockTag,
  ChainContracts,
  ChainGateway,
  ChainLog,
  DecodedCall,
  LogQuery,
  OperationReceipt,
  PreparedOperation,
  PrepareOperationInput,
  PrepareOwnerOperationInput,
  PublishAttestationRootInput,
  RelayCallInput,
  RevokeAttestationRootsInput,
  SettleAuthorizationInput,
  SubmitOperationInput,
  TransactionReceiptInfo,
} from "../types";
import { checkPreparedOperation, decodePreparedOperation, hashUserOperation } from "../userop";
import { SimAccounts, type SimAccountRecord } from "./accounts";
import { SimAttestationRegistry } from "./attestationRegistry";
import { ecrecover, splitSignature } from "./ecdsa";
import { OperationRejected, SimEntryPoint } from "./entryPoint";
import { SimEscrow, type SimEscrowRecord } from "./escrow";
import { Journal, undoAll } from "./journal";
import { SimPolicyHook } from "./policyHook";
import { SimSmartSessions, type SimSession } from "./smartSessions";
import { SimStreams, type SimStreamRecord } from "./streams";
import { SimToken } from "./token";
import { SimTopUp } from "./topup";
import { SimVaults, type SimVaultRecord } from "./vaults";
import { revert, SimRevert, type ExecContext } from "./vm";
import type { World } from "./world";

/** Paymaster address the simulator puts on sponsored operations (sponsorship is not metered). */
export const SIMULATED_PAYMASTER: Address = getAddress("0x00000000000000000000000000000000000fee01");
/** Relayer recorded for settlements and keeper calls when none is given. */
export const SIMULATED_RELAYER: Address = getAddress("0x00000000000000000000000000000000000fee02");
/** `from` of faucet mints. */
export const SIMULATED_FAUCET: Address = getAddress("0x00000000000000000000000000000000000fee03");
/**
 * Default owner (admin) of the simulated `AgentAttestationRegistry`: stands in for the governance
 * multisig (revokes roots, rotates the attester). Send its calls with `sendTransaction`.
 */
export const SIMULATED_ADMIN: Address = getAddress("0x00000000000000000000000000000000000fee04");

const ERC6492_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

/** Options of {@link SimulatedChain}. */
export interface SimulatedChainOptions {
  /** Default: the core `simulated` chain (1337). Must be a testnet id. */
  chainId?: number;
  /** Override contract addresses (default {@link SIMULATED_CONTRACTS}). */
  contracts?: Partial<ChainContracts>;
  /**
   * Shared clock: block timestamps follow it (each block at least 1 s after its parent). Without one
   * the chain keeps its own clock starting at `startTime` and advances it `blockTimeSeconds` per block.
   */
  clock?: Clock;
  /** Start of the internal clock (default 2026-10-11T12:00:00Z). */
  startTime?: Date | string | number;
  /** Seconds between blocks on the internal clock (default 2). */
  blockTimeSeconds?: number;
  /** `safe` tag lags `latest` by this many blocks (default 3). */
  safeDepth?: number;
  /** `finalized` lags `latest` by this many blocks (default 12); reorgs never touch finalized blocks. */
  finalityDepth?: number;
  /** Mine a block for every submitted transaction (default true). */
  automine?: boolean;
  /** Sponsor operations with {@link SIMULATED_PAYMASTER}, like production's Pimlico paymaster (default true). */
  sponsor?: boolean;
  /**
   * Attester of the `AgentAttestationRegistry` (default {@link SIMULATED_ATTESTER}, the address of
   * the public `SIMULATED_ATTESTER_KEY`; sign with `simulatedAttesterAccount(1337)`).
   */
  attester?: Address;
  /** Owner (admin) of the `AgentAttestationRegistry` (default {@link SIMULATED_ADMIN}). */
  registryOwner?: Address;
}

/** Options of {@link SimulatedChain.injectReorg}. */
export interface ReorgOptions {
  /** Order of the surviving transactions in the replacement blocks (default "same"). */
  order?: "same" | "reverse" | "shuffle";
  /** Seed for "shuffle" (default 1). */
  seed?: number;
  /** Transactions to leave out of the replacement blocks: tx hashes or "all". */
  drop?: readonly Hex[] | "all";
  /** Put dropped transactions back in the pending pool (mined with the next block) instead of discarding them. */
  requeue?: boolean;
  /** Number of replacement blocks (default: the reorg depth). */
  blocks?: number;
}

/** What {@link SimulatedChain.injectReorg} replaced. */
export interface ReorgResult {
  removed: BlockRef[];
  added: BlockRef[];
  /** Transactions not re-included (explicitly dropped, or user operations that became invalid). */
  dropped: Hex[];
}

type TxIntent =
  | { kind: "userop"; userOp: UserOperationV07; userOpHash: Hex }
  | { kind: "call"; from: Address; to: Address; data: Hex }
  | { kind: "faucet"; to: Address; amount: bigint };

interface SimTx {
  hash: Hex;
  intent: TxIntent;
}

interface SealedTx extends SimTx {
  success: boolean;
  revertReason: string | null;
  actualGasCost: bigint | null;
  /** Block log indexes `[from, to)` a bundler reports in the operation receipt (execution phase only). */
  receiptLogs: [number, number];
}

interface SimBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  txs: SealedTx[];
  logs: RawLog[];
  undo: (() => void)[];
  dirtyHolders: Address[];
}

function ref(b: SimBlock): BlockRef {
  return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An in-memory, deterministic chain that implements Agent Bank's on-chain rules without a network:
 * Safe7579 accounts (counterfactual addresses identical to production), the owner path
 * (OwnableValidator) and the session path (Smart Sessions + 2-of-2 OwnableValidator with Agent
 * Bank's policies), AgentPolicyHook, USDC with EIP-3009/EIP-2612, AgentEscrow, PaymentStreams,
 * TimeLockVaults, TopUpExecutor and the AgentAttestationRegistry (private-proof roots; the claims
 * verifier is not modeled), blocks with `latest`/`safe`/`finalized` tags, time control and reorg
 * injection. `gateway` implements {@link ChainGateway}.
 */
export class SimulatedChain {
  readonly chainId: number;
  readonly contracts: ChainContracts;
  readonly gateway: ChainGateway;

  readonly safeDepth: number;
  readonly finalityDepth: number;
  automine: boolean;
  readonly sponsor: boolean;

  private readonly journal = new Journal();
  private readonly world: World;
  readonly usdc: SimToken;
  readonly escrow: SimEscrow;
  readonly streams: SimStreams;
  readonly vaults: SimVaults;
  readonly hook: SimPolicyHook;
  readonly topUp: SimTopUp;
  readonly attestations: SimAttestationRegistry;
  readonly smartSessions: SimSmartSessions;
  readonly accounts: SimAccounts;
  private readonly entryPoint: SimEntryPoint;

  private readonly clock: Clock;
  private readonly ownsClock: boolean;
  private readonly blockTimeSeconds: number;
  private timeOffset = 0;

  private readonly blocks: SimBlock[] = [];
  private pool: SimTx[] = [];
  private readonly deployments = new Map<string, AccountDeployment>();
  private readonly opBlock = new Map<string, bigint>();
  private readonly droppedOps = new Set<string>();
  private readonly balanceHistory = new Map<string, { block: bigint; value: bigint }[]>();
  private txCounter = 0;
  private reorgCount = 0;
  /** Highest block whose undo log was dropped (finalized). */
  private compactedThrough = 0;

  constructor(options: SimulatedChainOptions = {}) {
    this.chainId = options.chainId ?? CHAINS.simulated.id;
    assertTestnet(this.chainId);
    this.contracts = { ...SIMULATED_CONTRACTS, ...options.contracts };
    this.safeDepth = options.safeDepth ?? 3;
    this.finalityDepth = options.finalityDepth ?? 12;
    if (this.safeDepth < 0 || this.finalityDepth < this.safeDepth)
      throw new RangeError("need 0 <= safeDepth <= finalityDepth");
    this.automine = options.automine ?? true;
    this.sponsor = options.sponsor ?? true;
    this.blockTimeSeconds = options.blockTimeSeconds ?? 2;
    this.ownsClock = options.clock === undefined;
    this.clock = options.clock ?? new ManualClock(options.startTime ?? "2026-10-11T12:00:00Z");

    const c = this.contracts;
    this.world = {
      chainId: this.chainId,
      contracts: c,
      journal: this.journal,
      call: (ctx, from, to, value, data) => this.dispatch(ctx, from, to, value, data),
      hasCode: (address) => this.hasCode(address),
      isValidSignature1271: (account, hash, signature) => {
        const record = this.accounts.get(account);
        return record ? this.accounts.isValidSignature(record, hash, signature) : false;
      },
      balanceOf: (token, holder) => (isAddressEqual(token, c.usdc) ? this.usdc.balanceOf(holder) : 0n),
    };
    this.usdc = new SimToken(this.world, c.usdc);
    this.escrow = new SimEscrow(this.world, this.required(c.escrow, "escrow"));
    this.streams = new SimStreams(this.world, this.required(c.streams, "streams"));
    this.vaults = new SimVaults(this.world, this.required(c.vaults, "vaults"));
    this.hook = new SimPolicyHook(this.world, this.required(c.policyHook, "policyHook"), (vaults, id) =>
      isAddressEqual(vaults, this.vaults.address)
        ? (this.vaults.get(id)?.account ?? getAddress("0x0000000000000000000000000000000000000000"))
        : revert("unknown vault registry"),
    );
    this.topUp = new SimTopUp(
      this.world,
      this.required(c.topUpExecutor, "topUpExecutor"),
      (ctx, executor, account, callData) =>
        this.accounts.executeFromExecutor(ctx, executor, account, callData),
    );
    this.attestations = new SimAttestationRegistry(
      this.world,
      this.required(c.attestationRegistry, "attestationRegistry"),
      { owner: options.registryOwner ?? SIMULATED_ADMIN, attester: options.attester ?? SIMULATED_ATTESTER },
    );
    this.smartSessions = new SimSmartSessions(this.world, c.smartSessions, c);
    this.accounts = new SimAccounts(this.world, c, this.hook, {
      [this.topUp.address.toLowerCase()]: this.topUp,
    });
    this.entryPoint = new SimEntryPoint(this.journal, c, this.accounts, this.smartSessions, (a) =>
      this.deployments.get(a.toLowerCase()),
    );
    this.accounts.seedRegistry();

    const startTimestamp = this.nowSeconds();
    const genesis: SimBlock = {
      number: 0n,
      hash: keccak256(
        encodeAbiParameters(
          [{ type: "string" }, { type: "uint256" }],
          ["agentbank.sim.genesis", BigInt(this.chainId)],
        ),
      ),
      parentHash: zeroHash,
      timestamp: startTimestamp,
      txs: [],
      logs: [],
      undo: this.journal.splice(0),
      dirtyHolders: [],
    };
    this.blocks.push(genesis);
    if (this.ownsClock) this.advanceInternalClock(this.blockTimeSeconds);
    this.gateway = new SimulatedGateway(this);
  }

  private required(address: Address | undefined, name: string): Address {
    if (!address) throw new Error(`SimulatedChain needs a ${name} address`);
    return getAddress(address);
  }

  // ------------------------------------------------------------------------------------------ time

  private advanceInternalClock(seconds: number): void {
    (this.clock as ManualClock).advance(seconds * 1000);
  }

  /** Current time of the chain's clock (unix seconds). */
  nowSeconds(): number {
    return unixSeconds(this.clock.now()) + this.timeOffset;
  }

  /** Timestamp the next block will have. */
  nextTimestamp(): number {
    return Math.max(this.head.timestamp + 1, this.nowSeconds());
  }

  /** Move time forward (affects the next block). Uses the shared clock's `advance` when available. */
  advanceTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("seconds must be >= 0");
    const clock = this.clock as Partial<ManualClock>;
    if (typeof clock.advance === "function") clock.advance(seconds * 1000);
    else this.timeOffset += seconds;
  }

  // ------------------------------------------------------------------------------------------ blocks

  get head(): BlockRef {
    return ref(this.blocks[this.blocks.length - 1] as SimBlock);
  }

  /** Resolve a block tag to a block number. */
  resolveTag(tag: BlockTag): bigint {
    const head = this.head.number;
    if (tag === "latest") return head;
    if (tag === "safe") return head > BigInt(this.safeDepth) ? head - BigInt(this.safeDepth) : 0n;
    if (tag === "finalized")
      return head > BigInt(this.finalityDepth) ? head - BigInt(this.finalityDepth) : 0n;
    return tag;
  }

  block(number: bigint): BlockRef | undefined {
    const b = this.blocks[Number(number)];
    return b ? ref(b) : undefined;
  }

  /** Number of transactions waiting for the next block. */
  get pendingCount(): number {
    return this.pool.length;
  }

  private hasCode(address: Address): boolean {
    const a = address.toLowerCase();
    if (this.accounts.get(address)) return true;
    const c = this.contracts;
    return [
      c.usdc,
      c.escrow,
      c.streams,
      c.vaults,
      c.policyHook,
      c.topUpExecutor,
      c.attestationRegistry,
      c.smartSessions,
      c.ownableValidator,
      c.entryPoint,
    ]
      .filter((x): x is Address => typeof x === "string")
      .some((x) => x.toLowerCase() === a);
  }

  private dispatch(ctx: ExecContext, from: Address, to: Address, value: bigint, data: Hex): Hex {
    if (value !== 0n) revert("simulator: native value transfers are not simulated");
    const t = to.toLowerCase();
    if (t === this.usdc.address.toLowerCase()) return this.usdc.handle(ctx, from, data);
    if (t === this.escrow.address.toLowerCase()) return this.escrow.handle(ctx, from, data);
    if (t === this.streams.address.toLowerCase()) return this.streams.handle(ctx, from, data);
    if (t === this.vaults.address.toLowerCase()) return this.vaults.handle(ctx, from, data);
    if (t === this.topUp.address.toLowerCase()) return this.topUp.handle(ctx, from, data);
    if (t === this.attestations.address.toLowerCase()) return this.attestations.handle(ctx, from, data);
    if (t === this.smartSessions.address.toLowerCase()) return this.smartSessions.handle(ctx, from, data);
    if (t === this.hook.address.toLowerCase()) return this.hook.handle(ctx, from, data);
    if (t === this.contracts.ownableValidator.toLowerCase())
      return this.accounts.ownableValidatorCall(ctx, from, data);
    if (this.accounts.get(to)) {
      if (isAddressEqual(from, to)) return this.accounts.selfCall(ctx, to, data);
      return this.accounts.execTransaction(ctx, from, to, data);
    }
    return revert(`simulator: no contract at ${getAddress(to)}`);
  }

  private nextTxHash(label: string, payload: Hex): Hex {
    this.txCounter += 1;
    return keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
        [label, BigInt(this.chainId), BigInt(this.txCounter), payload],
      ),
    );
  }

  private userOpTxHash(userOpHash: Hex): Hex {
    return keccak256(concatHex([stringToHex("agentbank.sim.bundle"), userOpHash]));
  }

  /** Execute one transaction in `ctx`; `included: false` means it is left out of the block. */
  private applyTx(
    ctx: ExecContext,
    tx: SimTx,
  ): {
    included: boolean;
    success: boolean;
    revertReason: string | null;
    actualGasCost: bigint | null;
    rejection?: OperationRejected;
    /** Logs of this transaction that belong in the user operation receipt: `[from, to)`. */
    receiptLogs?: [number, number];
  } {
    const intent = tx.intent;
    if (intent.kind === "userop") {
      const mark = this.journal.mark();
      try {
        this.entryPoint.validate(ctx, intent.userOp, intent.userOpHash);
      } catch (error) {
        this.journal.revertTo(mark);
        if (error instanceof OperationRejected)
          return {
            included: false,
            success: false,
            revertReason: error.reason,
            actualGasCost: null,
            rejection: error,
          };
        if (error instanceof SimRevert) {
          return {
            included: false,
            success: false,
            revertReason: error.reason,
            actualGasCost: null,
            rejection: new OperationRejected(error.reason, "invalid_request"),
          };
        }
        throw error;
      }
      const executionStart = ctx.logs.length;
      const outcome = this.entryPoint.execute(ctx, intent.userOp, intent.userOpHash);
      // Bundlers report the execution-phase logs, without the closing UserOperationEvent.
      return {
        included: true,
        success: outcome.success,
        revertReason: outcome.revertReason,
        actualGasCost: outcome.actualGasCost,
        receiptLogs: [executionStart, ctx.logs.length - 1],
      };
    }
    const mark = this.journal.mark();
    try {
      if (intent.kind === "faucet") this.usdc.mint(ctx, intent.to, intent.amount);
      else this.dispatch(ctx, intent.from, intent.to, 0n, intent.data);
      return { included: true, success: true, revertReason: null, actualGasCost: 0n };
    } catch (error) {
      if (!(error instanceof SimRevert)) throw error;
      this.journal.revertTo(mark);
      return { included: true, success: false, revertReason: error.reason, actualGasCost: 0n };
    }
  }

  private seal(txs: SimTx[], timestamp: number, salt: number): { block: SimBlock; dropped: SimTx[] } {
    const parent = this.blocks[this.blocks.length - 1] as SimBlock;
    const number = parent.number + 1n;
    const sealed: SealedTx[] = [];
    const drafts: { tx: SealedTx; logs: ExecContext["logs"] }[] = [];
    const dropped: SimTx[] = [];
    for (const tx of txs) {
      const ctx: ExecContext = {
        blockNumber: number,
        timestamp,
        txHash: tx.hash,
        logs: [],
        journal: this.journal,
      };
      const result = this.applyTx(ctx, tx);
      if (!result.included) {
        dropped.push(tx);
        continue;
      }
      const s: SealedTx = {
        ...tx,
        success: result.success,
        revertReason: result.revertReason,
        actualGasCost: result.actualGasCost,
        receiptLogs: result.receiptLogs ?? [0, ctx.logs.length],
      };
      sealed.push(s);
      drafts.push({ tx: s, logs: ctx.logs });
    }
    const hash = keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32[]" },
          { type: "uint256" },
        ],
        [
          BigInt(this.chainId),
          number,
          parent.hash,
          BigInt(timestamp),
          sealed.map((t) => t.hash),
          BigInt(salt),
        ],
      ),
    );
    const logs: RawLog[] = [];
    for (const d of drafts) {
      const base = logs.length;
      d.tx.receiptLogs = [base + d.tx.receiptLogs[0], base + d.tx.receiptLogs[1]];
      for (const l of d.logs) {
        logs.push({
          ...l,
          blockNumber: number,
          blockHash: hash,
          transactionHash: d.tx.hash,
          logIndex: logs.length,
        });
      }
    }
    const dirtyHolders = this.usdc.takeDirty();
    const block: SimBlock = {
      number,
      hash,
      parentHash: parent.hash,
      timestamp,
      txs: sealed,
      logs,
      undo: this.journal.splice(0),
      dirtyHolders,
    };
    this.blocks.push(block);
    for (const holder of dirtyHolders) {
      const k = holder.toLowerCase();
      const list = this.balanceHistory.get(k) ?? [];
      list.push({ block: number, value: this.usdc.balanceOf(holder) });
      this.balanceHistory.set(k, list);
    }
    for (const t of sealed) {
      if (t.intent.kind === "userop") {
        this.opBlock.set(t.intent.userOpHash.toLowerCase(), number);
        this.droppedOps.delete(t.intent.userOpHash.toLowerCase());
      }
    }
    for (const t of dropped)
      if (t.intent.kind === "userop") this.droppedOps.add(t.intent.userOpHash.toLowerCase());
    this.compact();
    return { block, dropped };
  }

  /** Drop undo logs of finalized blocks: they can never be reorged. */
  private compact(): void {
    const finalized = Number(this.resolveTag("finalized"));
    for (let i = this.compactedThrough + 1; i <= finalized; i++) (this.blocks[i] as SimBlock).undo = [];
    if (finalized > this.compactedThrough) this.compactedThrough = finalized;
  }

  /** Mine `count` blocks; pending transactions go into the first. */
  mine(count = 1): BlockRef[] {
    if (!Number.isInteger(count) || count < 1) throw new RangeError("count must be a positive integer");
    const out: BlockRef[] = [];
    for (let i = 0; i < count; i++) {
      const txs = this.pool;
      this.pool = [];
      const { block } = this.seal(txs, this.nextTimestamp(), this.reorgCount);
      out.push(ref(block));
      if (this.ownsClock) this.advanceInternalClock(this.blockTimeSeconds);
    }
    return out;
  }

  private enqueue(tx: SimTx): Hex {
    this.pool.push(tx);
    if (this.automine) this.mine();
    return tx.hash;
  }

  /** Dry-run a transaction against the current state (nothing persists). */
  private dryRun(tx: SimTx): ReturnType<SimulatedChain["applyTx"]> {
    const mark = this.journal.mark();
    const ctx: ExecContext = {
      blockNumber: this.head.number + 1n,
      timestamp: this.nextTimestamp(),
      txHash: tx.hash,
      logs: [],
      journal: this.journal,
    };
    try {
      return this.applyTx(ctx, tx);
    } finally {
      this.journal.revertTo(mark);
      this.usdc.takeDirty();
    }
  }

  /**
   * Replace the last `depth` blocks. Their transactions are re-executed in the replacement blocks
   * (same slots, reversed or shuffled), minus dropped ones; user operations that became invalid are
   * dropped too. Blocks at or below `finalized` can never be replaced.
   */
  injectReorg(depth: number, options: ReorgOptions = {}): ReorgResult {
    const head = this.head.number;
    const finalized = this.resolveTag("finalized");
    if (!Number.isInteger(depth) || depth < 1) throw new RangeError("depth must be a positive integer");
    if (BigInt(depth) > head - finalized || BigInt(depth) > head) {
      throw new AgentBankError(
        "invalid_state",
        `cannot reorg ${depth} blocks: only ${head - finalized} are above finalized`,
      );
    }
    const replaced = this.blocks.splice(this.blocks.length - depth);
    for (let i = replaced.length - 1; i >= 0; i--) undoAll((replaced[i] as SimBlock).undo);
    const firstRemoved = (replaced[0] as SimBlock).number;
    for (const b of replaced) {
      for (const holder of b.dirtyHolders) {
        const list = this.balanceHistory.get(holder.toLowerCase());
        while (list && list.length > 0 && (list[list.length - 1] as { block: bigint }).block >= firstRemoved)
          list.pop();
      }
      for (const t of b.txs)
        if (t.intent.kind === "userop") this.opBlock.delete(t.intent.userOpHash.toLowerCase());
    }
    this.reorgCount += 1;

    const dropSet = options.drop === "all" ? null : new Set((options.drop ?? []).map((h) => h.toLowerCase()));
    const isDropped = (t: SimTx) => (dropSet === null ? true : dropSet.has(t.hash.toLowerCase()));
    const slots = replaced.map((b) =>
      b.txs.filter((t) => !isDropped(t)).map((t) => ({ hash: t.hash, intent: t.intent })),
    );
    const explicitlyDropped = replaced.flatMap((b) =>
      b.txs.filter(isDropped).map((t) => ({ hash: t.hash, intent: t.intent })),
    );
    const newCount = options.blocks ?? depth;
    if (!Number.isInteger(newCount) || newCount < 1)
      throw new RangeError("blocks must be a positive integer");

    let plan: SimTx[][];
    const order = options.order ?? "same";
    if (order === "same" && newCount === depth) {
      plan = slots;
    } else {
      const flat = slots.flat();
      if (order === "reverse") flat.reverse();
      if (order === "shuffle") {
        const rand = mulberry32(options.seed ?? 1);
        for (let i = flat.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [flat[i], flat[j]] = [flat[j] as SimTx, flat[i] as SimTx];
        }
      }
      plan = Array.from({ length: newCount }, () => [] as SimTx[]);
      const sizes = order === "same" || newCount !== depth ? null : slots.map((s) => s.length);
      let cursor = 0;
      for (let i = 0; i < newCount; i++) {
        const take = sizes ? (sizes[i] ?? 0) : Math.ceil((flat.length - cursor) / (newCount - i));
        plan[i] = flat.slice(cursor, cursor + take);
        cursor += take;
      }
    }

    const added: BlockRef[] = [];
    const invalidated: SimTx[] = [];
    for (let i = 0; i < newCount; i++) {
      const parent = this.blocks[this.blocks.length - 1] as SimBlock;
      const timestamp = Math.max(
        parent.timestamp + 1,
        (replaced[i] as SimBlock | undefined)?.timestamp ?? parent.timestamp + this.blockTimeSeconds,
      );
      const { block, dropped } = this.seal(plan[i] ?? [], timestamp, this.reorgCount);
      invalidated.push(...dropped);
      added.push(ref(block));
    }
    for (const t of explicitlyDropped)
      if (t.intent.kind === "userop") this.droppedOps.add(t.intent.userOpHash.toLowerCase());
    if (options.requeue) this.pool = [...explicitlyDropped, ...this.pool];
    return {
      removed: replaced.map(ref),
      added,
      dropped: [...explicitlyDropped, ...invalidated].map((t) => t.hash),
    };
  }

  // ------------------------------------------------------------------------------------------ test helpers

  /** Mint test USDC to `address` (a `Transfer` from the zero address). Returns the tx hash. */
  faucet(address: Address, amount: bigint): Hex {
    if (amount <= 0n) throw new RangeError("amount must be positive");
    const to = getAddress(address);
    return this.enqueue({
      hash: this.nextTxHash(
        "faucet",
        encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, amount]),
      ),
      intent: { kind: "faucet", to, amount },
    });
  }

  /**
   * Send a raw transaction from `from` without a signature (tests: external transfers, keeper calls,
   * the owner's Safe-native `execTransaction`, which carries its own Safe owner signatures). Included
   * even if it reverts.
   */
  sendTransaction(input: { from: Address; to: Address; data: Hex }): Hex {
    const intent = {
      kind: "call" as const,
      from: getAddress(input.from),
      to: getAddress(input.to),
      data: input.data,
    };
    return this.enqueue({
      hash: this.nextTxHash("call", concatHex([intent.from, intent.to, intent.data])),
      intent,
    });
  }

  /** Receipt-like view of a transaction (any kind). */
  transaction(
    hash: Hex,
  ): { blockNumber: bigint; success: boolean; revertReason: string | null; logs: ChainLog[] } | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i] as SimBlock;
      const t = b.txs.find((x) => x.hash.toLowerCase() === hash.toLowerCase());
      if (t) {
        const logs = b.logs
          .filter((l) => l.transactionHash === t.hash)
          .map((l) => normalizeLog(l, this.chainId, this.contracts))
          .filter((l): l is ChainLog => l !== null);
        return { blockNumber: b.number, success: t.success, revertReason: t.revertReason, logs };
      }
    }
    return undefined;
  }

  /** Record an ERC-8004 validation response for `releaseByValidation` (stand-in for the registry). */
  setValidationStatus(
    requestHash: Hex,
    status: { validator: Address; response: number; lastUpdate?: bigint },
  ): void {
    this.escrow.validations.set(requestHash.toLowerCase(), {
      validator: getAddress(status.validator),
      response: status.response,
      lastUpdate: status.lastUpdate ?? BigInt(this.nextTimestamp()),
    });
    this.journal.splice(0); // test fixture: not part of any block
  }

  /** Attest a module in the simulated ERC-7484 registry. */
  attestModule(attester: Address, module: Address): void {
    this.accounts.attestations.set(`${attester.toLowerCase()}:${module.toLowerCase()}`, true);
    this.journal.splice(0);
  }

  /** Register a counterfactual deployment (the gateway does this in `predictAccountAddress`). */
  registerDeployment(deployment: AccountDeployment): Address {
    const address = predictAccountAddress(deployment, this.contracts);
    this.deployments.set(address.toLowerCase(), {
      owner: getAddress(deployment.owner),
      cosigner: getAddress(deployment.cosigner),
      salt: deployment.salt,
    });
    return address;
  }

  /** Inspect an account. */
  account(address: Address): (SimAccountRecord & { sessions: SimSession[] }) | undefined {
    const record = this.accounts.get(address);
    return record ? { ...record, sessions: this.smartSessions.list(address) } : undefined;
  }

  balanceOf(holder: Address, token: Address = this.contracts.usdc): bigint {
    return this.world.balanceOf(token, holder);
  }

  getEscrow(id: bigint): SimEscrowRecord | undefined {
    return this.escrow.get(id);
  }

  getStream(id: bigint): SimStreamRecord | undefined {
    return this.streams.get(id);
  }

  getVault(id: bigint): SimVaultRecord | undefined {
    return this.vaults.get(id);
  }

  // ------------------------------------------------------------------------------------------ internals for the gateway

  /** @internal */
  _deployment(address: Address): AccountDeployment | undefined {
    return this.deployments.get(address.toLowerCase());
  }

  /** @internal */
  _nonce(sender: Address, nonceKey: bigint): bigint {
    return this.entryPoint.getNonce(sender, nonceKey);
  }

  /** @internal */
  _balanceAt(token: Address, holder: Address, blockNumber: bigint): bigint {
    if (!isAddressEqual(token, this.contracts.usdc)) return 0n;
    if (blockNumber > this.head.number)
      throw new AgentBankError("invalid_request", `block ${blockNumber} is in the future`);
    if (blockNumber === this.head.number) return this.usdc.balanceOf(holder);
    const list = this.balanceHistory.get(holder.toLowerCase()) ?? [];
    let value = 0n;
    for (const entry of list) {
      if (entry.block > blockNumber) break;
      value = entry.value;
    }
    return value;
  }

  /**
   * @internal Gas-estimation dry run, like a bundler's `eth_estimateUserOperationGas`: validation
   * (signature failures tolerated) and execution in a sandbox. Policy violations and execution
   * reverts throw, so they surface when an operation is prepared.
   */
  _estimate(userOp: UserOperationV07, userOpHash: Hex): void {
    const mark = this.journal.mark();
    const ctx: ExecContext = {
      blockNumber: this.head.number + 1n,
      timestamp: this.nextTimestamp(),
      txHash: zeroHash,
      logs: [],
      journal: this.journal,
    };
    try {
      try {
        this.entryPoint.validate(ctx, userOp, userOpHash, { estimate: true });
      } catch (error) {
        if (error instanceof OperationRejected) {
          throw new AgentBankError(error.code, `Operation rejected: ${error.reason}`, {
            reason: error.reason,
          });
        }
        if (error instanceof SimRevert)
          throw new AgentBankError("invalid_request", `Operation rejected: ${error.reason}`, {
            reason: error.reason,
          });
        throw error;
      }
      const outcome = this.entryPoint.execute(ctx, userOp, userOpHash);
      if (!outcome.success) {
        throw new AgentBankError("invalid_state", `Operation would revert: ${outcome.revertReason}`, {
          revertReason: outcome.revertReason,
        });
      }
    } finally {
      this.journal.revertTo(mark);
      this.usdc.takeDirty();
    }
  }

  /** @internal Submit a user operation (dry-run first; rejections throw). */
  _submitUserOp(userOp: UserOperationV07, userOpHash: Hex): Hex {
    const k = userOpHash.toLowerCase();
    if (
      this.opBlock.has(k) ||
      this.pool.some((t) => t.intent.kind === "userop" && t.intent.userOpHash.toLowerCase() === k)
    ) {
      return userOpHash;
    }
    const tx: SimTx = { hash: this.userOpTxHash(userOpHash), intent: { kind: "userop", userOp, userOpHash } };
    const result = this.dryRun(tx);
    if (!result.included) {
      const r = result.rejection as OperationRejected;
      throw new AgentBankError(r.code, `Operation rejected: ${r.reason}`, { reason: r.reason });
    }
    this.droppedOps.delete(k);
    this.enqueue(tx);
    return userOpHash;
  }

  /** @internal Send an EOA call from a bank key (dry-run first; reverts throw), e.g. a relay or the attester. */
  _relay(from: Address, to: Address, data: Hex, label = "relay"): Hex {
    const tx: SimTx = {
      hash: this.nextTxHash(label, concatHex([from, to, data])),
      intent: { kind: "call", from, to, data },
    };
    const result = this.dryRun(tx);
    if (!result.success) {
      throw new AgentBankError("invalid_state", `Transaction would revert: ${result.revertReason}`, {
        revertReason: result.revertReason,
      });
    }
    return this.enqueue(tx);
  }

  /** @internal */
  _receipt(userOpHash: Hex): OperationReceipt {
    const k = userOpHash.toLowerCase();
    const empty = {
      userOpHash,
      txHash: null,
      blockNumber: null,
      blockHash: null,
      revertReason: null,
      actualGasCost: null,
      logs: [],
    };
    const number = this.opBlock.get(k);
    if (number === undefined) {
      if (this.pool.some((t) => t.intent.kind === "userop" && t.intent.userOpHash.toLowerCase() === k)) {
        return { ...empty, status: "pending" };
      }
      return { ...empty, status: "not_found" };
    }
    const b = this.blocks[Number(number)] as SimBlock;
    const t = b.txs.find(
      (x) => x.intent.kind === "userop" && x.intent.userOpHash.toLowerCase() === k,
    ) as SealedTx;
    const logs = b.logs
      .slice(t.receiptLogs[0], t.receiptLogs[1])
      .map((l) => normalizeLog(l, this.chainId, this.contracts))
      .filter((l): l is ChainLog => l !== null);
    return {
      userOpHash,
      status: t.success ? "succeeded" : "reverted",
      txHash: t.hash,
      blockNumber: b.number,
      blockHash: b.hash,
      revertReason: t.revertReason,
      actualGasCost: t.actualGasCost,
      logs,
    };
  }

  /** @internal */
  _logs(query: LogQuery): ChainLog[] {
    const head = this.head.number;
    const to = query.toBlock > head ? head : query.toBlock;
    const addresses = query.addresses ? new Set(query.addresses.map((a) => a.toLowerCase())) : null;
    const events = query.events ? new Set<string>(query.events) : null;
    const involving = query.involving ? new Set(query.involving.map((a) => a.toLowerCase())) : null;
    const out: ChainLog[] = [];
    for (let n = query.fromBlock; n <= to; n++) {
      const b = this.blocks[Number(n)];
      if (!b) continue;
      for (const raw of b.logs) {
        if (addresses && !addresses.has(raw.address.toLowerCase())) continue;
        const log = normalizeLog(raw, this.chainId, this.contracts);
        if (!log) continue;
        if (events && !events.has(log.eventName)) continue;
        if (involving && !logInvolves(log, involving)) continue;
        out.push(log);
      }
    }
    return sortLogs(out);
  }

  /** @internal ERC-1271 / ERC-6492 / ECDSA verification. */
  _verifySignature(address: Address, hash: Hex, signature: Hex): boolean {
    const record = this.accounts.get(address);
    if (signature.toLowerCase().endsWith(ERC6492_SUFFIX)) {
      const [factory, factoryData, inner] = decodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
        slice(signature, 0, size(signature) - 32),
      );
      if (record) return this.accounts.isValidSignature(record, hash, inner);
      const deployment = this._deployment(address);
      if (!deployment) return false;
      const expected = accountFactoryArgs(deployment, this.contracts);
      if (
        !isAddressEqual(factory, expected.factory) ||
        factoryData.toLowerCase() !== expected.factoryData.toLowerCase()
      )
        return false;
      return this.accounts.isValidSignature(this.virtualAccount(address, deployment), hash, inner);
    }
    if (record) return this.accounts.isValidSignature(record, hash, signature);
    if (this.hasCode(address)) return false;
    const parts = splitSignature(signature);
    if (!parts) return false;
    const v = parts.v < 27 ? parts.v + 27 : parts.v;
    const signer = ecrecover(hash, v, parts.r, parts.s);
    return signer !== null && isAddressEqual(signer, address);
  }

  private virtualAccount(address: Address, deployment: AccountDeployment): SimAccountRecord {
    return {
      address: getAddress(address),
      deployment,
      stage: "ready",
      safeOwners: [getAddress(deployment.owner)],
      safeThreshold: 1,
      safeNonce: 0n,
      validators: [getAddress(this.contracts.ownableValidator), getAddress(this.contracts.smartSessions)],
      ownerValidator: { threshold: 1, owners: [getAddress(deployment.owner)] },
      registry: getAddress("0x0000000000000000000000000000000000000000"),
      attesters: [],
      attestersThreshold: 0,
      globalHook: getAddress("0x0000000000000000000000000000000000000000"),
      executors: [],
    };
  }
}

const NOMINAL_GAS = {
  callGasLimit: 500_000n,
  verificationGasLimit: 600_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
};

/** {@link ChainGateway} over a {@link SimulatedChain}. */
class SimulatedGateway implements ChainGateway {
  readonly chainId: number;
  readonly contracts: ChainContracts;

  constructor(private readonly chain: SimulatedChain) {
    this.chainId = chain.chainId;
    this.contracts = chain.contracts;
  }

  async predictAccountAddress(input: AccountDeployment): Promise<Address> {
    return this.chain.registerDeployment(input);
  }

  async isDeployed(address: Address): Promise<boolean> {
    return this.chain.accounts.get(address) !== undefined;
  }

  async getTokenBalance(token: Address, holder: Address, blockNumber?: bigint): Promise<bigint> {
    return this.chain._balanceAt(token, holder, blockNumber ?? this.chain.head.number);
  }

  async isSessionEnabled(account: Address, permissionId: Hex): Promise<boolean> {
    return this.chain.smartSessions.get(account, permissionId) !== undefined;
  }

  private sponsorFields() {
    return this.chain.sponsor
      ? {
          paymaster: SIMULATED_PAYMASTER,
          paymasterVerificationGasLimit: 100_000n,
          paymasterPostOpGasLimit: 50_000n,
          paymasterData: "0x" as Hex,
        }
      : {};
  }

  private finish(
    userOp: UserOperationV07,
    signer: "session" | "owner",
    permissionId: Hex | null,
    validUntil: number,
  ): PreparedOperation {
    const json = userOperationToJson(userOp);
    const userOpHash = hashUserOperation(json, this.chainId, this.contracts.entryPoint);
    this.chain._estimate(
      {
        ...userOp,
        signature: signer === "session" ? stubSessionSignature(permissionId as Hex) : stubOwnerSignature(),
      },
      userOpHash,
    );
    return {
      chainId: this.chainId,
      entryPoint: getAddress(this.contracts.entryPoint),
      account: getAddress(userOp.sender),
      signer,
      permissionId,
      userOp: json,
      userOpHash,
      calls: decodeCalls(userOp.callData, { contracts: this.contracts, account: userOp.sender }),
      validUntil,
    };
  }

  async prepareOperation(input: PrepareOperationInput): Promise<PreparedOperation> {
    assertTestnet(this.chainId);
    const account = getAddress(input.account);
    const record = this.chain.accounts.get(account);
    if (!record || record.stage !== "ready")
      throw new AgentBankError("invalid_state", `Account ${account} is not deployed`);
    if (!this.chain.smartSessions.get(account, input.session.permissionId)) {
      throw new AgentBankError(
        "session_revoked",
        `Session ${input.session.permissionId} is not enabled on ${account}`,
      );
    }
    if (input.calls.length === 0)
      throw new AgentBankError("invalid_request", "at least one call is required");
    const userOp: UserOperationV07 = {
      sender: account,
      nonce: this.chain._nonce(account, validatorNonceKey(this.contracts.smartSessions)),
      callData: encodeExecute(input.calls),
      ...NOMINAL_GAS,
      ...this.sponsorFields(),
      signature: "0x",
    };
    return this.finish(
      userOp,
      "session",
      input.session.permissionId,
      input.validUntil ?? this.chain.nowSeconds() + DEFAULT_SESSION_OP_TTL_SECONDS,
    );
  }

  async prepareOwnerOperation(input: PrepareOwnerOperationInput): Promise<PreparedOperation> {
    assertTestnet(this.chainId);
    const account = getAddress(input.account);
    if (input.calls.length === 0)
      throw new AgentBankError("invalid_request", "at least one call is required");
    const record = this.chain.accounts.get(account);
    const execute = encodeExecute(input.calls);
    let userOp: UserOperationV07;
    if (record) {
      if (record.stage !== "ready")
        throw new AgentBankError("invalid_state", `Account ${account} setup reverted; it cannot be used`);
      userOp = {
        sender: account,
        nonce: this.chain._nonce(account, validatorNonceKey(this.contracts.ownableValidator)),
        callData: execute,
        ...NOMINAL_GAS,
        ...this.sponsorFields(),
        signature: "0x",
      };
    } else {
      const deployment = input.deployment ?? this.chain._deployment(account);
      if (!deployment)
        throw new AgentBankError("invalid_request", "deployment is required for an undeployed account");
      if (!isAddressEqual(this.chain.registerDeployment(deployment), account)) {
        throw new AgentBankError("invalid_request", "deployment does not predict to the account address");
      }
      const { factory, factoryData } = accountFactoryArgs(deployment, this.contracts);
      userOp = {
        sender: account,
        nonce: this.chain._nonce(account, validatorNonceKey(this.contracts.ownableValidator)),
        factory,
        factoryData,
        callData: wrapSetupSafe(deployment, this.contracts, execute),
        ...NOMINAL_GAS,
        ...this.sponsorFields(),
        signature: "0x",
      };
    }
    return this.finish(
      userOp,
      "owner",
      null,
      input.validUntil ?? this.chain.nowSeconds() + DEFAULT_OWNER_OP_TTL_SECONDS,
    );
  }

  decodeOperation(op: PreparedOperation): DecodedCall[] {
    checkPreparedOperation(op, this);
    return decodePreparedOperation(op, this.contracts);
  }

  hashOperation(op: PreparedOperation): Hex {
    return hashUserOperation(checkPreparedOperation(op, this), this.chainId, this.contracts.entryPoint);
  }

  async submitOperation(input: SubmitOperationInput): Promise<{ userOpHash: Hex }> {
    const userOp = checkPreparedOperation(input.op, this);
    const now = this.chain.nextTimestamp();
    if (now > input.op.validUntil) {
      throw new AgentBankError(
        "invalid_state",
        `Operation signing deadline passed (${input.op.validUntil} < ${now})`,
      );
    }
    const userOpHash = hashUserOperation(userOp, this.chainId, this.contracts.entryPoint);
    return { userOpHash: this.chain._submitUserOp({ ...userOp, signature: input.signature }, userOpHash) };
  }

  async getOperationReceipt(userOpHash: Hex): Promise<OperationReceipt> {
    return this.chain._receipt(userOpHash);
  }

  async getBlock(tag: BlockTag): Promise<BlockRef> {
    const number = this.chain.resolveTag(tag);
    const block = this.chain.block(number);
    if (!block) throw new AgentBankError("not_found", `Block ${number} not found`);
    return block;
  }

  async getLogs(input: LogQuery): Promise<ChainLog[]> {
    if (input.fromBlock > input.toBlock)
      throw new AgentBankError("invalid_request", "fromBlock must be <= toBlock");
    return this.chain._logs(input);
  }

  async settleAuthorization(input: SettleAuthorizationInput): Promise<{ txHash: Hex }> {
    if (!isAddressEqual(input.token, this.contracts.usdc))
      throw new AgentBankError("unsupported_asset", "Only USDC is supported");
    const args = [
      input.from,
      input.to,
      input.value,
      input.validAfter,
      input.validBefore,
      input.nonce,
    ] as const;
    const parts = size(input.signature) === 65 ? splitSignature(input.signature) : null;
    const data = parts
      ? encodeFunctionData({
          abi: erc20Abi,
          functionName: "transferWithAuthorization",
          args: [...args, parts.v, toHex(parts.r, { size: 32 }), toHex(parts.s, { size: 32 })],
        })
      : encodeFunctionData({
          abi: erc20Abi,
          functionName: "transferWithAuthorization",
          args: [...args, input.signature],
        });
    const from = input.relayer?.address ?? SIMULATED_RELAYER;
    return { txHash: this.chain._relay(getAddress(from), this.contracts.usdc, data) };
  }

  async relayCall(input: RelayCallInput): Promise<{ txHash: Hex }> {
    assertRelayableCall(input.call, this.contracts);
    const from = input.relayer?.address ?? SIMULATED_RELAYER;
    return { txHash: this.chain._relay(getAddress(from), getAddress(input.call.to), input.call.data) };
  }

  async publishAttestationRoot(input: PublishAttestationRootInput): Promise<{ txHash: Hex }> {
    assertTestnet(this.chainId);
    const { root, epoch, snapshotAt, validUntil, leafCount } = input;
    const call = publishAttestationRootCall({
      registry: this.chain.attestations.address,
      root,
      epoch,
      snapshotAt,
      validUntil,
      leafCount,
    });
    return {
      txHash: this.chain._relay(getAddress(input.attester.address), call.to, call.data, "attester"),
    };
  }

  async revokeAttestationRoots(input: RevokeAttestationRootsInput): Promise<{ txHash: Hex }> {
    assertTestnet(this.chainId);
    const call = revokeAttestationRootsCall({
      registry: this.chain.attestations.address,
      roots: input.roots,
    });
    return {
      txHash: this.chain._relay(getAddress(input.attester.address), call.to, call.data, "attester"),
    };
  }

  async getAttestationRoot(root: Hex): Promise<AttestationRootInfo | null> {
    const r = parseAttestationRoot(root);
    const registry = this.chain.attestations;
    return toAttestationRootInfo(registry.rootInfo(r), registry.isValidRoot(r, this.chain.head.timestamp));
  }

  async getTransactionReceipt(hash: Hex): Promise<TransactionReceiptInfo | null> {
    const tx = this.chain.transaction(hash);
    return tx ? { status: tx.success ? "success" : "reverted", blockNumber: tx.blockNumber } : null;
  }

  async authorizationState(token: Address, authorizer: Address, nonce: Hex): Promise<boolean> {
    if (!isAddressEqual(token, this.contracts.usdc)) return false;
    return this.chain.usdc.authorizationState(authorizer, nonce);
  }

  async erc20Nonces(token: Address, owner: Address): Promise<bigint> {
    if (!isAddressEqual(token, this.contracts.usdc)) return 0n;
    return this.chain.usdc.nonces(owner);
  }

  async verifySignature(input: { address: Address; hash: Hex; signature: Hex }): Promise<boolean> {
    return this.chain._verifySignature(getAddress(input.address), input.hash, input.signature);
  }
}
