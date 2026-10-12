import type { SimulatedChain } from "@agentbank/chain/simulated";
import type { ChainEventInternal, IngestEventsResponse } from "@agentbank/core";
import type { AppDeps } from "../deps";
import { chainHead, collectChainEvents, finalityOf } from "./chain-events";

/**
 * Local development on `AGENTBANK_CHAIN=simulated`: the chain lives in the API process, so no
 * separate apps/indexer can read it. This loop produces a block every `SIMULATED_BLOCK_TIME_MS`
 * and hands new logs straight to the reconciler, as the indexer would over
 * `POST /internal/v1/chain-events`. Deferred events (large movements before finality,
 * unexplained outflows inside the matching window) are resent with their current finality
 * until the reconciler takes them.
 */
export class SimulatedIndexer {
  private nextBlock = 0n;
  private deferred: ChainEventInternal[] = [];
  private running = false;

  constructor(
    private readonly deps: AppDeps,
    private readonly simulator: SimulatedChain,
  ) {}

  /** Mine one block (optional) and push everything new to the reconciler. */
  async tick(options: { mine?: boolean } = {}): Promise<number> {
    const reconciler = this.deps.reconciler;
    if (!reconciler || this.running) return 0;
    this.running = true;
    try {
      if (options.mine !== false) this.simulator.mine(1);
      const head = await chainHead(this.deps.chain);
      const fresh = await collectChainEvents(this.deps.chain, this.nextBlock, head.head, head);
      const events = [
        ...this.deferred.map((e) => ({ ...e, finality: finalityOf(BigInt(e.block_number), head) })),
        ...fresh,
      ];
      this.nextBlock = head.head + 1n;
      if (events.length === 0) return 0;
      const response = (await reconciler.ingest({
        chain_id: this.deps.chain.chainId,
        head_block: head.head.toString(),
        finalized_block: head.finalized.toString(),
        events,
      })) as IngestEventsResponse;
      const stillDeferred = new Set(
        response.results.filter((r) => r.status === "deferred").map((r) => r.event_id),
      );
      this.deferred = events.filter((e) => stillDeferred.has(e.id));
      return events.length - this.deferred.length;
    } catch (error) {
      this.deps.logger.error({ err: error }, "simulated chain indexing failed");
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Run `tick` on an interval; returns the stop function. */
  start(intervalMs: number): () => Promise<void> {
    const timer = setInterval(() => void this.tick(), intervalMs);
    timer.unref();
    return async () => clearInterval(timer);
  }
}
