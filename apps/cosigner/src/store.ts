import {
  AgentBankError,
  canonicalJson,
  GENESIS_HASH,
  hashAuditRecord,
  type AuditRecord,
  type AuditRecordBody,
  type OwnerAuthorization,
  type RuleHit,
  type SessionScope,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Hex } from "viem";

/**
 * Every query the co-signer runs against its own database. Functions take a
 * `SqlClient`, which is either the pool or an open transaction. Timestamps
 * always come from the service clock. Addresses are stored lowercase.
 */

const lower = (value: string): string => value.toLowerCase();

// ------------------------------------------------------------------ bindings

/** Pin an org to its owner key on first sight; refuse a different owner later. */
export async function bindOrg(tx: SqlClient, orgId: string, ownerAddress: string, at: Date): Promise<void> {
  await tx.query(
    "INSERT INTO org_binding (org_id, owner_address, created_at) VALUES ($1, $2, $3) ON CONFLICT (org_id) DO NOTHING",
    [orgId, lower(ownerAddress), at],
  );
  const owner = await getOrgOwner(tx, orgId);
  if (owner !== lower(ownerAddress)) {
    throw new AgentBankError("forbidden", `${ownerAddress} is not the registered owner key of ${orgId}`);
  }
}

export async function getOrgOwner(tx: SqlClient, orgId: string): Promise<string | null> {
  const { rows } = await tx.query<{ owner_address: string }>(
    "SELECT owner_address FROM org_binding WHERE org_id = $1",
    [orgId],
  );
  return rows[0]?.owner_address ?? null;
}

/** Pin an agent to its org on first sight; refuse a different org later. */
export async function bindAgent(tx: SqlClient, agentId: string, orgId: string, at: Date): Promise<void> {
  await tx.query(
    "INSERT INTO agent_binding (agent_id, org_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO NOTHING",
    [agentId, orgId, at],
  );
  const org = await getAgentOrg(tx, agentId);
  if (org !== orgId) throw new AgentBankError("forbidden", `Agent ${agentId} belongs to another org`);
}

export async function getAgentOrg(tx: SqlClient, agentId: string): Promise<string | null> {
  const { rows } = await tx.query<{ org_id: string }>(
    "SELECT org_id FROM agent_binding WHERE agent_id = $1",
    [agentId],
  );
  return rows[0]?.org_id ?? null;
}

/**
 * Lock an agent for the rest of the transaction. Every decision that reads
 * and then extends the agent's spend history holds this lock, so concurrent
 * payments cannot jointly exceed a cap. Returns the agent's org, or `null`
 * for an agent the co-signer has never seen (nothing to lock).
 */
export async function lockAgent(tx: SqlClient, agentId: string): Promise<string | null> {
  const { rows } = await tx.query<{ org_id: string }>(
    "SELECT org_id FROM agent_binding WHERE agent_id = $1 FOR UPDATE",
    [agentId],
  );
  return rows[0]?.org_id ?? null;
}

export interface AccountBinding {
  account_id: string;
  agent_id: string;
  chain_id: number;
  address: string;
}

export async function getAccount(tx: SqlClient, accountId: string): Promise<AccountBinding | null> {
  const { rows } = await tx.query<AccountBinding>(
    "SELECT account_id, agent_id, chain_id, address FROM account_binding WHERE account_id = $1",
    [accountId],
  );
  return rows[0] ?? null;
}

export async function getAccountByAddress(
  tx: SqlClient,
  chainId: number,
  address: string,
): Promise<AccountBinding | null> {
  const { rows } = await tx.query<AccountBinding>(
    "SELECT account_id, agent_id, chain_id, address FROM account_binding WHERE chain_id = $1 AND address = $2",
    [chainId, lower(address)],
  );
  return rows[0] ?? null;
}

