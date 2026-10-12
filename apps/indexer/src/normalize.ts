import type { ChainLog, JsonValue } from "@agentbank/chain";
import type { ChainEventInternal } from "@agentbank/core";

/**
 * Logs as the reconciler receives them (`ChainEventInternal`, core/src/indexer-api.ts):
 * deterministic ids, lowercase hashes, arguments as strings, the block's finality when sent,
 * and the ERC-4337 user operation each log belongs to.
 */

/** Deterministic event id: `${chainId}:${blockHash}:${txHash}:${logIndex}` (lowercase hashes). */
export function eventIdOf(chainId: number, blockHash: string, txHash: string, logIndex: number): string {
  return `${chainId}:${blockHash.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;
}

/** Transaction group key: a transaction's logs are never split across ingest batches. */
export function txKeyOf(event: Pick<ChainEventInternal, "block_hash" | "tx_hash">): string {
  return `${event.block_hash.toLowerCase()}:${event.tx_hash.toLowerCase()}`;
}

function argString(value: JsonValue): string {
  if (typeof value === "string") return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export interface BlockInfo {
  hash: string;
  timestamp: number;
}

export interface NormalizeOptions {
  chainId: number;
  /** Headers of the blocks the logs come from (by number). */
  blocks: ReadonlyMap<bigint, BlockInfo>;
  safeBlock: bigint;
  finalizedBlock: bigint;
}

/**
 * Normalize logs (any order) into events in canonical order. Within a transaction every log is
 * attributed to the user operation whose `UserOperationEvent` follows it (the EntryPoint emits
 * it after executing each operation of a bundle), so payments in multi-operation bundles still
 * match their own operation.
 */
export function normalizeLogs(logs: readonly ChainLog[], options: NormalizeOptions): ChainEventInternal[] {
  const sorted = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const opsByTx = new Map<string, { logIndex: number; hash: string }[]>();
  for (const log of sorted) {
    if (log.eventName !== "UserOperationEvent") continue;
    const hash = log.args.userOpHash;
    if (typeof hash !== "string") continue;
    const key = `${log.blockHash.toLowerCase()}:${log.txHash.toLowerCase()}`;
    opsByTx.set(key, [...(opsByTx.get(key) ?? []), { logIndex: log.logIndex, hash: hash.toLowerCase() }]);
  }
  const out: ChainEventInternal[] = [];
  const seen = new Set<string>();
  for (const log of sorted) {
    const id = eventIdOf(options.chainId, log.blockHash, log.txHash, log.logIndex);
    if (seen.has(id)) continue;
    seen.add(id);
    const block = options.blocks.get(log.blockNumber);
    const ops = opsByTx.get(`${log.blockHash.toLowerCase()}:${log.txHash.toLowerCase()}`) ?? [];
    const op = ops.find((o) => o.logIndex >= log.logIndex);
    const args: Record<string, string> = {};
    for (const [name, value] of Object.entries(log.args)) args[name] = argString(value);
    out.push({
      id,
      chain_id: options.chainId,
      block_number: log.blockNumber.toString(),
      block_hash: log.blockHash.toLowerCase(),
      block_timestamp: block?.timestamp ?? 0,
      tx_hash: log.txHash.toLowerCase(),
      log_index: log.logIndex,
      finality:
        log.blockNumber <= options.finalizedBlock
          ? "finalized"
          : log.blockNumber <= options.safeBlock
            ? "safe"
            : "latest",
      contract: log.address,
      event_name: log.eventName,
      args,
      user_op_hash: op?.hash ?? null,
    });
  }
  return out;
}

/** Split events into batches of at most `max` events without splitting a transaction. */
export function batchByTransaction(
  events: readonly ChainEventInternal[],
  max: number,
): ChainEventInternal[][] {
  const groups: ChainEventInternal[][] = [];
  let current: ChainEventInternal[] = [];
  let lastKey: string | null = null;
  for (const event of events) {
    const key = txKeyOf(event);
    if (key !== lastKey) {
      groups.push((current = []));
      lastKey = key;
    }
    current.push(event);
  }
  const batches: ChainEventInternal[][] = [];
  let batch: ChainEventInternal[] = [];
  for (const group of groups) {
    if (batch.length > 0 && batch.length + group.length > max) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
