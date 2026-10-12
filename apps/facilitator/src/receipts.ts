import type { EvmChainGateway } from "@agentbank/chain";
import type { SimulatedChain } from "@agentbank/chain/simulated";
import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError, type Hex } from "viem";

/**
 * Transaction receipts for relayed settlements. `ChainGateway.settleAuthorization` returns once
 * the transaction is broadcast; the facilitator then waits for inclusion through one of these.
 */

export interface TransactionOutcome {
  status: "success" | "reverted";
  blockNumber: bigint;
  /** Revert reason when known (the simulator reports it; RPC receipts do not carry one). */
  revertReason: string | null;
}

export interface ReceiptSource {
  /**
   * The outcome once the transaction is included, waiting up to `timeoutMs` (0: look once).
   * `undefined` when it is not included in time. Throws on RPC errors (outcome unknown).
   */
  wait(txHash: Hex, timeoutMs: number): Promise<TransactionOutcome | undefined>;
}

/** Receipts from the EVM gateway's JSON-RPC client (Base Sepolia, Anvil). */
export function evmReceipts(
  gateway: Pick<EvmChainGateway, "publicClient">,
  pollingIntervalMs = 1_000,
): ReceiptSource {
  return {
    async wait(hash, timeoutMs) {
      try {
        const receipt =
          timeoutMs <= 0
            ? await gateway.publicClient.getTransactionReceipt({ hash })
            : await gateway.publicClient.waitForTransactionReceipt({
                hash,
                timeout: timeoutMs,
                pollingInterval: pollingIntervalMs,
              });
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          revertReason: receipt.status === "reverted" ? "transferWithAuthorization reverted" : null,
        };
      } catch (error) {
        if (
          error instanceof TransactionReceiptNotFoundError ||
          error instanceof WaitForTransactionReceiptTimeoutError
        ) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

/** Receipts from an in-memory {@link SimulatedChain} (tests and local development). */
export function simulatedReceipts(chain: Pick<SimulatedChain, "transaction">, pollMs = 5): ReceiptSource {
  return {
    async wait(hash, timeoutMs) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        const tx = chain.transaction(hash);
        if (tx) {
          return {
            status: tx.success ? "success" : "reverted",
            blockNumber: tx.blockNumber,
            revertReason: tx.revertReason,
          };
        }
        if (Date.now() >= deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