/** Pin an account id to its agent, chain and address on first sight. */
export async function bindAccount(
  tx: SqlClient,
  input: { accountId: string; agentId: string; chainId: number; address: string; at: Date },
): Promise<void> {
  await tx.query(
    `INSERT INTO account_binding (account_id, agent_id, chain_id, address, created_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [input.accountId, input.agentId, input.chainId, lower(input.address), input.at],
  );
  const row = await getAccount(tx, input.accountId);
  if (
    row === null ||
    row.agent_id !== input.agentId ||
    row.chain_id !== input.chainId ||
    row.address !== lower(input.address)
  ) {
    throw new AgentBankError(
      "forbidden",
      `Account ${input.accountId} (${input.address}) conflicts with an account the co-signer already knows`,
    );
  }
}

export async function getSpendKey(tx: SqlClient, accountId: string): Promise<string | null> {
  const { rows } = await tx.query<{ address: string }>(
    "SELECT address FROM spend_key_binding WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.address ?? null;
}

/** Pin an account's x402 spend key on first sight. Returns the pinned key. */
export async function bindSpendKey(
  tx: SqlClient,
  accountId: string,
  address: string,
  at: Date,
): Promise<string> {
  await tx.query(
    "INSERT INTO spend_key_binding (account_id, address, created_at) VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING",
    [accountId, lower(address), at],
  );
  return (await getSpendKey(tx, accountId)) ?? lower(address);
}

// ------------------------------------------------------------------ treasury & owner

export interface TreasuryRow {
  org_id: string;
  account_id: string;
  address: string;
  signed_by: string;
  set_at: Date;
}

const TREASURY_COLUMNS = "org_id, account_id, address, signed_by, set_at";

export async function getTreasury(tx: SqlClient, orgId: string): Promise<TreasuryRow | null> {
  const { rows } = await tx.query<TreasuryRow>(`SELECT ${TREASURY_COLUMNS} FROM treasury WHERE org_id = $1`, [
    orgId,
  ]);
  return rows[0] ?? null;
}

/** A treasury row holding this account id or this address (any org). */
export async function findTreasuryHolding(
  tx: SqlClient,
  accountId: string,
  address: string,
): Promise<TreasuryRow[]> {
  const { rows } = await tx.query<TreasuryRow>(
    `SELECT ${TREASURY_COLUMNS} FROM treasury WHERE account_id = $1 OR address = $2`,
    [accountId, lower(address)],
  );
  return rows;
}

export async function upsertTreasury(tx: SqlClient, row: TreasuryRow): Promise<void> {
  await tx.query(
    `INSERT INTO treasury (org_id, account_id, address, signed_by, set_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id) DO UPDATE SET account_id = EXCLUDED.account_id, address = EXCLUDED.address,
       signed_by = EXCLUDED.signed_by, set_at = EXCLUDED.set_at`,
    [row.org_id, row.account_id, lower(row.address), lower(row.signed_by), row.set_at],
  );
}

/** Replace an org's pinned owner key (voluntary rotation authorized by the current owner). */
export async function rotateOrgOwner(tx: SqlClient, orgId: string, newOwner: string): Promise<void> {
  await tx.query("UPDATE org_binding SET owner_address = $2 WHERE org_id = $1", [orgId, lower(newOwner)]);
}

// ------------------------------------------------------------------ sessions

export interface SessionRow {
  id: string;
  org_id: string;
  agent_id: string;
  account_id: string;
  chain_id: number;
  account_address: string;
  public_key: string;
  scope: SessionScope;
  owner_authorization: OwnerAuthorization;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

const SESSION_COLUMNS =
  "id, org_id, agent_id, account_id, chain_id, account_address, public_key, scope, owner_authorization, expires_at, revoked_at, created_at";

export async function getSession(tx: SqlClient, id: string): Promise<SessionRow | null> {
  const { rows } = await tx.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertSession(tx: SqlClient, row: Omit<SessionRow, "revoked_at">): Promise<void> {
  await tx.query(
    `INSERT INTO session (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11)`,
    [
      row.id,
      row.org_id,
      row.agent_id,
      row.account_id,
      row.chain_id,
      lower(row.account_address),
      lower(row.public_key),
      row.scope,
      row.owner_authorization,
      row.expires_at,
      row.created_at,
    ],
  );
}

/** Mark a session revoked. Returns false if it was already revoked. */
export async function revokeSessionRow(tx: SqlClient, id: string, at: Date): Promise<boolean> {
  const res = await tx.query("UPDATE session SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
    id,
    at,
  ]);
  return res.rowCount > 0;
}

export async function addRevocation(
  tx: SqlClient,
  kind: "session" | "mandate",
  id: string,
  at: Date,
): Promise<void> {
  await tx.query(
    "INSERT INTO revocation (kind, id, revoked_at) VALUES ($1, $2, $3) ON CONFLICT (kind, id) DO NOTHING",
    [kind, id, at],
  );
}

export async function isRevokedId(tx: SqlClient, kind: "session" | "mandate", id: string): Promise<boolean> {
  const { rows } = await tx.query("SELECT 1 FROM revocation WHERE kind = $1 AND id = $2", [kind, id]);
  return rows.length > 0;
}

// ------------------------------------------------------------------ mandates

export interface MandateRow {
  id: string;
  org_id: string;
  agent_id: string;
  chain_id: number;
  document: unknown;
  mandate_hash: string;
  signer: string;
  owner_authorization: OwnerAuthorization;
  expires_at: Date;
  revoked_at: Date | null;
  spent: bigint;
  occurrences: number;
  last_occurrence_at: Date | null;
  created_at: Date;
}

const MANDATE_COLUMNS =
  "id, org_id, agent_id, chain_id, document, mandate_hash, signer, owner_authorization, expires_at, revoked_at, spent, occurrences, last_occurrence_at, created_at";

export async function getMandate(tx: SqlClient, id: string): Promise<MandateRow | null> {
  const { rows } = await tx.query<MandateRow>(`SELECT ${MANDATE_COLUMNS} FROM mandate WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertMandate(
  tx: SqlClient,
  row: Pick<
    MandateRow,
    | "id"
    | "org_id"
    | "agent_id"
    | "chain_id"
    | "document"
    | "mandate_hash"
    | "signer"
    | "owner_authorization"
    | "expires_at"
    | "created_at"
  >,
): Promise<void> {
  await tx.query(
    `INSERT INTO mandate (id, org_id, agent_id, chain_id, document, mandate_hash, signer, owner_authorization, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.id,
      row.org_id,
      row.agent_id,
      row.chain_id,
      row.document as object,
      row.mandate_hash,
      lower(row.signer),
      row.owner_authorization,
      row.expires_at,
      row.created_at,
    ],
  );
}

export async function revokeMandateRow(tx: SqlClient, id: string, at: Date): Promise<boolean> {
  const res = await tx.query("UPDATE mandate SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [
    id,
    at,
  ]);
  return res.rowCount > 0;
}

/** Recompute a mandate's usage from its spend records (reserved + settled). */
export async function refreshMandateUsage(tx: SqlClient, mandateId: string): Promise<void> {
  await tx.query(
    `UPDATE mandate m SET
       spent = u.spent, occurrences = u.occurrences, last_occurrence_at = u.last_at
     FROM (
       SELECT COALESCE(SUM(CASE status WHEN 'settled' THEN COALESCE(settled_amount, amount) ELSE amount END), 0)::bigint AS spent,
              COUNT(*) FILTER (WHERE amount > 0)::integer AS occurrences,
              MAX(reserved_at) FILTER (WHERE amount > 0) AS last_at
       FROM spend WHERE mandate_id = $1 AND status <> 'released'
     ) u
     WHERE m.id = $1`,
    [mandateId],
  );
}

// ------------------------------------------------------------------ policies

export type ChangeKindRow = "initial" | "tighten" | "loosen" | "mixed" | "unchanged";

export interface PolicyRow {
  agent_id: string;
  version: number;
  document: unknown;
  policy_hash: string;
  change_kind: ChangeKindRow;
  effective_at: Date;
  signed_by: string | null;
  owner_authorization: OwnerAuthorization | null;
  cancelled_at: Date | null;
  cancelled_by: number | null;
  created_at: Date;
}

const POLICY_COLUMNS =
  "agent_id, version, document, policy_hash, change_kind, effective_at, signed_by, owner_authorization, cancelled_at, cancelled_by, created_at";

/** The version in force at `at`: the highest non-cancelled version already effective. */
export async function currentPolicy(tx: SqlClient, agentId: string, at: Date): Promise<PolicyRow | null> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM policy_version
     WHERE agent_id = $1 AND cancelled_at IS NULL AND effective_at <= $2
     ORDER BY version DESC LIMIT 1`,
    [agentId, at],
  );
  return rows[0] ?? null;
}

/** A version waiting out its delay at `at` (at most one exists). */
export async function pendingPolicy(tx: SqlClient, agentId: string, at: Date): Promise<PolicyRow | null> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM policy_version
     WHERE agent_id = $1 AND cancelled_at IS NULL AND effective_at > $2
     ORDER BY version DESC LIMIT 1`,
    [agentId, at],
  );
  return rows[0] ?? null;
}

export async function getPolicyVersion(
  tx: SqlClient,
  agentId: string,
  version: number,
): Promise<PolicyRow | null> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM policy_version WHERE agent_id = $1 AND version = $2`,
    [agentId, version],
  );
  return rows[0] ?? null;
}

