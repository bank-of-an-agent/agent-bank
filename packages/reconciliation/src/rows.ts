import type { SqlClient, SqlParam } from "@agentbank/db";

/**
 * Row shapes the reconciler reads from the API database (0002_core, 0003_chain, 0005_api).
 * Both drivers map int8 to bigint, timestamptz to Date and jsonb to parsed JSON.
 */

export interface AccountRow {
  id: string;
  org_id: string;
  agent_id: string | null;
  role: "agent" | "treasury";
  chain_id: number;
  address: string;
  spend_key_address: string | null;
}

export interface PaymentRow {
  id: string;
  account_id: string;
  org_id: string;
  agent_id: string | null;
  kind: "transfer" | "x402" | "escrow" | "stream" | "payout" | "refill" | "topup" | "fee" | "vault";
  counterparty_type: "address" | "agent" | "x402" | "escrow" | "stream";
  counterparty_address: string;
  counterparty_agent_id: string | null;
  counterparty_x402_domain: string | null;
  amount: bigint;
  fee: bigint;
  asset: string;
  status:
    | "requires_approval"
    | "requires_signature"
    | "submitted"
    | "settled"
    | "denied"
    | "failed"
    | "canceled"
    | "expired";
  memo: string | null;
  mandate_id: string | null;
  payment_request_id: string | null;
  decision_id: string | null;
  approval_id: string | null;
  owner_operation_id: string | null;
  hold_id: string | null;
  session_id: string | null;
  user_op_hash: string | null;
  tx_hash: string | null;
  x402_nonce: string | null;
  failure_reason: string | null;
  metadata: Record<string, string> | null;
  vault_id?: string | null;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
}

export interface EscrowRow {
  id: string;
  payer_account_id: string;
  payee_address: string;
  payee_agent_id: string | null;
  amount: bigint;
  fee: bigint;
  status: string;
  release_mode: "payer" | "arbiter" | "validator";
  arbiter: string | null;
  validator_json: { registry: string; request_hash: string; min_response: number } | null;
  terms_hash: string | null;
  contract_address: string;
  onchain_id: string | null;
  expires_at: Date;
  pending_action: string | null;
  payment_id: string | null;
  tx_hash: string | null;
  memo: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StreamRow {
  id: string;
  payer_account_id: string;
  payee_address: string;
  payee_agent_id: string | null;
  kind: "streaming" | "recurring";
  amount_per_interval: bigint;
  interval_seconds: number;
  deposit: bigint;
  settled: bigint;
  settle_every_seconds: number;
  start_at: Date;
  stop_at: Date | null;
  status: string;
  contract_address: string;
  onchain_id: string | null;
  pending_action: string | null;
  payment_id: string | null;
  tx_hash: string | null;
  last_settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface VaultRow {
  id: string;
  account_id: string;
  kind: "goal" | "locked";
  contract_address: string | null;
  onchain_id: string | null;
}

export interface ChainTxRow {
  id: string;
  chain_id: number;
  block_number: bigint;
  block_hash: string;
  block_timestamp: Date;
  tx_hash: string;
  first_log_index: number;
  fingerprint: string;
  status: "processed" | "deferred" | "reorged";
  outcome: string | null;
  deferred_reason: "window" | "finality" | "error" | null;
  generation: number;
  entry_ids: string[];
  effects: unknown[];
  reversal: "none" | "pending" | "done" | "rebound";
  reversal_entry_ids: string[];
  superseded_by: string | null;
  alerted_at: Date | null;
  detail: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
  reorged_at: Date | null;
}

export interface ChainEventRow {
  id: string;
  chain_tx_id: string;
  log_index: number;
  event_name: string;
  status: "processed" | "deferred" | "reorged" | "suspense";
  result: "matched" | "deposit" | "suspense" | "deferred" | "ignored";
  ref: string | null;
  entry_id: string | null;
  matched_entry_id: string | null;
}

/** First row of a query, or undefined. */
export async function one<T>(
  db: SqlClient,
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<T | undefined> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}

/** All rows of a query. */
export async function all<T>(db: SqlClient, sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
  const { rows } = await db.query<T>(sql, params);
  return rows;
}
