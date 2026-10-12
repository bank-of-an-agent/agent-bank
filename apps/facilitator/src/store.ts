import { newId } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Address, Hex } from "viem";

/**
 * The facilitator's authorization log (`x402_authorization`, migration 0004). Every row is an
 * EIP-3009 authorization accepted for settlement; UNIQUE (chain_id, asset, authorizer, nonce)
 * makes it single-use. Rows are written only through guarded state transitions
 * (`WHERE status = 'settling'`), so concurrent writers cannot overwrite a final outcome.
 */

export type AuthorizationStatus = "settling" | "settled" | "failed";

export interface AuthorizationRow {
  id: string;
  chain_id: number;
  scheme: string;
  asset: string;
  authorizer: string;
  nonce: string;
  pay_to: string;
  amount: bigint;
  valid_after: bigint;
  valid_before: bigint;
  payee_account_id: string | null;
  resource_url: string | null;
  request_hash: string;
  status: AuthorizationStatus;
  relayer: string | null;
  tx_hash: string | null;
  block_number: bigint | null;
  failure_reason: string | null;
  failure_detail: string | null;
  created_at: Date;
  submitted_at: Date | null;
  settled_at: Date | null;
  updated_at: Date;
}

/** The single-use key of an authorization. Addresses checksummed, nonce lowercase. */
export interface AuthorizationKey {
  chainId: number;
  asset: Address;
  authorizer: Address;
  nonce: Hex;
}

export interface NewAuthorization extends AuthorizationKey {
  payTo: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  payeeAccountId: string | null;
  resourceUrl: string | undefined;
  requestHash: string;
  relayer: Address | undefined;
  at: Date;
}

const COLUMNS = `id, chain_id, scheme, asset, authorizer, nonce, pay_to, amount, valid_after, valid_before,
  payee_account_id, resource_url, request_hash, status, relayer, tx_hash, block_number, failure_reason,
  failure_detail, created_at, submitted_at, settled_at, updated_at`;

/** Failure details are free text from RPC nodes and contracts; keep them bounded. */
function clip(value: string | null | undefined, max = 500): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export class AuthorizationStore {
  constructor(private readonly db: SqlClient) {}

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }

  async findByKey(key: AuthorizationKey): Promise<AuthorizationRow | undefined> {
    const { rows } = await this.db.query<AuthorizationRow>(
      `SELECT ${COLUMNS} FROM x402_authorization
        WHERE chain_id = $1 AND asset = $2 AND authorizer = $3 AND nonce = $4`,
      [key.chainId, key.asset, key.authorizer, key.nonce.toLowerCase()],
    );
    return rows[0];
  }

  async findById(id: string): Promise<AuthorizationRow | undefined> {
    const { rows } = await this.db.query<AuthorizationRow>(
      `SELECT ${COLUMNS} FROM x402_authorization WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /**
   * The Agent Bank account behind `payTo` when it is registered as an x402 payee (read-only use
   * of `x402_payee` and `account` from 0002_core).
   */
  async findPayeeAccountId(chainId: number, payTo: Address): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT a.id FROM x402_payee p JOIN account a ON a.id = p.account_id
        WHERE a.chain_id = $1 AND lower(a.address) = lower($2)
        ORDER BY p.created_at LIMIT 1`,
      [chainId, payTo],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Claim the authorization: insert it as `settling`. Returns `undefined` when a row for the
   * same (chain, asset, authorizer, nonce) already exists, i.e. another request got there first.
   */
  async insertSettling(input: NewAuthorization): Promise<AuthorizationRow | undefined> {
    const { rows } = await this.db.query<AuthorizationRow>(
      `INSERT INTO x402_authorization (id, chain_id, scheme, asset, authorizer, nonce, pay_to, amount, valid_after,
         valid_before, payee_account_id, resource_url, request_hash, status, relayer, created_at, updated_at)
       VALUES ($1, $2, 'exact', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'settling', $13, $14, $14)
       ON CONFLICT (chain_id, asset, authorizer, nonce) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        newId("x402", input.at.getTime()),
        input.chainId,
        input.asset,
        input.authorizer,
        input.nonce.toLowerCase(),
        input.payTo,
        input.amount,
        input.validAfter,
        input.validBefore,
        input.payeeAccountId,
        clip(input.resourceUrl ?? null, 2_048),
        input.requestHash,
        input.relayer ?? null,
        input.at,
      ],
    );
    return rows[0];
  }

  /** Record the broadcast transaction (the row stays `settling` until the receipt is seen). */
  async markSubmitted(id: string, txHash: Hex, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE x402_authorization SET tx_hash = $2, submitted_at = $3, updated_at = $3
        WHERE id = $1 AND status = 'settling'`,
      [id, txHash.toLowerCase(), at],
    );
  }

  async markSettled(
    id: string,
    txHash: Hex,
    blockNumber: bigint | null,
    at: Date,
  ): Promise<AuthorizationRow | undefined> {
    const { rows } = await this.db.query<AuthorizationRow>(
      `UPDATE x402_authorization
          SET status = 'settled', tx_hash = $2, block_number = $3, settled_at = $4, updated_at = $4,
              submitted_at = COALESCE(submitted_at, $4), failure_reason = NULL, failure_detail = NULL
        WHERE id = $1 AND status = 'settling'
        RETURNING ${COLUMNS}`,
      [id, txHash.toLowerCase(), blockNumber, at],
    );
    return rows[0] ?? (await this.findById(id));
  }

  async markFailed(
    id: string,
    reason: string,
    detail: string | null,
    at: Date,
    txHash?: Hex | null,
  ): Promise<AuthorizationRow | undefined> {
    const { rows } = await this.db.query<AuthorizationRow>(
      `UPDATE x402_authorization
          SET status = 'failed', failure_reason = $2, failure_detail = $3, updated_at = $4,
              tx_hash = COALESCE($5, tx_hash)
        WHERE id = $1 AND status = 'settling'
        RETURNING ${COLUMNS}`,
      [id, reason, clip(detail), at, txHash ? txHash.toLowerCase() : null],
    );
    return rows[0] ?? (await this.findById(id));
  }

  /** Note a problem on a row whose outcome is still unknown (it stays `settling`). */
  async noteDetail(id: string, detail: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE x402_authorization SET failure_detail = $2, updated_at = $3 WHERE id = $1 AND status = 'settling'`,
      [id, clip(detail), at],
    );
  }

  /** `settling` rows created before `before`, oldest first (for the stale-settlement sweep). */
  async listStaleSettling(chainId: number, before: Date, limit: number): Promise<AuthorizationRow[]> {
    const { rows } = await this.db.query<AuthorizationRow>(
      `SELECT ${COLUMNS} FROM x402_authorization
        WHERE status = 'settling' AND chain_id = $1 AND created_at < $2
        ORDER BY created_at LIMIT $3`,
      [chainId, before, limit],
    );
    return rows;
  }
}