export async function latestPolicyVersion(tx: SqlClient, agentId: string): Promise<number> {
  const { rows } = await tx.query<{ v: number }>(
    "SELECT COALESCE(MAX(version), 0)::integer AS v FROM policy_version WHERE agent_id = $1",
    [agentId],
  );
  return rows[0]?.v ?? 0;
}

/** Cancel every version still pending at `at`; returns the cancelled version numbers. */
export async function cancelPendingPolicies(
  tx: SqlClient,
  agentId: string,
  at: Date,
  byVersion: number,
): Promise<number[]> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE policy_version SET cancelled_at = $2, cancelled_by = $3
     WHERE agent_id = $1 AND cancelled_at IS NULL AND effective_at > $2
     RETURNING version`,
    [agentId, at, byVersion],
  );
  return rows.map((r) => r.version);
}

export async function insertPolicyVersion(
  tx: SqlClient,
  row: Omit<PolicyRow, "cancelled_at" | "cancelled_by">,
): Promise<void> {
  await tx.query(
    `INSERT INTO policy_version (agent_id, version, document, policy_hash, change_kind, effective_at, signed_by, owner_authorization, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.agent_id,
      row.version,
      row.document as object,
      row.policy_hash,
      row.change_kind,
      row.effective_at,
      row.signed_by === null ? null : lower(row.signed_by),
      row.owner_authorization,
      row.created_at,
    ],
  );
}

