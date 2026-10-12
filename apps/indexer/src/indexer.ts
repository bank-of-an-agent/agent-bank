import type { BlockRef, ChainGateway, ChainLog } from "@agentbank/chain";
import {
  AgentBankError,
  newId,
  systemClock,
  type ChainEventInternal,
  type Clock,
  type IngestResult,
  type WatchlistResponse,
} from "@agentbank/core";
import { getAddress } from "viem";
import { IndexerMetrics } from "./metrics";
import { batchByTransaction, normalizeLogs, txKeyOf, type BlockInfo } from "./normalize";
import type { IndexerStore, StoredBlock } from "./store";
import type { ReconcilerTransport } from "./transport";

/**
 * The indexer loop (ADR 0011): poll the chain through `ChainGateway`, check every new block's
 * parent hash against the blocks it stored, push the logs that matter to the reconciler and
 * move its cursor only once the reconciler accepted them.
 *
 * Reorgs: on a parent-hash mismatch it walks back to the common ancestor, rewinds, and pushes
 * the replacement blocks first; the orphaned block hashes are reported (`/chain-events/reorg`)
 * once the cursor is back at the old tip, so the reconciler rebinds re-included transactions
 * instead of reversing and re-posting them, and reverses only what really disappeared.
 *
 * Deferred events (inside the 20-block window, or large and not yet final) are kept in the
 * indexer's database and resent when finality or the window is reached (or every window).
 */

export interface IndexerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface IndexerOptions {
  chain: ChainGateway;
  transport: ReconcilerTransport;
  store: IndexerStore;
  /**
   * `RECONCILIATION_WINDOW` (default 20). Deferred events are resent when they become final, when
   * the window has passed, and every window/4 blocks in between.
   */
  windowBlocks?: number;
  /** Blocks processed per tick (default 500). */
  maxBlocksPerTick?: number;
  /** Events per ingest request (default 2,000; at most 5,000; transactions are never split). */
  batchEvents?: number;
  /** Block headers kept for reorg detection (default 256). */
  reorgHistory?: number;
  /** How often the watchlist is refreshed (default 30 s). */
  watchlistRefreshMs?: number;
  /** First block to index when the database is empty (default: the current head). */
  startBlock?: bigint;
  /** Shared contracts may hold other users' funds: compare `at_least` (default) or `exact`. */
  balanceCheckContracts?: "exact" | "at_least";
  /** UTC hour of the nightly balance check (default 3). */
  balanceCheckHourUtc?: number;
  clock?: Clock;
  logger?: IndexerLogger;
  metrics?: IndexerMetrics;
}

interface Watch {
  version: string;
  usdc: `0x${string}`;
  addresses: `0x${string}`[];
  lower: Set<string>;
  accounts: `0x${string}`[];
  contracts: `0x${string}`[];
  kinds: Map<string, WatchlistResponse["addresses"][number]["kind"]>;
  fetchedAt: number;
}

export interface TickResult {
  head: bigint;
  finalized: bigint;
  from: bigint | null;
  to: bigint | null;
  /** Events pushed (new and resent). */
  pushed: number;
  deferred: number;
  suspense: number;
  reorg: { ancestor: bigint; orphaned: number } | null;
  reorgReported: number;
  /** The cursor reached the head. */
  caughtUp: boolean;
}

export interface BalanceCheckResult {
  blockNumber: bigint;
  checked: number;
  mismatches: { address: string; onchain: string; expected: string }[];
  report: unknown;
}

const CONTRACT_KINDS = new Set([
  "escrow_contract",
  "streams_contract",
  "vaults_contract",
  "topup_executor",
  "sweep_executor",
]);
const SHARED_CONTRACTS = new Set(["escrow_contract", "streams_contract", "vaults_contract"]);

