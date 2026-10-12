import { simulatedAttesterAccount } from "@agentbank/chain";
import { AgentBankError, isAgentBankError } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { compilePolicy } from "@agentbank/policy";
import {
  ATTRIBUTES,
  ClaimsTree,
  leafHash,
  MAX_U64,
  SNARK_SCALAR_FIELD,
  toBytes32,
  type Attribute,
  type AttributeValues,
} from "@agentbank/proofs";
import { encodeAbiParameters, getAddress, keccak256, type Address } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { KycStatus, ProofLeafRow, ProofReservationRow, ProofRootRow } from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import { serializeProofReservation } from "../serializers";
import { audit } from "./audit";
import { EXTERNAL_VOLUME_KINDS } from "./billing";
import { emitEvent } from "./events";
import { pocket } from "./ledger-refs";

/**
 * Private proofs (docs/private-proofs.md, ADR 0014): what the API attests about an agent, the
 * attested-facts tree and the bookkeeping shared by the `/v1/proofs` handlers and the
 * `proofs-roots` / `proofs-reservations` jobs. The cryptography (Poseidon tree, leaf hash,
 * scopes, Groth16) is `@agentbank/proofs`; nothing here reimplements it.
 */

const USDC_DOLLAR = 1_000_000n;
const SECONDS_PER_DAY = 86_400n;

/** `403 feature_gated` unless `FEATURE_PRIVATE_PROOFS` is on. */
export function assertProofsEnabled(deps: AppDeps): void {
  if (!deps.config.features.privateProofs) {
    throw new AgentBankError("feature_gated", "Private proofs are not enabled on this deployment");
  }
}

/**
 * The attester that publishes and revokes roots: `PROOFS_ATTESTER_KEY` (wired as `deps.attester`),
 * or the public simulated attester on the simulated chain. It can move no funds.
 */
export function proofAttester(deps: AppDeps): LocalAccount {
  if (deps.attester) return deps.attester;
  if (deps.config.chain.name === "simulated") return simulatedAttesterAccount(deps.config.chain.id);
  throw new AgentBankError(
    "invalid_state",
    `Private-proof roots cannot be published on ${deps.config.chain.name}: PROOFS_ATTESTER_KEY is not configured`,
    { reason: "attester_not_configured" },
  );
}

/** `AgentAttestationRegistry` on the configured chain (checksummed), or null when not deployed. */
export function registryAddress(deps: AppDeps): Address | null {
  const registry = deps.chain.contracts.attestationRegistry;
  return registry ? getAddress(registry) : null;
}

/** `AgentClaimsVerifier` on the configured chain (checksummed), or null when not deployed. */
export function claimsVerifierAddress(deps: AppDeps): Address | null {
  const verifier = deps.chain.contracts.claimsVerifier;
  return verifier ? getAddress(verifier) : null;
}

// ---------------------------------------------------------------- the dirty flag

/**
 * Ask the `proofs-roots` job for a new root. `narrowing` (disabling, removing a class, a new
 * identity commitment, a freeze, an early release) also revokes every older root still valid once
 * the new one lands. Call inside the transaction that makes the change.
 */
