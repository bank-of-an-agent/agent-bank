import type { ChainGateway } from "@agentbank/chain";
import type { SimulatedChain } from "@agentbank/chain/simulated";
import { signInternalRequest, unixSeconds, type ManualClock } from "@agentbank/core";
import type { FastifyInstance } from "fastify";
import { chainHead, collectChainEvents } from "../../src/dev/chain-events";

/**
 * A minimal stand-in for apps/indexer: reads logs from the SimulatedChain and pushes them to the
 * API's `POST /internal/v1/chain-events` (HMAC-signed), so the real reconciler settles payments,
 * posts deposits and moves escrows/streams from chain evidence, exactly as in production.
 */
export class TestIndexer {
  private nextBlock = 0n;

  constructor(
    private readonly app: FastifyInstance,
    private readonly sim: SimulatedChain,
    private readonly chain: ChainGateway,
    private readonly clock: ManualClock,
    private readonly secret: string,
  ) {}

  private async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const raw = JSON.stringify(body);
    const res = await this.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: signInternalRequest(this.secret, "POST", path, raw, unixSeconds(this.clock.now())),
        "content-type": "application/json",
      },
      payload: raw,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as unknown };
  }

  /**
   * Mine enough blocks for finality (movements of $100 or more wait for it), keep the API's
   * clock in step with the chain, and push every new log. Returns the reconciler's results.
   */
  async sync(options: { finalize?: boolean } = {}): Promise<unknown[]> {
    this.sim.mine(options.finalize === false ? 1 : this.sim.finalityDepth + 1);
    const latest = await this.chain.getBlock("latest");
    if (latest.timestamp * 1000 > this.clock.now().getTime()) this.clock.set(latest.timestamp * 1000);
    const head = await chainHead(this.chain);
    if (this.nextBlock > head.head) return [];
    const events = await collectChainEvents(this.chain, this.nextBlock, head.head, head);
    const res = await this.post("/internal/v1/chain-events", {
      chain_id: this.chain.chainId,
      head_block: head.head.toString(),
      finalized_block: head.finalized.toString(),
      events,
    });
    if (res.status !== 200) throw new Error(`ingest failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.nextBlock = head.head + 1n;
    return (res.body as { results: unknown[] }).results;
  }
}
