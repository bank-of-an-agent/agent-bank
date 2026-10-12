import type { ChainLog } from "@agentbank/chain";
import { describe, expect, it } from "vitest";
import { batchByTransaction, IndexerMetrics, normalizeLogs } from "../src";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const USDC = "0x5Dc0000000000000000000000000000000005Dc0" as const;
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

function log(
  block: bigint,
  tx: number,
  logIndex: number,
  eventName: ChainLog["eventName"],
  args: ChainLog["args"],
): ChainLog {
  return {
    chainId: 1337,
    blockNumber: block,
    blockHash: H(1000 + Number(block)),
    txHash: H(tx),
    logIndex,
    address: eventName === "UserOperationEvent" ? EP : USDC,
    eventName,
    args,
  };
}

describe("normalization", () => {
  it("attributes each log to the user operation whose UserOperationEvent follows it", () => {
    const logs = [
      log(5n, 1, 4, "UserOperationEvent", { userOpHash: H(42), sender: USDC, success: "false" }),
      log(5n, 1, 0, "Transfer", { from: USDC, to: EP, value: "1" }),
      log(5n, 1, 1, "UserOperationEvent", { userOpHash: H(41), sender: USDC, success: "true" }),
      log(5n, 1, 2, "Transfer", { from: USDC, to: EP, value: "2" }),
      log(5n, 1, 5, "Transfer", { from: USDC, to: EP, value: "3" }),
      log(4n, 2, 0, "Transfer", { from: EP, to: USDC, value: "9" }),
    ];
    const events = normalizeLogs(logs, {
      chainId: 1337,
      blocks: new Map([
        [4n, { hash: H(1004), timestamp: 100 }],
        [5n, { hash: H(1005), timestamp: 102 }],
      ]),
      safeBlock: 4n,
      finalizedBlock: 3n,
    });
    expect(events.map((e) => [e.block_number, e.log_index, e.user_op_hash])).toEqual([
      ["4", 0, null],
      ["5", 0, H(41)],
      ["5", 1, H(41)],
      ["5", 2, H(42)],
      ["5", 4, H(42)],
      ["5", 5, null],
    ]);
    expect(events.map((e) => e.finality)).toEqual(["safe", "latest", "latest", "latest", "latest", "latest"]);
    expect(events[2]?.args.success).toBe("true");
    expect(events[1]).toMatchObject({ block_timestamp: 102, id: `1337:${H(1005)}:${H(1)}:0` });
  });

  it("batches without splitting a transaction", () => {
    const events = normalizeLogs(
      [
        log(1n, 1, 0, "Transfer", { from: USDC, to: EP, value: "1" }),
        log(1n, 1, 1, "Transfer", { from: USDC, to: EP, value: "1" }),
        log(1n, 1, 2, "Transfer", { from: USDC, to: EP, value: "1" }),
        log(1n, 2, 3, "Transfer", { from: USDC, to: EP, value: "1" }),
        log(2n, 3, 0, "Transfer", { from: USDC, to: EP, value: "1" }),
      ],
      { chainId: 1337, blocks: new Map(), safeBlock: 0n, finalizedBlock: 0n },
    );
    expect(batchByTransaction(events, 2).map((b) => b.map((e) => e.tx_hash))).toEqual([
      [H(1), H(1), H(1)],
      [H(2), H(3)],
    ]);
    expect(batchByTransaction(events, 10)).toHaveLength(1);
  });
});

describe("metrics", () => {
  it("writes CloudWatch EMF lines only when a namespace is configured", () => {
    const lines: string[] = [];
    const quiet = new IndexerMetrics({ write: (l) => lines.push(l) });
    quiet.blockLag(3n);
    quiet.unmatchedEvents(2);
    expect(lines).toEqual([]);
    expect(quiet.render()).toContain("indexer_block_lag 3");
    const loud = new IndexerMetrics({
      indexerNamespace: "AgentBank/Indexer",
      reconciliationNamespace: "AgentBank/Reconciliation",
      write: (l) => lines.push(l),
      now: () => 1_791_000_000_000,
    });
    loud.blockLag(-1n);
    loud.unmatchedEvents(1);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        _aws: {
          Timestamp: 1_791_000_000_000,
          CloudWatchMetrics: [
            {
              Namespace: "AgentBank/Indexer",
              Dimensions: [[]],
              Metrics: [{ Name: "BlockLag", Unit: "Count" }],
            },
          ],
        },
        BlockLag: 0,
      },
      {
        _aws: {
          Timestamp: 1_791_000_000_000,
          CloudWatchMetrics: [
            {
              Namespace: "AgentBank/Reconciliation",
              Dimensions: [[]],
              Metrics: [{ Name: "UnmatchedEvents", Unit: "Count" }],
            },
          ],
        },
        UnmatchedEvents: 1,
      },
    ]);
  });
});