export async function markProofTreeDirty(
  db: SqlClient,
  chainId: number,
  options: { narrowing: boolean },
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO proof_tree_state (chain_id, dirty, narrowing, dirty_since, version, updated_at)
     VALUES ($1, true, $2, $3, 1, $3)
     ON CONFLICT (chain_id) DO UPDATE SET dirty = true,
       narrowing = proof_tree_state.narrowing OR EXCLUDED.narrowing,
       dirty_since = COALESCE(proof_tree_state.dirty_since, EXCLUDED.dirty_since),
       version = proof_tree_state.version + 1,
       updated_at = EXCLUDED.updated_at`,
    [chainId, options.narrowing, now],
  );
}

// ---------------------------------------------------------------- the tree

/**
 * The trailing leaf of every tree: keccak256(abi.encode("agentbank.proofs.epoch-salt.v1",
 * chainId, epoch)) mod r. The registry refuses a root published before, and an unchanged set of
 * facts hashes to the same tree, so each epoch's tree carries this public, unprovable leaf (no one
 * knows a Poseidon preimage of it). It is not counted in `leaf_count` (the anonymity set).
 */
export function epochSaltLeaf(chainId: number, epoch: bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "uint64" }],
    ["agentbank.proofs.epoch-salt.v1", BigInt(chainId), epoch],
  );
  return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

/** The tree of an epoch: its attested leaves in order, then the epoch salt. */
export function buildClaimsTree(chainId: number, epoch: bigint, leaves: readonly bigint[]): ClaimsTree {
  return new ClaimsTree([...leaves, epochSaltLeaf(chainId, epoch)]);
}

const TREE_CACHE_SIZE = 16;
const treeCache = new Map<string, ClaimsTree>();

/**
 * The tree of a stored root, rebuilt from `proof_leaf` and kept in a small LRU (keyed by chain
 * and root, which identify the leaves). Throws `internal` if the leaves no longer hash to it.
 */
export async function treeOfRoot(db: SqlClient, root: ProofRootRow): Promise<ClaimsTree> {
  const key = `${root.chain_id}:${root.root}`;
  const cached = treeCache.get(key);
  if (cached) {
    treeCache.delete(key);
    treeCache.set(key, cached);
    return cached;
  }
  const rows = await all<Pick<ProofLeafRow, "leaf">>(
    db,
    "SELECT leaf FROM proof_leaf WHERE chain_id = $1 AND epoch = $2 ORDER BY leaf_index",
    [root.chain_id, root.epoch],
  );
  if (rows.length !== root.leaf_count) {
    throw new AgentBankError("not_found", "The leaves of this root were pruned", { reason: "root_pruned" });
  }
  const tree = buildClaimsTree(
    root.chain_id,
    root.epoch,
    rows.map((r) => BigInt(r.leaf)),
  );
  if (toBytes32(tree.root) !== root.root) {
    throw new AgentBankError("internal", "Stored leaves do not hash to the root");
  }
  treeCache.set(key, tree);
  while (treeCache.size > TREE_CACHE_SIZE) {
    const oldest = treeCache.keys().next().value as string;
    treeCache.delete(oldest);
  }
  return tree;
}

// ---------------------------------------------------------------- attested facts

/** An account in the tree: an active agent's account on the chain, proofs enabled, identity enrolled. */
export interface EligibleAccount {
  account_id: string;
  agent_id: string;
  org_id: string;
  address: string;
  created_at: Date;
  identity_commitment: string;
  disclosure_mask: number;
  org_kind: "individual" | "company";
  kyc_status: KycStatus;
}

/** One leaf to attest: the base leaf (no reservation) or a reservation leaf. */
export interface LeafInput {
  accountId: string;
  reservationId: string | null;
  attributes: AttributeValues;
  disclosureMask: number;
  leaf: bigint;
}

const clampU64 = (value: bigint): bigint => (value < 0n ? 0n : value > MAX_U64 ? MAX_U64 : value);
const floorTo = (value: bigint, unit: bigint): bigint => (value / unit) * unit;
const unix = (at: Date): bigint => BigInt(Math.floor(at.getTime() / 1000));

/** 0 none, 1 verified individual, 2 verified company (`kyc_status = 'approved'`, by `org.kind`). */
export function principalVerification(kycStatus: KycStatus, kind: "individual" | "company"): bigint {
  if (kycStatus !== "approved") return 0n;
  return kind === "company" ? 2n : 1n;
}

/** A policy cap as attested: uncapped (null) is 2^64 − 1. */
function capOf(value: bigint | null): bigint {
  return value === null ? MAX_U64 : clampU64(value);
}

/**
 * Accounts that belong in the tree at `now`: role agent on `chainId`, agent and org active (an
 * unfreeze whose delay has elapsed counts as active, as for writes), proofs enabled, identity
 * enrolled. Ordered by account id (code point order, as the tree is).
 */
export async function eligibleAccounts(
  db: SqlClient,
  chainId: number,
  now: Date,
): Promise<EligibleAccount[]> {
  const rows = await all<EligibleAccount>(
    db,
    `SELECT a.id AS account_id, a.agent_id, a.org_id, a.address, a.created_at, i.identity_commitment,
            s.disclosure_mask, o.kind AS org_kind, o.kyc_status
       FROM account a
       JOIN agent g ON g.id = a.agent_id
       JOIN org o ON o.id = a.org_id
       JOIN proof_settings s ON s.agent_id = a.agent_id AND s.enabled
       JOIN proof_identity i ON i.account_id = a.id
      WHERE a.chain_id = $1 AND a.role = 'agent'
        AND (g.status = 'active' OR (g.pending_unfreeze_at IS NOT NULL AND g.pending_unfreeze_at <= $2))
        AND (o.status = 'active' OR (o.pending_unfreeze_at IS NOT NULL AND o.pending_unfreeze_at <= $2))`,
    [chainId, now],
  );
  return rows.sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));
}

function countMap(rows: { account_id: string; n: bigint | null }[]): Map<string, bigint> {
  return new Map(rows.map((r) => [r.account_id, r.n ?? 0n]));
}

/**
 * The 13 attributes of each account's base leaf (reservation attributes 0), exactly as the
 * design's table defines them, in raw units (USDC minor units, unix seconds), as bigints.
 */
export async function attestAccounts(
  deps: Pick<AppDeps, "db" | "ledger" | "logger">,
  accounts: readonly EligibleAccount[],
  now: Date,
): Promise<Map<string, Record<Attribute, bigint>>> {
  const out = new Map<string, Record<Attribute, bigint>>();
  if (accounts.length === 0) return out;
  const db = deps.db;
  const ids = accounts.map((a) => a.account_id);
  const agentIds = [...new Set(accounts.map((a) => a.agent_id))];
  const kinds = [...EXTERNAL_VOLUME_KINDS];

  const policies = await all<{ agent_id: string; version: number; rules_json: unknown }>(
    db,
    `SELECT DISTINCT ON (agent_id) agent_id, version, rules_json FROM policy
      WHERE agent_id = ANY($1::text[]) AND effective_at <= $2
      ORDER BY agent_id, version DESC`,
    [agentIds, now],
  );
  const limits = new Map<string, { perTx: bigint; perDay: bigint }>();
  for (const p of policies) {
    try {
      const compiled = compilePolicy(p.rules_json as never, Number(p.version));
      limits.set(p.agent_id, { perTx: capOf(compiled.limits.perTx), perDay: capOf(compiled.limits.perDay) });
    } catch (error) {
      // A stored policy always compiled when it was written; fail closed (nothing can be spent).
      deps.logger.warn({ err: error, agentId: p.agent_id }, "policy does not compile; attesting limits as 0");
    }
  }

  const payments = await all<{ account_id: string; n: bigint; volume: bigint | null }>(
    db,
    `SELECT account_id, count(*)::bigint AS n, sum(amount)::bigint AS volume FROM payment
      WHERE account_id = ANY($1::text[]) AND status = 'settled' AND kind = ANY($2::text[])
      GROUP BY account_id`,
    [ids, kinds],
  );
  const paymentStats = new Map(payments.map((r) => [r.account_id, r]));

  // Escrows paid to an account (matched by its address on the payer's chain).
  const escrowsCompleted = countMap(
    await all<{ account_id: string; n: bigint }>(
      db,
      `SELECT a.id AS account_id, count(*)::bigint AS n
         FROM escrow e
         JOIN account pa ON pa.id = e.payer_account_id
         JOIN account a ON lower(a.address) = lower(e.payee_address) AND a.chain_id = pa.chain_id
        WHERE a.id = ANY($1::text[]) AND e.status = 'released'
        GROUP BY a.id`,
      [ids],
    ),
  );

  // Resolved disputes in which the account (payer or payee) received less than half the escrow.
  const disputesLost = countMap(
    await all<{ account_id: string; n: bigint }>(
      db,
      `SELECT a.id AS account_id, count(*)::bigint AS n
         FROM escrow e
         JOIN account pa ON pa.id = e.payer_account_id
         JOIN account a ON a.chain_id = pa.chain_id
                       AND (a.id = e.payer_account_id OR lower(a.address) = lower(e.payee_address))
        WHERE a.id = ANY($1::text[]) AND e.status = 'resolved'
          AND e.resolution_payee_amount IS NOT NULL AND e.resolution_payer_amount IS NOT NULL
          AND ((a.id = e.payer_account_id AND e.resolution_payer_amount * 2 < e.amount)
            OR (lower(a.address) = lower(e.payee_address) AND e.resolution_payee_amount * 2 < e.amount))
        GROUP BY a.id`,
      [ids],
    ),
  );

  // Distinct recipients of settled outgoing payments (escrow and stream payments pay their
  // payee through the contract) and distinct payers of escrows completed as payee.
  const counterparties = countMap(
    await all<{ account_id: string; n: bigint }>(
      db,
      `SELECT x.account_id, count(DISTINCT x.party)::bigint AS n FROM (
         SELECT p.account_id, lower(COALESCE(e.payee_address, s.payee_address, p.counterparty_address)) AS party
           FROM payment p
           LEFT JOIN escrow e ON e.id = p.escrow_id
           LEFT JOIN stream s ON s.id = p.stream_id
          WHERE p.account_id = ANY($1::text[]) AND p.status = 'settled' AND p.kind = ANY($2::text[])
         UNION ALL
         SELECT a.id AS account_id, lower(pa.address) AS party
           FROM escrow e
           JOIN account pa ON pa.id = e.payer_account_id
           JOIN account a ON lower(a.address) = lower(e.payee_address) AND a.chain_id = pa.chain_id
          WHERE a.id = ANY($1::text[]) AND e.status = 'released'
       ) x GROUP BY x.account_id`,
      [ids, kinds],
    ),
  );

  for (const account of accounts) {
    let operating = 0n;
    try {
      operating = await deps.ledger.balance(pocket(account.account_id, "operating"));
    } catch (error) {
      if (!(isAgentBankError(error) && error.code === "not_found")) throw error;
    }
    const caps = limits.get(account.agent_id) ?? { perTx: 0n, perDay: 0n };
    const stats = paymentStats.get(account.account_id);
    out.set(account.account_id, {
      principal_verification: principalVerification(account.kyc_status, account.org_kind),
      per_tx_limit: caps.perTx,
      per_day_limit: caps.perDay,
      balance: clampU64(floorTo(operating, USDC_DOLLAR)),
      reserved_amount: 0n,
      reserved_until: 0n,
      reserved_for: 0n,
      account_created_on: floorTo(unix(account.created_at), SECONDS_PER_DAY),
      payments_settled: clampU64(stats?.n ?? 0n),
      volume_settled: clampU64(floorTo(stats?.volume ?? 0n, USDC_DOLLAR)),
      escrows_completed: clampU64(escrowsCompleted.get(account.account_id) ?? 0n),
      disputes_lost: clampU64(disputesLost.get(account.account_id) ?? 0n),
      counterparties: clampU64(counterparties.get(account.account_id) ?? 0n),
    });
  }
  return out;
}

/**
 * Every leaf of the tree at `now`, in tree order: per eligible account (by id) its base leaf,
 * then one leaf per pending or active, unexpired reservation (by id) with reserved_amount,
 * reserved_until (unix seconds) and reserved_for (the scope tag).
 */
export async function snapshotLeaves(
  deps: Pick<AppDeps, "db" | "ledger" | "logger">,
  chainId: number,
  now: Date,
): Promise<LeafInput[]> {
  const accounts = await eligibleAccounts(deps.db, chainId, now);
  if (accounts.length === 0) return [];
  const attributes = await attestAccounts(deps, accounts, now);
  const reservations = await all<ProofReservationRow>(
    deps.db,
    `SELECT * FROM proof_reservation
      WHERE account_id = ANY($1::text[]) AND chain_id = $2 AND status IN ('pending', 'active') AND expires_at > $3`,
    [accounts.map((a) => a.account_id), chainId, now],
  );
  const byAccount = new Map<string, ProofReservationRow[]>();
  for (const r of reservations) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r]);
  const leaves: LeafInput[] = [];
  for (const account of accounts) {
    const base = attributes.get(account.account_id) as Record<Attribute, bigint>;
    const identity = BigInt(account.identity_commitment);
    const mask = account.disclosure_mask;
    leaves.push({
      accountId: account.account_id,
      reservationId: null,
      attributes: base,
      disclosureMask: mask,
      leaf: leafHash(identity, base, mask),
    });
    const own = (byAccount.get(account.account_id) ?? []).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const r of own) {
      const values: Record<Attribute, bigint> = {
        ...base,
        reserved_amount: clampU64(r.amount),
        reserved_until: unix(r.expires_at),
        reserved_for: clampU64(BigInt(r.scope_tag)),
      };
      leaves.push({
        accountId: account.account_id,
        reservationId: r.id,
        attributes: values,
        disclosureMask: mask,
        leaf: leafHash(identity, values, mask),
      });
    }
  }
  return leaves;
}

/** Attribute values as stored in `proof_leaf.attributes` (base-10 strings, circuit order). */
export function attributesJson(values: AttributeValues): Record<Attribute, string> {
  return Object.fromEntries(ATTRIBUTES.map((a) => [a, values[a].toString()])) as Record<Attribute, string>;
}

/** The latest root of a chain that is published and still valid at `now`. */
export async function latestValidRoot(
  db: SqlClient,
  chainId: number,
  now: Date,
): Promise<ProofRootRow | undefined> {
  return one<ProofRootRow>(
    db,
    `SELECT * FROM proof_root WHERE chain_id = $1 AND status = 'published' AND valid_until >= $2
      ORDER BY epoch DESC LIMIT 1`,
    [chainId, now],
  );
}

// ---------------------------------------------------------------- reservations

/**
 * Close a pending or active reservation: void its hold (funds back to `operating`), record the
 * new status and emit `proof_reservation.released` / `.expired`. An owner's early release is a
 * narrowing change (roots containing the reservation are revoked); an expiry is not (a lapsed
 * `reserved_until` proves nothing). The hold is voided first, with a key derived from the
 * reservation, so a retry after a crash replays it. Returns the row and whether it changed.
 */
export async function closeProofReservation(
  deps: AppDeps,
  reservation: ProofReservationRow,
  status: "released" | "expired",
  now: Date,
  actor: string = "system",
): Promise<{ reservation: ProofReservationRow; changed: boolean }> {
  try {
    await deps.ledger.voidHold({
      idempotencyKey: `proof_reservation:${reservation.id}:${status}`,
      holdId: reservation.hold_id,
      reason: status === "released" ? "released early by the owner" : "expired",
    });
  } catch (error) {
    // Already resolved (a racing close, or voided elsewhere): nothing left to release.
    if (!(
      isAgentBankError(error) &&
      (error.code === "invalid_state" || error.code === "idempotency_conflict")
    ))
      throw error;
  }
  return deps.db.transaction(async (tx) => {
    const updated = await one<ProofReservationRow>(
      tx,
      `UPDATE proof_reservation SET status = $2, released_at = CASE WHEN $2 = 'released' THEN $3 ELSE released_at END
        WHERE id = $1 AND status IN ('pending', 'active') RETURNING *`,
      [reservation.id, status, now],
    );
    if (!updated) {
      const current = (await one<ProofReservationRow>(tx, "SELECT * FROM proof_reservation WHERE id = $1", [
        reservation.id,
      ])) as ProofReservationRow;
      return { reservation: current, changed: false };
    }
    await markProofTreeDirty(tx, updated.chain_id, { narrowing: status === "released" }, now);
    await emitEvent(tx, now, {
      orgId: updated.org_id,
      type: status === "released" ? "proof_reservation.released" : "proof_reservation.expired",
      data: serializeProofReservation(updated, now),
    });
    await audit(tx, now, {
      actor,
      action: status === "released" ? "proofs.reservation.release" : "proofs.reservation.expire",
      subject: updated.id,
      payload: { account_id: updated.account_id, amount: updated.amount.toString() },
    });
    return { reservation: updated, changed: true };
  });
}