// ------------------------------------------------------------------ owner authorizations

export interface AuthorizationUse {
  digest: string;
  action: string;
  subject: string;
  payload_hash: string;
  signer: string;
  ref: string;
  used_at: Date;
}

export async function getAuthorizationUse(tx: SqlClient, digest: string): Promise<AuthorizationUse | null> {
  const { rows } = await tx.query<AuthorizationUse>(
    "SELECT digest, action, subject, payload_hash, signer, ref, used_at FROM owner_authorization_use WHERE digest = $1",
    [digest],
  );
  return rows[0] ?? null;
}

export async function insertAuthorizationUse(tx: SqlClient, use: AuthorizationUse): Promise<void> {
  await tx.query(
    `INSERT INTO owner_authorization_use (digest, action, subject, payload_hash, signer, ref, used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [use.digest, use.action, use.subject, use.payload_hash, lower(use.signer), use.ref, use.used_at],
  );
}

// ------------------------------------------------------------------ freezes

export type FreezeScope = "org" | "agent" | "session";

export interface FreezeRow {
  id: bigint;
  scope: FreezeScope;
  target_id: string;
  reason: string;
  frozen_at: Date;
  unfreeze_requested_at: Date | null;
  unfreeze_effective_at: Date | null;
  unfreeze_reason: string | null;
  unfreeze_signed_by: string | null;
}

const FREEZE_COLUMNS =
  "id, scope, target_id, reason, frozen_at, unfreeze_requested_at, unfreeze_effective_at, unfreeze_reason, unfreeze_signed_by";

/** The freeze in force on a target at `at` (including one whose unfreeze is still pending). */
export async function activeFreeze(
  tx: SqlClient,
  scope: FreezeScope,
  targetId: string,
  at: Date,
  forUpdate = false,
): Promise<FreezeRow | null> {
  const { rows } = await tx.query<FreezeRow>(
    `SELECT ${FREEZE_COLUMNS} FROM freeze_episode
     WHERE scope = $1 AND target_id = $2 AND frozen_at <= $3
       AND (unfreeze_effective_at IS NULL OR unfreeze_effective_at > $3)
     ORDER BY id DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [scope, targetId, at],
  );
  return rows[0] ?? null;
}

/** Which of the given targets are frozen at `at`. */
export async function frozenTargets(
  tx: SqlClient,
  targets: { scope: FreezeScope; id: string }[],
  at: Date,
): Promise<Set<string>> {
  if (targets.length === 0) return new Set();
  const keys = targets.map((t) => `${t.scope}:${t.id}`);
  const { rows } = await tx.query<{ key: string }>(
    `SELECT DISTINCT scope || ':' || target_id AS key FROM freeze_episode
     WHERE scope || ':' || target_id = ANY($1::text[]) AND frozen_at <= $2
       AND (unfreeze_effective_at IS NULL OR unfreeze_effective_at > $2)`,
    [keys, at],
  );
  return new Set(rows.map((r) => r.key));
}

