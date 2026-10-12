import type { ChainGateway, ChainLog } from "@agentbank/chain";
import type { ChainEventInternal } from "@agentbank/core";

/**
 * Chain logs in the indexer's wire shape (`ChainEventInternal`, core indexer-api.ts): what
 * apps/indexer sends to `POST /internal/v1/chain-events`. Used by the development indexer that
 * feeds the reconciler from the in-process simulated chain, and by the tests.
 */

export interface ChainHead {
  head: bigint;
  safe: bigint;
  finalized: bigint;
}

export async function chainHead(chain: ChainGateway): Promise<ChainHead> {
  const [head, safe, finalized] = await Promise.all([
    chain.getBlock("latest"),
    chain.getBlock("safe"),
    chain.getBlock("finalized"),
  ]);
  return { head: head.number, safe: safe.number, finalized: finalized.number };
}

/** Finality of a block as of `head`. */
export function finalityOf(blockNumber: bigint, head: ChainHead): ChainEventInternal["finality"] {
  return blockNumber <= head.finalized ? "finalized" : blockNumber <= head.safe ? "safe" : "latest";
}

function argValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(value);
}

/** Logs of blocks `[fromBlock, toBlock]` as indexer events (a transaction's logs stay together). */
export async function collectChainEvents(
  chain: ChainGateway,
  fromBlock: bigint,
  toBlock: bigint,
  head: ChainHead,
): Promise<ChainEventInternal[]> {
  if (fromBlock > toBlock) return [];
  const logs: ChainLog[] = await chain.getLogs({ fromBlock, toBlock });
  const userOps = new Map<string, string[]>();
  for (const log of logs) {
    if (log.eventName === "UserOperationEvent" && typeof log.args.userOpHash === "string") {
      userOps.set(log.txHash, [...(userOps.get(log.txHash) ?? []), log.args.userOpHash]);
    }
  }
  const timestamps = new Map<bigint, number>();
  const events: ChainEventInternal[] = [];
  for (const log of logs) {
    let timestamp = timestamps.get(log.blockNumber);
    if (timestamp === undefined) {
      timestamp = (await chain.getBlock(log.blockNumber)).timestamp;
      timestamps.set(log.blockNumber, timestamp);
    }
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(log.args)) args[key] = argValue(value);
    const ops = userOps.get(log.txHash) ?? [];
    events.push({
      id: `${log.chainId}:${log.blockHash}:${log.txHash}:${log.logIndex}`,
      chain_id: log.chainId,
      block_number: log.blockNumber.toString(),
      block_hash: log.blockHash,
      block_timestamp: timestamp,
      tx_hash: log.txHash,
      log_index: log.logIndex,
      finality: finalityOf(log.blockNumber, head),
      contract: log.address,
      event_name: log.eventName,
      args,
      user_op_hash: ops.length === 1 ? (ops[0] as `0x${string}`) : null,
    });
  }
  return events;
}
