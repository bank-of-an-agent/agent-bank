import { z } from "zod";
import { MinorUnitsString } from "./cosigner-api";
import { AddressSchema, Bytes32Schema } from "./schemas";

/**
 * Internal API between `apps/indexer` (its own cloud account and database)
 * and `apps/api` (which owns the ledger). The indexer is the single writer of
 * chain evidence: it reads logs, tracks block hashes to detect reorgs and
 * pushes normalized events; the API's reconciler (`@agentbank/reconciliation`,
 * mounted inside the API process) matches them to expected movements and
 * posts ledger entries in the API database. Requests are authenticated with
 * `signInternalRequest` using `INTERNAL_API_SHARED_SECRET`.
 */

export const IndexerRoutes = {
  watchlist: { method: "GET", path: "/internal/v1/watchlist" },
  ingestEvents: { method: "POST", path: "/internal/v1/chain-events" },
  reorg: { method: "POST", path: "/internal/v1/chain-events/reorg" },
  expectedBalances: { method: "POST", path: "/internal/v1/reconciliation/expected-balances" },
  reportBalances: { method: "POST", path: "/internal/v1/reconciliation/report" },
} as const;

export const WatchedAddressKind = z.enum([
  "account",
  "treasury",
  "spend_key",
  "revenue",
  "escrow_contract",
  "streams_contract",
  "vaults_contract",
  "topup_executor",
  "sweep_executor",
]);

export const WatchedAddress = z.object({
  address: AddressSchema,
  kind: WatchedAddressKind,
  account_id: z.string().nullable(),
  /** Block from which the address matters (account creation), for backfills. */
  since_block: z
    .string()
    .regex(/^[0-9]+$/)
    .nullable(),
});

export const WatchlistResponse = z.object({
  chain_id: z.number().int(),
  usdc: AddressSchema,
  addresses: z.array(WatchedAddress),
  /** Opaque version; changes whenever the list changes. */
  version: z.string(),
});

export const ChainEventInternal = z.object({
  /** Deterministic id: `${chainId}:${blockHash}:${txHash}:${logIndex}`. */
  id: z.string(),
  chain_id: z.number().int(),
  block_number: z.string().regex(/^[0-9]+$/),
  block_hash: Bytes32Schema,
  block_timestamp: z.number().int().nonnegative(),
  tx_hash: Bytes32Schema,
  log_index: z.number().int().nonnegative(),
  /** Finality of the block when this event was sent. */
  finality: z.enum(["latest", "safe", "finalized"]),
  contract: AddressSchema,
  event_name: z.string(),
  /** Decoded event arguments; integers as decimal strings, addresses checksummed. */
  args: z.record(z.string(), z.string()),
  /** ERC-4337 user operation hash from the same transaction, when there is exactly one. */
  user_op_hash: Bytes32Schema.nullable(),
});

export const IngestEventsRequest = z.object({
  chain_id: z.number().int(),
  /** Latest block the indexer has seen; lets the reconciler apply the 20-block matching window. */
  head_block: z.string().regex(/^[0-9]+$/),
  /** Latest finalized block; deferred large movements post once their block is at or below it. */
  finalized_block: z.string().regex(/^[0-9]+$/),
  /** Events in canonical order. A transaction's logs are never split across batches. */
  events: z.array(ChainEventInternal).max(5000),
});

export const IngestResult = z.object({
  event_id: z.string(),
  /**
   * - `matched`: posted against an expected movement (payment, x402, escrow, stream, vault, fee sweep).
   * - `deposit`: unsolicited inbound transfer posted as a deposit.
   * - `suspense`: unexpected movement posted to `sys:suspense`; mismatch event raised and the agent paused.
   * - `deferred`: amount at or above the finality threshold seen before finality; resend when finalized.
   * - `duplicate`: already processed (idempotent replay).
   * - `ignored`: not relevant to any known account.
   */
  status: z.enum(["matched", "deposit", "suspense", "deferred", "duplicate", "ignored"]),
  entry_id: z.string().nullable(),
  ref: z.string().nullable(),
});

export const IngestEventsResponse = z.object({ results: z.array(IngestResult) });

export const ReorgRequest = z.object({
  chain_id: z.number().int(),
  /** Hashes of blocks that are no longer canonical. */
  orphaned_block_hashes: z.array(Bytes32Schema).min(1).max(1000),
});

export const ReorgResponse = z.object({
  reversed_entries: z.number().int().nonnegative(),
  reopened: z.array(z.string()).meta({ description: "Payment/escrow/stream ids returned to submitted" }),
});

export const ExpectedBalancesRequest = z.object({
  chain_id: z.number().int(),
  addresses: z.array(AddressSchema).min(1).max(1000),
});

export const ExpectedBalancesResponse = z.object({
  balances: z.array(z.object({ address: AddressSchema, expected: MinorUnitsString })),
});

export const BalanceReportRequest = z.object({
  chain_id: z.number().int(),
  block_number: z.string().regex(/^[0-9]+$/),
  checked: z.number().int().nonnegative(),
  mismatches: z.array(
    z.object({ address: AddressSchema, onchain: MinorUnitsString, expected: MinorUnitsString }),
  ),
});

export type WatchedAddress = z.infer<typeof WatchedAddress>;
export type WatchlistResponse = z.infer<typeof WatchlistResponse>;
export type ChainEventInternal = z.infer<typeof ChainEventInternal>;
export type IngestEventsRequest = z.infer<typeof IngestEventsRequest>;
export type IngestResult = z.infer<typeof IngestResult>;
export type IngestEventsResponse = z.infer<typeof IngestEventsResponse>;
export type ReorgRequest = z.infer<typeof ReorgRequest>;
export type ReorgResponse = z.infer<typeof ReorgResponse>;
export type ExpectedBalancesRequest = z.infer<typeof ExpectedBalancesRequest>;
export type ExpectedBalancesResponse = z.infer<typeof ExpectedBalancesResponse>;
export type BalanceReportRequest = z.infer<typeof BalanceReportRequest>;

/** Amount (USDC minor units) at or above which movements wait for finality. Default $100. */
export const FINALITY_THRESHOLD_MINOR = 100_000_000n;