/**
 * Open a freeze episode. A concurrent freeze of the same target may win the
 * race; then that episode is returned (the target is frozen either way).
 */
export async function insertFreeze(
  tx: SqlClient,
  scope: FreezeScope,
  targetId: string,
  reason: string,
  at: Date,
): Promise<FreezeRow> {
  const { rows } = await tx.query<FreezeRow>(
    `INSERT INTO freeze_episode (scope, target_id, reason, frozen_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, target_id) WHERE unfreeze_requested_at IS NULL DO NOTHING
     RETURNING ${FREEZE_COLUMNS}`,
    [scope, targetId, reason, at],
  );
  if (rows[0]) return rows[0];
  const existing = await tx.query<FreezeRow>(
    `SELECT ${FREEZE_COLUMNS} FROM freeze_episode
     WHERE scope = $1 AND target_id = $2 AND unfreeze_requested_at IS NULL FOR UPDATE`,
    [scope, targetId],
  );
  if (!existing.rows[0]) throw new Error("freeze episode vanished during insert");
  return existing.rows[0];
}

export async function cancelUnfreeze(tx: SqlClient, id: bigint): Promise<void> {
  await tx.query(
    `UPDATE freeze_episode SET unfreeze_requested_at = NULL, unfreeze_effective_at = NULL,
       unfreeze_reason = NULL, unfreeze_signed_by = NULL WHERE id = $1`,
    [id],
  );
}

export async function scheduleUnfreeze(
  tx: SqlClient,
  id: bigint,
  input: { requestedAt: Date; effectiveAt: Date; reason: string; signedBy: string },
): Promise<void> {
  await tx.query(
    `UPDATE freeze_episode SET unfreeze_requested_at = $2, unfreeze_effective_at = $3,
       unfreeze_reason = $4, unfreeze_signed_by = $5 WHERE id = $1`,
    [id, input.requestedAt, input.effectiveAt, input.reason, lower(input.signedBy)],
  );
}

export async function getFreeze(tx: SqlClient, id: bigint): Promise<FreezeRow | null> {
  const { rows } = await tx.query<FreezeRow>(`SELECT ${FREEZE_COLUMNS} FROM freeze_episode WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ spend history

export type SpendStatus = "reserved" | "settled" | "released";

export interface SpendRow {
  payment_id: string;
  source: "cosign" | "x402";
  /** What the operation did (`COSIGN_ACTIONS`, or `x402`). */
  action: string;
  org_id: string;
  agent_id: string;
  account_id: string;
  session_id: string | null;
  mandate_id: string | null;
  kind: string;
  counterparty_address: string | null;
  counterparty_agent_id: string | null;
  counterparty_erc8004_id: string | null;
  counterparty_x402_domain: string | null;
  /** Payment counted against policy caps; 0 for actions that move nothing out. */
  amount: bigint;
  fee: bigint;
  /** Savings sweep to the org treasury carried by the operation (not policy spend). */
  savings: bigint;
  /** Everything the operation moves out of the account. */
  outflow: bigint;
  status: SpendStatus;
  settled_amount: bigint | null;
  request_hash: string;
  user_op_hash: string | null;
  signature: string | null;
  decision_id: string;
  reserved_at: Date;
  settled_at: Date | null;
  released_at: Date | null;
}

const SPEND_COLUMNS =
  "payment_id, source, action, org_id, agent_id, account_id, session_id, mandate_id, kind, counterparty_address, counterparty_agent_id, counterparty_erc8004_id, counterparty_x402_domain, amount, fee, savings, outflow, status, settled_amount, request_hash, user_op_hash, signature, decision_id, reserved_at, settled_at, released_at";

export async function getSpend(
  tx: SqlClient,
  paymentId: string,
  forUpdate = false,
): Promise<SpendRow | null> {
  const { rows } = await tx.query<SpendRow>(
    `SELECT ${SPEND_COLUMNS} FROM spend WHERE payment_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [paymentId],
  );
  return rows[0] ?? null;
}

export async function findSpendByUserOp(tx: SqlClient, userOpHash: string): Promise<SpendRow | null> {
  const { rows } = await tx.query<SpendRow>(
    `SELECT ${SPEND_COLUMNS} FROM spend WHERE user_op_hash = $1 LIMIT 1`,
    [lower(userOpHash)],
  );
  return rows[0] ?? null;
}

