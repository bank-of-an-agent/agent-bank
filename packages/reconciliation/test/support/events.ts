import type { ChainEventInternal, IngestEventsRequest } from "@agentbank/core";
import { keccak256, stringToHex, type Hex } from "viem";

/** Hand-made chain evidence for rule-level tests (what the indexer would push). */

export function hashOf(label: string): Hex {
  return keccak256(stringToHex(label));
}

export interface LogSpec {
  contract: string;
  name: string;
  args: Record<string, string>;
  userOpHash?: string | null;
}

export interface TxSpec {
  chainId: number;
  blockNumber: bigint;
  blockHash?: Hex;
  timestamp?: number;
  txHash?: Hex;
  firstLogIndex?: number;
  finality?: ChainEventInternal["finality"];
  /** Applied to every log that does not set its own. */
  userOpHash?: string | null;
  logs: LogSpec[];
}

/** Events of one transaction, with deterministic ids. */
export function txEvents(spec: TxSpec): ChainEventInternal[] {
  const blockHash = (spec.blockHash ?? hashOf(`block:${spec.blockNumber}`)).toLowerCase();
  const txHash = (spec.txHash ?? hashOf(`tx:${spec.blockNumber}:${spec.firstLogIndex ?? 0}`)).toLowerCase();
  return spec.logs.map((log, i) => {
    const logIndex = (spec.firstLogIndex ?? 0) + i;
    return {
      id: `${spec.chainId}:${blockHash}:${txHash}:${logIndex}`,
      chain_id: spec.chainId,
      block_number: spec.blockNumber.toString(),
      block_hash: blockHash,
      block_timestamp: spec.timestamp ?? 1_791_000_000 + Number(spec.blockNumber) * 2,
      tx_hash: txHash,
      log_index: logIndex,
      finality: spec.finality ?? "latest",
      contract: log.contract,
      event_name: log.name,
      args: log.args,
      user_op_hash: log.userOpHash === undefined ? (spec.userOpHash ?? null) : log.userOpHash,
    };
  });
}

export function transfer(
  usdc: string,
  from: string,
  to: string,
  value: bigint,
  userOpHash?: string | null,
): LogSpec {
  return {
    contract: usdc,
    name: "Transfer",
    args: { from, to, value: value.toString() },
    ...(userOpHash !== undefined ? { userOpHash } : {}),
  };
}

export function userOperation(
  entryPoint: string,
  userOpHash: string,
  sender: string,
  success = true,
): LogSpec {
  return {
    contract: entryPoint,
    name: "UserOperationEvent",
    args: {
      userOpHash,
      sender,
      paymaster: "0x0000000000000000000000000000000000000000",
      nonce: "0",
      success: String(success),
      actualGasCost: "0",
      actualGasUsed: "0",
    },
    userOpHash,
  };
}

export function request(
  chainId: number,
  events: ChainEventInternal[],
  head: bigint,
  finalized: bigint,
): IngestEventsRequest {
  return { chain_id: chainId, head_block: head.toString(), finalized_block: finalized.toString(), events };
}