const silent: IndexerLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class Indexer {
  readonly metrics: IndexerMetrics;
  private readonly chain: ChainGateway;
  private readonly transport: ReconcilerTransport;
  private readonly store: IndexerStore;
  private readonly clock: Clock;
  private readonly logger: IndexerLogger;
  private readonly window: bigint;
  private readonly maxBlocks: bigint;
  private readonly batchEvents: number;
  private readonly history: bigint;
  private readonly resendEvery: bigint;
  private watch: Watch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private tickInFlight: Promise<unknown> | null = null;
  /** Single writer: the cursor, deferred set and pending reorg are mirrored in memory. */
  private cursorCache: { number: bigint; hash: string } | null | undefined = undefined;
  private deferredIds: Set<string> | null = null;
  private reorgPending: boolean | null = null;
  /** Last successful tick (for /healthz). */
  lastTick: { at: Date; result: TickResult } | null = null;
  lastError: { at: Date; message: string } | null = null;

  constructor(private readonly options: IndexerOptions) {
    this.chain = options.chain;
    this.transport = options.transport;
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silent;
    this.metrics = options.metrics ?? new IndexerMetrics();
    this.window = BigInt(options.windowBlocks ?? 20);
    this.maxBlocks = BigInt(options.maxBlocksPerTick ?? 500);
    this.batchEvents = Math.min(5_000, Math.max(1, options.batchEvents ?? 2_000));
    this.history = BigInt(Math.max(options.reorgHistory ?? 256, Number(this.window) + 8));
    this.resendEvery = this.window / 4n > 0n ? this.window / 4n : 1n;
  }

  get chainId(): number {
    return this.store.chainId;
  }

  private async cursor(): Promise<{ number: bigint; hash: string } | null> {
    if (this.cursorCache === undefined) this.cursorCache = await this.store.cursor();
    return this.cursorCache;
  }

  private async deferredSet(): Promise<Set<string>> {
    if (!this.deferredIds) this.deferredIds = new Set((await this.store.deferred()).map((d) => d.event.id));
    return this.deferredIds;
  }

  private async hasPendingReorg(): Promise<boolean> {
    if (this.reorgPending === null) this.reorgPending = (await this.store.pendingReorg()).length > 0;
    return this.reorgPending;
  }

  /** Forget cached watchlist state (e.g. right after accounts were created). */
  invalidateWatchlist(): void {
    if (this.watch) this.watch.fetchedAt = Number.NEGATIVE_INFINITY;
  }

  // ---------------------------------------------------------------- watchlist

  private async refreshWatchlist(force = false): Promise<Watch> {
    const now = this.clock.now().getTime();
    if (this.watch && !force && now - this.watch.fetchedAt < (this.options.watchlistRefreshMs ?? 30_000)) {
      return this.watch;
    }
    const list = await this.transport.watchlist();
    if (list.chain_id !== this.chainId) {
      throw new AgentBankError(
        "unsupported_chain",
        `The API reconciles chain ${list.chain_id}, the indexer follows ${this.chainId}`,
      );
    }
    const previous = this.watch;
    const addresses = [...new Set(list.addresses.map((a) => getAddress(a.address)))];
    const watch: Watch = {
      version: list.version,
      usdc: getAddress(list.usdc),
      addresses,
      lower: new Set(addresses.map((a) => a.toLowerCase())),
      accounts: list.addresses
        .filter((a) => a.kind === "account" || a.kind === "treasury" || a.kind === "spend_key")
        .map((a) => getAddress(a.address)),
      contracts: [
        ...new Set(
          list.addresses.filter((a) => CONTRACT_KINDS.has(a.kind)).map((a) => getAddress(a.address)),
        ),
      ],
      kinds: new Map(list.addresses.map((a) => [a.address.toLowerCase(), a.kind])),
      fetchedAt: now,
    };
    this.watch = watch;
    if (previous && previous.version !== watch.version) {
      const added = list.addresses.filter((a) => !previous.lower.has(a.address.toLowerCase()));
      if (added.length > 0) await this.backfill(added, previous);
    }
    return watch;
  }

  /**
   * Addresses added since the last refresh may have received funds in blocks already indexed
   * (counterfactual accounts can be paid before they are registered): re-read their logs.
   */
  private async backfill(added: WatchlistResponse["addresses"], previous: Watch): Promise<void> {
    const cursor = await this.cursor();
    if (!cursor) return;
    const lowest = (await this.store.lowestBlock()) ?? cursor.number;
    const since = added.reduce<bigint>((min, a) => {
      const from = a.since_block !== null ? BigInt(a.since_block) : cursor.number - this.history;
      return from < min ? from : min;
    }, cursor.number);
    const from = since > lowest ? since : lowest;
    if (from > cursor.number) return;
    const addresses = added.map((a) => getAddress(a.address));
    const usdc = previous.usdc;
    const [transfers, auths, ops] = await Promise.all([
      this.chain.getLogs({
        fromBlock: from,
        toBlock: cursor.number,
        addresses: [usdc],
        events: ["Transfer"],
        involving: addresses,
      }),
      this.chain.getLogs({
        fromBlock: from,
        toBlock: cursor.number,
        addresses: [usdc],
        events: ["AuthorizationUsed"],
        involving: addresses,
      }),
      this.chain.getLogs({
        fromBlock: from,
        toBlock: cursor.number,
        events: ["UserOperationEvent"],
        involving: addresses,
      }),
    ]);
    const logs = [...transfers, ...auths, ...ops];
    if (logs.length === 0) return;
    this.logger.info(
      { addresses: addresses.length, from: from.toString(), logs: logs.length },
      "backfilling new watched addresses",
    );
    await this.pushLogs(logs, await this.headers(logs), await this.tags());
  }

  // ---------------------------------------------------------------- loop

  /** Start polling every `intervalMs` until {@link stop}. */
  start(intervalMs: number): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      let caughtUp = true;
      try {
        const result = await this.track(this.tick());
        caughtUp = result.caughtUp;
        await this.track(this.maybeNightlyCheck());
      } catch (error) {
        this.lastError = { at: this.clock.now(), message: String((error as Error)?.message ?? error) };
        this.metrics.inc("indexer_tick_errors_total");
        this.logger.error({ err: this.lastError.message }, "indexer tick failed");
      }
      if (!this.stopped) this.timer = setTimeout(() => void loop(), caughtUp ? intervalMs : 0);
    };
    void loop();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.tickInFlight = promise;
    return promise.finally(() => {
      if (this.tickInFlight === promise) this.tickInFlight = null;
    });
  }

  /** Stop polling and wait for the tick in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.tickInFlight?.catch(() => undefined);
  }

  private async tags(): Promise<{ head: BlockRef; safe: BlockRef; finalized: BlockRef }> {
    const [head, safe, finalized] = await Promise.all([
      this.chain.getBlock("latest"),
      this.chain.getBlock("safe"),
      this.chain.getBlock("finalized"),
    ]);
    return { head, safe, finalized };
  }

  /** Process up to `maxBlocksPerTick` new blocks (and due deferred events, and a pending reorg). */
  async tick(): Promise<TickResult> {
    await this.refreshWatchlist();
    const tags = await this.tags();
    const { head, finalized } = tags;
    const result: TickResult = {
      head: head.number,
      finalized: finalized.number,
      from: null,
      to: null,
      pushed: 0,
      deferred: 0,
      suspense: 0,
      reorg: null,
      reorgReported: 0,
      caughtUp: false,
    };

    let cursor = await this.cursor();
    if (cursor) {
      const atCursor = cursor.number <= head.number ? await this.chain.getBlock(cursor.number) : null;
      if (atCursor?.hash.toLowerCase() !== cursor.hash.toLowerCase()) {
        result.reorg = await this.rewind(cursor, head.number);
        cursor = await this.cursor();
      }
    }
    const from = cursor ? cursor.number + 1n : (this.options.startBlock ?? head.number);
    let to = head.number < from + this.maxBlocks - 1n ? head.number : from + this.maxBlocks - 1n;

    const blocks: StoredBlock[] = [];
    if (from <= to) {
      // Headers first: each must extend the stored chain (else a reorg happened meanwhile).
      for (let n = from; n <= to; n++) {
        const header = await this.chain.getBlock(n);
        const parent =
          blocks.length > 0 ? (blocks[blocks.length - 1] as StoredBlock).hash : (cursor?.hash ?? null);
        if (parent !== null && header.parentHash.toLowerCase() !== parent.toLowerCase()) {
          if (blocks.length === 0 && cursor) {
            result.reorg = await this.rewind(cursor, head.number);
            this.lastTick = { at: this.clock.now(), result };
            return result;
          }
          break; // the chain moved during this tick: stop at the last consistent block
        }
        blocks.push({
          number: header.number,
          hash: header.hash.toLowerCase(),
          parentHash: header.parentHash.toLowerCase(),
          timestamp: header.timestamp,
        });
      }
      to = blocks.length > 0 ? (blocks[blocks.length - 1] as StoredBlock).number : from - 1n;
    }

    let events: ChainEventInternal[] = [];
    if (blocks.length > 0) {
      const logs = await this.fetchLogs(from, to);
      const byNumber = new Map(blocks.map((b) => [b.number, b]));
      if (logs.some((l) => byNumber.get(l.blockNumber)?.hash !== l.blockHash.toLowerCase())) {
        // Logs from another fork than the headers: the chain is reorganising; retry next tick.
        this.metrics.inc("indexer_inconsistent_reads_total");
        this.lastTick = { at: this.clock.now(), result };
        return result;
      }
      events = normalizeLogs(this.relevant(logs), {
        chainId: this.chainId,
        blocks: new Map<bigint, BlockInfo>(
          blocks.map((b) => [b.number, { hash: b.hash, timestamp: b.timestamp }]),
        ),
        safeBlock: tags.safe.number,
        finalizedBlock: finalized.number,
      });
      result.from = from;
      result.to = to;
    }

    const resend = await this.dueDeferred(head.number, finalized.number, tags.safe.number);
    const pushed = await this.push([...resend, ...events], head.number, finalized.number);
    result.pushed = pushed.pushed;
    result.deferred = pushed.deferred.length;
    result.suspense = pushed.suspense;
    const last = blocks[blocks.length - 1];
    await this.commit({
      blocks,
      cursor: last ? { number: last.number, hash: last.hash } : null,
      deferred: pushed.deferred,
      settled: pushed.settled,
      head: head.number,
      finalized: finalized.number,
      pruneBelow: (last?.number ?? cursor?.number ?? 0n) - this.history,
    });

    const cursorNow = last?.number ?? cursor?.number ?? from - 1n;
    result.reorgReported = await this.reportReorg(cursorNow, head.number);
    result.caughtUp = cursorNow >= head.number;
    this.metrics.blockLag(head.number - cursorNow);
    this.metrics.gauge("indexer_cursor", Number(cursorNow));
    this.metrics.gauge("indexer_deferred_events", (await this.deferredSet()).size);
    this.lastTick = { at: this.clock.now(), result };
    return result;
  }

  /** Run ticks until the cursor reaches the head (tests and catch-up). */
  async catchUp(maxTicks = 10_000): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const r = await this.tick();
      results.push(r);
      if (r.caughtUp && !(await this.hasPendingReorg())) return results;
    }
    throw new Error(`indexer did not catch up in ${maxTicks} ticks`);
  }

  /** Persist a tick and keep the in-memory mirrors current. */
  private async commit(commit: Parameters<IndexerStore["commitTick"]>[0]): Promise<void> {
    await this.store.commitTick(commit);
    if (commit.cursor) this.cursorCache = commit.cursor;
    const deferred = await this.deferredSet();
    for (const id of commit.settled) deferred.delete(id);
    for (const e of commit.deferred) deferred.add(e.id);
  }

  // ---------------------------------------------------------------- reorgs

  /** Walk back to the common ancestor and rewind; the orphaned blocks are reported later. */
  private async rewind(
    cursor: { number: bigint; hash: string },
    head: bigint,
  ): Promise<{ ancestor: bigint; orphaned: number }> {
    const lowest = (await this.store.lowestBlock()) ?? cursor.number;
    let n = cursor.number < head ? cursor.number : head;
    for (; n >= lowest; n--) {
      const stored =
        n === cursor.number ? { number: cursor.number, hash: cursor.hash } : await this.store.block(n);
      if (!stored) break;
      const onChain = await this.chain.getBlock(n);
      if (onChain.hash.toLowerCase() === stored.hash.toLowerCase()) {
        const ancestor = (await this.store.block(n)) ?? {
          number: n,
          hash: stored.hash,
          parentHash: onChain.parentHash,
          timestamp: onChain.timestamp,
        };
        const orphaned = [
          ...(await this.store.blocksAbove(n)),
          ...(cursor.number > n && !(await this.store.block(cursor.number))
            ? [{ number: cursor.number, hash: cursor.hash, parentHash: "", timestamp: 0 }]
            : []),
        ];
        await this.store.rewind(ancestor, orphaned);
        this.cursorCache = { number: ancestor.number, hash: ancestor.hash };
        this.deferredIds = null;
        if (orphaned.length > 0) this.reorgPending = true;
        this.metrics.inc("indexer_reorgs_total");
        this.metrics.inc("indexer_orphaned_blocks_total", orphaned.length);
        this.logger.warn(
          { ancestor: n.toString(), depth: orphaned.length },
          "chain reorganisation: rewound to the common ancestor",
        );
        return { ancestor: n, orphaned: orphaned.length };
      }
    }
    throw new AgentBankError(
      "internal",
      `Reorg deeper than the ${this.history} stored blocks (no common ancestor at or above block ${lowest}); manual recovery needed`,
    );
  }

  /** Report orphaned blocks once the replacement chain has been pushed up to the old tip. */
  private async reportReorg(cursor: bigint, head: bigint): Promise<number> {
    if (!(await this.hasPendingReorg())) return 0;
    const pending = await this.store.pendingReorg();
    if (pending.length === 0) {
      this.reorgPending = false;
      return 0;
    }
    const oldTip = pending.reduce((max, b) => (b.number > max ? b.number : max), 0n);
    if (cursor < oldTip && cursor < head) return 0;
    let reported = 0;
    for (let i = 0; i < pending.length; i += 1_000) {
      const chunk = pending.slice(i, i + 1_000).map((b) => b.hash);
      await this.transport.reorg({ chain_id: this.chainId, orphaned_block_hashes: chunk });
      await this.store.clearPendingReorg(chunk);
      reported += chunk.length;
    }
    this.reorgPending = false;
    return reported;
  }

  // ---------------------------------------------------------------- logs

  private async fetchLogs(from: bigint, to: bigint): Promise<ChainLog[]> {
    const w = await this.refreshWatchlist();
    const [transfers, auths, contracts, ops] = await Promise.all([
      this.chain.getLogs({
        fromBlock: from,
        toBlock: to,
        addresses: [w.usdc],
        events: ["Transfer"],
        involving: w.addresses,
      }),
      this.chain.getLogs({
        fromBlock: from,
        toBlock: to,
        addresses: [w.usdc],
        events: ["AuthorizationUsed"],
      }),
      w.contracts.length > 0
        ? this.chain.getLogs({ fromBlock: from, toBlock: to, addresses: w.contracts })
        : Promise.resolve([]),
      w.accounts.length > 0
        ? this.chain.getLogs({
            fromBlock: from,
            toBlock: to,
            events: ["UserOperationEvent"],
            involving: w.accounts,
          })
        : Promise.resolve([]),
    ]);
    return [...transfers, ...auths, ...contracts, ...ops];
  }

  /**
   * Keep transactions that touch a watched address: transfers to/from it, its EIP-3009
   * authorizations, bank contract events, its user operations. An authorization by someone else
   * is kept only alongside a kept transfer (x402 receive fees).
   */
  private relevant(logs: readonly ChainLog[]): ChainLog[] {
    const w = this.watch as Watch;
    const keep = new Set<string>();
    const key = (l: ChainLog) => `${l.blockHash.toLowerCase()}:${l.txHash.toLowerCase()}`;
    for (const log of logs) {
      if (log.eventName === "AuthorizationUsed") {
        if (typeof log.args.authorizer === "string" && w.lower.has(log.args.authorizer.toLowerCase()))
          keep.add(key(log));
        continue;
      }
      keep.add(key(log));
    }
    return logs.filter((l) => keep.has(key(l)));
  }

  private async headers(logs: readonly ChainLog[]): Promise<Map<bigint, BlockInfo>> {
    const out = new Map<bigint, BlockInfo>();
    for (const n of new Set(logs.map((l) => l.blockNumber))) {
      const stored = await this.store.block(n);
      const header = stored ?? (await this.chain.getBlock(n));
      out.set(n, { hash: header.hash.toLowerCase(), timestamp: header.timestamp });
    }
    return out;
  }

  private async pushLogs(
    logs: readonly ChainLog[],
    blocks: Map<bigint, BlockInfo>,
    tags: { head: BlockRef; safe: BlockRef; finalized: BlockRef },
  ): Promise<void> {
    const events = normalizeLogs(this.relevant(logs), {
      chainId: this.chainId,
      blocks,
      safeBlock: tags.safe.number,
      finalizedBlock: tags.finalized.number,
    });
    const pushed = await this.push(events, tags.head.number, tags.finalized.number);
    await this.commit({
      blocks: [],
      cursor: null,
      deferred: pushed.deferred,
      settled: pushed.settled,
      head: tags.head.number,
      finalized: tags.finalized.number,
      pruneBelow: 0n,
    });
  }

  /** Deferred events due for another try: whole transactions, canonical order, current finality. */
  private async dueDeferred(head: bigint, finalized: bigint, safe: bigint): Promise<ChainEventInternal[]> {
    if ((await this.deferredSet()).size === 0) return [];
    const rows = await this.store.deferred();
    const due = new Set<string>();
    for (const r of rows) {
      const block = BigInt(r.event.block_number);
      const final = block <= finalized && block > r.lastSentFinalized;
      const windowed = head - block >= this.window && r.lastSentHead - block < this.window;
      // A payment row written just after its transaction landed matches on the next resend.
      const periodic = head - r.lastSentHead >= this.resendEvery;
      if (final || windowed || periodic) due.add(txKeyOf(r.event));
    }
    return rows
      .filter((r) => due.has(txKeyOf(r.event)))
      .map((r) => {
        const block = BigInt(r.event.block_number);
        return { ...r.event, finality: block <= finalized ? "finalized" : block <= safe ? "safe" : "latest" };
      });
  }

  /** Push events in batches that never split a transaction. */
  private async push(
    events: readonly ChainEventInternal[],
    head: bigint,
    finalized: bigint,
  ): Promise<{ pushed: number; deferred: ChainEventInternal[]; settled: string[]; suspense: number }> {
    const deferred: ChainEventInternal[] = [];
    const settled: string[] = [];
    let suspense = 0;
    for (const batch of batchByTransaction(events, this.batchEvents)) {
      const response = await this.transport.ingest({
        chain_id: this.chainId,
        head_block: head.toString(),
        finalized_block: finalized.toString(),
        events: batch,
      });
      const byId = new Map<string, IngestResult>(response.results.map((r) => [r.event_id, r]));
      for (const event of batch) {
        const r = byId.get(event.id);
        if (r?.status === "deferred") deferred.push(event);
        else settled.push(event.id);
        if (r?.status === "suspense") suspense++;
      }
    }
    if (events.length > 0) {
      this.metrics.inc("indexer_events_pushed_total", events.length);
      this.metrics.unmatchedEvents(suspense);
    }
    return { pushed: events.length, deferred, settled, suspense };
  }

  // ---------------------------------------------------------------- balance check

  /**
   * On-chain USDC balance of every watched address at the cursor block versus what the ledger
   * says (`expected-balances`), adjusted for deferred events the ledger has not posted yet;
   * the result is reported to the reconciler (which persists it, emits mismatch events and
   * pauses agents). Skipped while a reorg is being reported.
   */
  async balanceCheck(): Promise<BalanceCheckResult | null> {
    const cursor = await this.cursor();
    if (!cursor || (await this.hasPendingReorg())) return null;
    const w = await this.refreshWatchlist(true);
    const pending = new Map<string, bigint>();
    for (const { event } of await this.store.deferred()) {
      if (event.event_name !== "Transfer" || event.contract.toLowerCase() !== w.usdc.toLowerCase()) continue;
      const value = BigInt(event.args.value ?? "0");
      const from = (event.args.from ?? "").toLowerCase();
      const to = (event.args.to ?? "").toLowerCase();
      if (w.lower.has(from)) pending.set(from, (pending.get(from) ?? 0n) - value);
      if (w.lower.has(to)) pending.set(to, (pending.get(to) ?? 0n) + value);
    }
    const expected = new Map<string, bigint>();
    for (let i = 0; i < w.addresses.length; i += 1_000) {
      const r = await this.transport.expectedBalances({
        chain_id: this.chainId,
        addresses: w.addresses.slice(i, i + 1_000),
      });
      for (const b of r.balances) expected.set(b.address.toLowerCase(), BigInt(b.expected));
    }
    const mismatches: BalanceCheckResult["mismatches"] = [];
    for (const address of w.addresses) {
      const key = address.toLowerCase();
      const onchain = await this.chain.getTokenBalance(w.usdc, address, cursor.number);
      const want = (expected.get(key) ?? 0n) + (pending.get(key) ?? 0n);
      const shared = SHARED_CONTRACTS.has(w.kinds.get(key) ?? "");
      const bad =
        shared && (this.options.balanceCheckContracts ?? "at_least") === "at_least"
          ? onchain < want
          : onchain !== want;
      if (bad)
        mismatches.push({
          address,
          onchain: onchain.toString(),
          expected: want < 0n ? "0" : want.toString(),
        });
    }
    const report = await this.transport.report({
      chain_id: this.chainId,
      block_number: cursor.number.toString(),
      checked: w.addresses.length,
      mismatches,
    });
    await this.store.recordBalanceCheck({
      id: newId("audit", this.clock.now().getTime()).replace(/^aud_/, "ibc_"),
      blockNumber: cursor.number,
      checked: w.addresses.length,
      mismatches,
      reported: true,
      runId: (report as { run_id?: string } | null)?.run_id ?? null,
    });
    this.metrics.unmatchedEvents(mismatches.length);
    this.metrics.inc("indexer_balance_checks_total");
    if (mismatches.length > 0)
      this.logger.error(
        { block: cursor.number.toString(), mismatches },
        "on-chain balances differ from the ledger",
      );
    return { blockNumber: cursor.number, checked: w.addresses.length, mismatches, report };
  }

  /** Run the balance check once per UTC day after `balanceCheckHourUtc`, when caught up. */
  async maybeNightlyCheck(): Promise<BalanceCheckResult | null> {
    const now = this.clock.now();
    if (now.getUTCHours() < (this.options.balanceCheckHourUtc ?? 3)) return null;
    const day = now.toISOString().slice(0, 10);
    if ((await this.store.getState("balance_check_day")) === day) return null;
    if (!this.lastTick?.result.caughtUp) return null;
    const result = await this.balanceCheck();
    if (result) await this.store.setState("balance_check_day", day);
    return result;
  }
}