export async function insertSpend(
  tx: SqlClient,
  row: Omit<SpendRow, "status" | "settled_amount" | "settled_at" | "released_at">,
): Promise<void> {
  await tx.query(
    `INSERT INTO spend (payment_id, source, action, org_id, agent_id, account_id, session_id, mandate_id, kind,
       counterparty_address, counterparty_agent_id, counterparty_erc8004_id, counterparty_x402_domain,
       amount, fee, savings, outflow, status, request_hash, user_op_hash, signature, decision_id, reserved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'reserved', $18, $19, $20, $21, $22)`,
    [
      row.payment_id,
      row.source,
      row.action,
      row.org_id,
      row.agent_id,
      row.account_id,
      row.session_id,
      row.mandate_id,
      row.kind,
      row.counterparty_address === null ? null : lower(row.counterparty_address),
      row.counterparty_agent_id,
      row.counterparty_erc8004_id,
      row.counterparty_x402_domain,
      row.amount,
      row.fee,
      row.savings,
      row.outflow,
      row.request_hash,
      row.user_op_hash === null ? null : lower(row.user_op_hash),
      row.signature,
      row.decision_id,
      row.reserved_at,
    ],
  );
}

export async function settleSpend(
  tx: SqlClient,
  paymentId: string,
  settledAmount: bigint | null,
  at: Date,
): Promise<void> {
  await tx.query(
    "UPDATE spend SET status = 'settled', settled_amount = $2, settled_at = $3, released_at = NULL WHERE payment_id = $1",
    [paymentId, settledAmount, at],
  );
}

export async function releaseSpend(tx: SqlClient, paymentId: string, at: Date): Promise<void> {
  await tx.query("UPDATE spend SET status = 'released', released_at = $2 WHERE payment_id = $1", [
    paymentId,
    at,
  ]);
}

/** Identifiers a payment's counterparty is known by (normalized). */
export interface CounterpartyKeys {
  address: string | null;
  agentId: string | null;
  erc8004Id: string | null;
  x402Domain: string | null;
}

export interface SpendWindows {
  spentLastDay: bigint;
  spentLastWeek: bigint;
  spentLastMonth: bigint;
  countLastMinute: number;
  countLastHour: number;
  countLastDay: number;
  counterpartySpentLastDay: bigint;
  counterpartySpentLastMonth: bigint;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The agent's own spend in rolling windows ending at `now` (ADR 0010): sums
 * of reserved and settled payments (released ones no longer count), counts of
 * every payment the co-signer authorized (released included, which is the
 * conservative choice for velocity), and spend to the counterparty under any
 * of its identifiers.
 */
export async function spendWindows(
  tx: SqlClient,
  agentId: string,
  now: Date,
  cp: CounterpartyKeys,
): Promise<SpendWindows> {
  const t = now.getTime();
  const { rows } = await tx.query<{
    day: bigint;
    week: bigint;
    month: bigint;
    c_min: bigint;
    c_hour: bigint;
    c_day: bigint;
    cp_day: bigint;
    cp_month: bigint;
  }>(
    `SELECT
       COALESCE(SUM(eff) FILTER (WHERE reserved_at > $2), 0)::bigint AS day,
       COALESCE(SUM(eff) FILTER (WHERE reserved_at > $3), 0)::bigint AS week,
       COALESCE(SUM(eff), 0)::bigint AS month,
       COUNT(*) FILTER (WHERE reserved_at > $4 AND amount > 0)::bigint AS c_min,
       COUNT(*) FILTER (WHERE reserved_at > $5 AND amount > 0)::bigint AS c_hour,
       COUNT(*) FILTER (WHERE reserved_at > $2 AND amount > 0)::bigint AS c_day,
       COALESCE(SUM(eff) FILTER (WHERE reserved_at > $2 AND cp), 0)::bigint AS cp_day,
       COALESCE(SUM(eff) FILTER (WHERE cp), 0)::bigint AS cp_month
     FROM (
       SELECT reserved_at, amount,
              CASE status WHEN 'reserved' THEN amount
                          WHEN 'settled' THEN COALESCE(settled_amount, amount)
                          ELSE 0 END AS eff,
              COALESCE(counterparty_address = $7 OR counterparty_agent_id = $8
                       OR counterparty_erc8004_id = $9 OR counterparty_x402_domain = $10, false) AS cp
       FROM spend WHERE agent_id = $1 AND reserved_at > $6 AND reserved_at <= $11
     ) s`,
    [
      agentId,
      new Date(t - DAY_MS),
      new Date(t - 7 * DAY_MS),
      new Date(t - MINUTE_MS),
      new Date(t - HOUR_MS),
      new Date(t - 30 * DAY_MS),
      cp.address,
      cp.agentId,
      cp.erc8004Id,
      cp.x402Domain,
      now,
    ],
  );
  const r = rows[0];
  return {
    spentLastDay: r?.day ?? 0n,
    spentLastWeek: r?.week ?? 0n,
    spentLastMonth: r?.month ?? 0n,
    countLastMinute: Number(r?.c_min ?? 0n),
    countLastHour: Number(r?.c_hour ?? 0n),
    countLastDay: Number(r?.c_day ?? 0n),
    counterpartySpentLastDay: r?.cp_day ?? 0n,
    counterpartySpentLastMonth: r?.cp_month ?? 0n,
  };
}

/** Everything a session's operations moved out in the last 24 h (amount + fee + sweeps). */
export async function sessionOutflowLastDay(tx: SqlClient, sessionId: string, now: Date): Promise<bigint> {
  const { rows } = await tx.query<{ total: bigint }>(
    `SELECT COALESCE(SUM(CASE status WHEN 'released' THEN 0
                                     WHEN 'settled' THEN outflow - amount + COALESCE(settled_amount, amount)
                                     ELSE outflow END), 0)::bigint AS total
     FROM spend WHERE session_id = $1 AND reserved_at > $2 AND reserved_at <= $3`,
    [sessionId, new Date(now.getTime() - DAY_MS), now],
  );
  return rows[0]?.total ?? 0n;
}

// ------------------------------------------------------------------ counterparties

export type IdType = "address" | "agent_id" | "erc8004_id" | "x402_domain";

export function counterpartyIds(cp: CounterpartyKeys): { type: IdType; value: string }[] {
  const out: { type: IdType; value: string }[] = [];
  if (cp.address !== null) out.push({ type: "address", value: cp.address });
  if (cp.agentId !== null) out.push({ type: "agent_id", value: cp.agentId });
  if (cp.erc8004Id !== null) out.push({ type: "erc8004_id", value: cp.erc8004Id });
  if (cp.x402Domain !== null) out.push({ type: "x402_domain", value: cp.x402Domain });
  return out;
}

/**
 * When the co-signer first saw this counterparty: `null` if any of its
 * identifiers is new (a new payee address paired with a familiar agent id is
 * still a new payee), otherwise the latest first-seen time of its identifiers.
 */
export async function counterpartyFirstSeen(
  tx: SqlClient,
  agentId: string,
  cp: CounterpartyKeys,
): Promise<Date | null> {
  const ids = counterpartyIds(cp);
  if (ids.length === 0) return null;
  const { rows } = await tx.query<{ id_type: string; value: string; first_seen_at: Date }>(
    `SELECT id_type, value, first_seen_at FROM counterparty_seen
     WHERE agent_id = $1 AND id_type || ':' || value = ANY($2::text[])`,
    [agentId, ids.map((i) => `${i.type}:${i.value}`)],
  );
  if (rows.length < ids.length) return null;
  let latest: Date | null = null;
  for (const r of rows) if (latest === null || r.first_seen_at > latest) latest = r.first_seen_at;
  return latest;
}

export async function recordCounterpartySeen(
  tx: SqlClient,
  agentId: string,
  cp: CounterpartyKeys,
  at: Date,
): Promise<void> {
  for (const id of counterpartyIds(cp)) {
    await tx.query(
      `INSERT INTO counterparty_seen (agent_id, id_type, value, first_seen_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, id_type, value) DO NOTHING`,
      [agentId, id.type, id.value, at],
    );
  }
}

// ------------------------------------------------------------------ decisions

export interface DecisionRow {
  id: string;
  source: "evaluate" | "cosign" | "x402";
  payment_id: string | null;
  org_id: string;
  agent_id: string;
  outcome: string;
  rule_hits: readonly RuleHit[];
  approvers_required: number;
  policy_version: number;
  evaluated_at: Date;
  retry_at: Date | null;
}

export async function insertDecision(tx: SqlClient, row: DecisionRow): Promise<void> {
  await tx.query(
    `INSERT INTO decision (id, source, payment_id, org_id, agent_id, outcome, rule_hits, approvers_required, policy_version, evaluated_at, retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      row.id,
      row.source,
      row.payment_id,
      row.org_id,
      row.agent_id,
      row.outcome,
      JSON.stringify(row.rule_hits),
      row.approvers_required,
      row.policy_version,
      row.evaluated_at,
      row.retry_at,
    ],
  );
}

export async function getDecision(tx: SqlClient, id: string): Promise<DecisionRow | null> {
  const { rows } = await tx.query<DecisionRow>(
    `SELECT id, source, payment_id, org_id, agent_id, outcome, rule_hits, approvers_required, policy_version, evaluated_at, retry_at
     FROM decision WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ audit log

export interface AuditEntry {
  at: Date;
  actor: string;
  action: string;
  subject: string;
  payload: unknown;
}

/**
 * Append one record to the hash chain. Locks the chain head for the rest of
 * the transaction, so callers append last, just before committing.
 */
export async function appendAudit(tx: SqlClient, entry: AuditEntry): Promise<AuditRecord> {
  const { rows } = await tx.query<{ seq: bigint; hash: string }>(
    "SELECT seq, hash FROM audit_head WHERE id = 1 FOR UPDATE",
  );
  const head = rows[0];
  if (!head) throw new Error("audit head is missing");
  const payloadJson = canonicalJson(entry.payload ?? null);
  const body: AuditRecordBody = {
    seq: Number(head.seq) + 1,
    at: entry.at.toISOString(),
    actor: entry.actor,
    action: entry.action,
    subject: entry.subject,
    payload: JSON.parse(payloadJson) as unknown,
  };
  const prevHash = head.hash as Hex;
  const hash = hashAuditRecord(prevHash, body);
  await tx.query(
    `INSERT INTO audit_log (seq, at, actor, action, subject, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [body.seq, entry.at, body.actor, body.action, body.subject, payloadJson, prevHash, hash],
  );
  await tx.query("UPDATE audit_head SET seq = $1, hash = $2 WHERE id = 1", [body.seq, hash]);
  return { ...body, prevHash, hash };
}

interface AuditDbRow {
  seq: bigint;
  at: Date;
  actor: string;
  action: string;
  subject: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

function toAuditRecord(r: AuditDbRow): AuditRecord {
  return {
    seq: Number(r.seq),
    at: new Date(r.at).toISOString(),
    actor: r.actor,
    action: r.action,
    subject: r.subject,
    payload: JSON.parse(r.payload) as unknown,
    prevHash: r.prev_hash as Hex,
    hash: r.hash as Hex,
  };
}

export async function listAudit(db: SqlClient, afterSeq: number, limit: number): Promise<AuditRecord[]> {
  const { rows } = await db.query<AuditDbRow>(
    `SELECT seq, at, actor, action, subject, payload, prev_hash, hash FROM audit_log
     WHERE seq > $1 ORDER BY seq LIMIT $2`,
    [afterSeq, limit],
  );
  return rows.map(toAuditRecord);
}

export interface AuditVerification {
  ok: boolean;
  records: number;
  /** Sequence number of the first record that does not verify (or where the head disagrees). */
  brokenAt: number | null;
  head: { seq: number; hash: string };
}

/**
 * Verify the whole chain page by page: each record's sequence, link and hash,
 * and that the head row points at the last record.
 */
export async function verifyAuditLog(db: SqlClient, pageSize = 1000): Promise<AuditVerification> {
  const headRows = await db.query<{ seq: bigint; hash: string }>(
    "SELECT seq, hash FROM audit_head WHERE id = 1",
  );
  const head = { seq: Number(headRows.rows[0]?.seq ?? -1), hash: headRows.rows[0]?.hash ?? "" };
  let prevHash: string = GENESIS_HASH;
  let prevSeq = 0;
  let count = 0;
  for (;;) {
    const page = await listAudit(db, prevSeq, pageSize);
    for (const r of page) {
      const { prevHash: link, hash, ...body } = r;
      if (r.seq !== prevSeq + 1 || link !== prevHash || hashAuditRecord(link, body) !== hash) {
        return { ok: false, records: count, brokenAt: r.seq, head };
      }
      prevHash = hash;
      prevSeq = r.seq;
      count += 1;
    }
    if (page.length < pageSize) break;
  }
  if (head.seq !== prevSeq || head.hash !== prevHash) {
    return { ok: false, records: count, brokenAt: prevSeq + 1, head };
  }
  return { ok: true, records: count, brokenAt: null, head };
}
