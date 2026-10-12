import { AgentBankError } from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { toBytes32 } from "@agentbank/proofs";
import type { Hex } from "viem";
import type { ProofReservationRow, ProofRootRow, ProofTreeStateRow } from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import {
  attributesJson,
  buildClaimsTree,
  closeProofReservation,
  latestValidRoot,
  markProofTreeDirty,
  proofAttester,
  registryAddress,
  snapshotLeaves,
  type LeafInput,
} from "../domain/proofs";

/**
 * Private-proof jobs (docs/private-proofs.md, "Roots"):
 *
 * - `proofs-roots` (every 30 s): when the tree is dirty (enrollment, settings, reservation,
 *   freeze), there is no valid root, or the newest is older than `PROOFS_ROOT_INTERVAL_SECONDS`,
 *   snapshot the attested facts, build the tree, store the root and its leaves, publish it with the
 *   attester key and confirm it. A build triggered by a narrowing change revokes every other
 *   still-valid root once it lands. Empty trees are not published.
 * - `proofs-reservations` (every 60 s): expire due reservations (void the hold) and prune the
 *   leaves of roots a day past their validity window. It runs even with the feature off, so held
 *   funds are always released.
 */

/** No receipt this long after sending: the root failed (it is rebuilt with a new epoch). */
const PUBLISH_TIMEOUT_MS = 30 * 60_000;
/** A root stored but never sent (crash in between) is resolved after this grace. */
const UNSENT_GRACE_MS = 2 * 60_000;
/** Leaves are kept this long past a root's validity window. */
const PRUNE_AFTER_MS = 86_400_000;
const LEAF_INSERT_BATCH = 500;

const EMPTY_STATE = (chainId: number, now: Date): ProofTreeStateRow => ({
  chain_id: chainId,
  dirty: false,
  narrowing: false,
  dirty_since: null,
  version: 0n,
  min_epoch: 0n,
  updated_at: now,
});

async function treeState(deps: AppDeps, chainId: number, now: Date): Promise<ProofTreeStateRow> {
  return (
    (await one<ProofTreeStateRow>(deps.db, "SELECT * FROM proof_tree_state WHERE chain_id = $1", [
      chainId,
    ])) ?? EMPTY_STATE(chainId, now)
  );
}

/** Clear the flags unless something changed since the snapshot read `version`. */
async function clearDirty(deps: AppDeps, chainId: number, version: bigint, now: Date): Promise<void> {
  await deps.db.query(
    `UPDATE proof_tree_state SET dirty = false, narrowing = false, dirty_since = NULL, updated_at = $3
      WHERE chain_id = $1 AND version = $2`,
    [chainId, version, now],
  );
}

const unix = (at: Date): number => Math.floor(at.getTime() / 1000);

/**
 * Snapshot time in unix seconds. The registry requires `snapshotAt <= block.timestamp`, and the
 * EVM gateway simulates against the latest block, so on a real chain it is at most the head's
 * time. The simulated chain's blocks follow the shared clock.
 */
async function snapshotTime(deps: AppDeps, now: Date): Promise<number> {
  const seconds = unix(now);
  if (deps.config.chain.name === "simulated") return seconds;
  const head = await deps.chain.getBlock("latest");
  return Math.min(seconds, head.timestamp);
}

/** `EpochNotIncreasing(latest, given)`: the registry is ahead of this database. */
function registryLatestEpoch(error: unknown): bigint | null {
  const match = /EpochNotIncreasing\((\d+),\s*(\d+)\)/.exec(
    error instanceof Error ? error.message : String(error),
  );
  return match ? BigInt(match[1] as string) : null;
}

async function failRoot(deps: AppDeps, root: ProofRootRow, error: string, now: Date): Promise<void> {
  // RPC errors can quote the endpoint URL, which embeds the provider's key.
  const reason = error.replace(/\b(?:https?|wss?):\/\/\S+/g, "<url>").slice(0, 1_000);
  await deps.db.transaction(async (tx) => {
    const failed = await one<ProofRootRow>(
      tx,
      `UPDATE proof_root SET status = 'failed', failure_reason = $3
        WHERE chain_id = $1 AND epoch = $2 AND status = 'publishing' RETURNING *`,
      [root.chain_id, root.epoch, reason],
    );
    // The change that triggered the build still has to land (a narrowing one, urgently).
    if (failed) await markProofTreeDirty(tx, root.chain_id, { narrowing: root.narrowing }, now);
  });
  deps.logger.error(
    { chainId: root.chain_id, epoch: root.epoch.toString(), reason },
    "private-proof root failed",
  );
}

/**
 * Revoke every published root of the chain still valid at `now` (except `keep`). On failure the
 * tree is marked dirty with narrowing, so the next run publishes and revokes again.
 */
export async function revokeValidRoots(
  deps: AppDeps,
  chainId: number,
  keep: string | null,
  now: Date,
): Promise<number> {
  const rows = await all<Pick<ProofRootRow, "root">>(
    deps.db,
    `SELECT root FROM proof_root
      WHERE chain_id = $1 AND status = 'published' AND valid_until >= $2 AND root <> $3
      ORDER BY epoch`,
    [chainId, now, keep ?? ""],
  );
  if (rows.length === 0) return 0;
  const roots = rows.map((r) => r.root as Hex);
  try {
    const { txHash } = await deps.chain.revokeAttestationRoots({ roots, attester: proofAttester(deps) });
    await deps.db.query(
      `UPDATE proof_root SET status = 'revoked', revoked_at = $3, revoke_tx_hash = $4
        WHERE chain_id = $1 AND root = ANY($2::text[]) AND status = 'published'`,
      [chainId, roots, now, txHash],
    );
  } catch (error) {
    await markProofTreeDirty(deps.db, chainId, { narrowing: true }, now);
    throw error;
  }
  deps.logger.info({ chainId, revoked: roots.length }, "revoked private-proof roots");
  return roots.length;
}

/** A root landed: mark it published, activate the reservations it includes, revoke on narrowing. */
async function markPublished(
  deps: AppDeps,
  root: ProofRootRow,
  publishedAt: Date,
  now: Date,
): Promise<number> {
  const updated = await deps.db.transaction(async (tx) => {
    const row = await one<ProofRootRow>(
      tx,
      `UPDATE proof_root SET status = 'published', published_at = $3
        WHERE chain_id = $1 AND epoch = $2 AND status = 'publishing' RETURNING *`,
      [root.chain_id, root.epoch, publishedAt],
    );
    if (!row) return undefined;
    await tx.query(
      `UPDATE proof_reservation SET status = 'active', included_in_epoch = COALESCE(included_in_epoch, $2)
        WHERE status = 'pending' AND id IN (
          SELECT reservation_id FROM proof_leaf
           WHERE chain_id = $1 AND epoch = $2 AND reservation_id IS NOT NULL)`,
      [root.chain_id, root.epoch],
    );
    return row;
  });
  if (!updated) return 0;
  deps.logger.info(
    { chainId: root.chain_id, epoch: root.epoch.toString(), leafCount: root.leaf_count },
    "published private-proof root",
  );
  const revoked = root.narrowing ? await revokeValidRoots(deps, root.chain_id, root.root, now) : 0;
  return 1 + revoked;
}

/** Follow a root being published: published on a successful receipt, failed on a revert or timeout. */
async function confirmRoot(deps: AppDeps, root: ProofRootRow, now: Date): Promise<number> {
  const age = now.getTime() - root.created_at.getTime();
  if (root.tx_hash === null) {
    if (age < UNSENT_GRACE_MS) return 0;
    // Stored but maybe never sent: the registry decides.
    const info = await deps.chain.getAttestationRoot(root.root as Hex);
    if (info && info.epoch === root.epoch) {
      return markPublished(deps, root, new Date(Number(info.publishedAt) * 1000), now);
    }
    await failRoot(deps, root, "never sent", now);
    return 1;
  }
  const receipt = await deps.chain.getTransactionReceipt(root.tx_hash as Hex);
  if (receipt === null) {
    if (age < PUBLISH_TIMEOUT_MS) return 0;
    await failRoot(deps, root, "not mined in time", now);
    return 1;
  }
  if (receipt.status === "reverted") {
    await failRoot(deps, root, "publishRoot reverted", now);
    return 1;
  }
  const info = await deps.chain.getAttestationRoot(root.root as Hex);
  const publishedAt = info ? new Date(Number(info.publishedAt) * 1000) : now;
  return markPublished(deps, root, publishedAt, now);
}

async function confirmPublishing(deps: AppDeps, chainId: number, now: Date): Promise<number> {
  const rows = await all<ProofRootRow>(
    deps.db,
    "SELECT * FROM proof_root WHERE chain_id = $1 AND status = 'publishing' ORDER BY epoch",
    [chainId],
  );
  let changed = 0;
  for (const row of rows) changed += await confirmRoot(deps, row, now);
  return changed;
}

/** Store the tree of `leaves` as the next epoch, publish it and confirm it. */
async function publishTree(
  deps: AppDeps,
  chainId: number,
  leaves: readonly LeafInput[],
  state: ProofTreeStateRow,
  now: Date,
): Promise<number> {
  const attester = proofAttester(deps);
  if (registryAddress(deps) === null) {
    throw new AgentBankError(
      "invalid_state",
      `AgentAttestationRegistry is not configured on chain ${chainId}: private-proof roots cannot be published`,
      { reason: "registry_not_configured" },
    );
  }
  const snapshotAt = await snapshotTime(deps, now);
  const validUntil = snapshotAt + deps.config.proofs.rootTtlSeconds;
  const last = await one<{ max: bigint | null }>(
    deps.db,
    "SELECT max(epoch) AS max FROM proof_root WHERE chain_id = $1",
    [chainId],
  );
  const lastEpoch = last?.max ?? 0n;
  const epoch = (lastEpoch > state.min_epoch ? lastEpoch : state.min_epoch) + 1n;
  const tree = buildClaimsTree(
    chainId,
    epoch,
    leaves.map((l) => l.leaf),
  );
  const root = toBytes32(tree.root);
  const row = await deps.db.transaction(async (tx) => {
    const inserted = (await one<ProofRootRow>(
      tx,
      `INSERT INTO proof_root (chain_id, root, epoch, snapshot_at, valid_until, leaf_count, status, narrowing, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'publishing', $7, $8) RETURNING *`,
      [
        chainId,
        root,
        epoch,
        new Date(snapshotAt * 1000),
        new Date(validUntil * 1000),
        leaves.length,
        state.narrowing,
        now,
      ],
    )) as ProofRootRow;
    for (let start = 0; start < leaves.length; start += LEAF_INSERT_BATCH) {
      const batch = leaves.slice(start, start + LEAF_INSERT_BATCH);
      const params: SqlParam[] = [];
      const values = batch.map((leaf, i) => {
        params.push(
          chainId,
          epoch,
          start + i,
          leaf.accountId,
          leaf.reservationId,
          toBytes32(leaf.leaf),
          attributesJson(leaf.attributes),
          leaf.disclosureMask,
        );
        const p = i * 8;
        return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8})`;
      });
      await tx.query(
        `INSERT INTO proof_leaf (chain_id, epoch, leaf_index, account_id, reservation_id, leaf, attributes, disclosure_mask)
         VALUES ${values.join(", ")}`,
        params,
      );
    }
    return inserted;
  });

  let txHash: Hex;
  try {
    ({ txHash } = await deps.chain.publishAttestationRoot({
      root,
      epoch,
      snapshotAt: BigInt(snapshotAt),
      validUntil: BigInt(validUntil),
      leafCount: leaves.length,
      attester,
    }));
  } catch (error) {
    const latest = registryLatestEpoch(error);
    if (latest !== null) {
      await deps.db.query(
        `INSERT INTO proof_tree_state (chain_id, min_epoch, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (chain_id) DO UPDATE SET min_epoch = GREATEST(proof_tree_state.min_epoch, EXCLUDED.min_epoch),
           updated_at = EXCLUDED.updated_at`,
        [chainId, latest, now],
      );
    }
    await failRoot(deps, row, error instanceof Error ? error.message : String(error), now);
    return 1;
  }
  const sent = (await one<ProofRootRow>(
    deps.db,
    "UPDATE proof_root SET tx_hash = $3 WHERE chain_id = $1 AND epoch = $2 RETURNING *",
    [chainId, epoch, txHash],
  )) as ProofRootRow;
  await clearDirty(deps, chainId, state.version, now);
  if (leaves.length < deps.config.proofs.minAnonymitySet) {
    deps.logger.warn(
      {
        chainId,
        epoch: epoch.toString(),
        leafCount: leaves.length,
        minAnonymitySet: deps.config.proofs.minAnonymitySet,
      },
      "private-proof root is smaller than PROOFS_MIN_ANONYMITY_SET: verifiers requiring that anonymity set refuse proofs against it",
    );
  }
  // Simulated chain: mined at once. EVM chains: confirmed by a later run.
  return Math.max(1, await confirmRoot(deps, sent, now));
}

/** The `proofs-roots` job. Returns how many roots it sent, confirmed, failed or revoked. */
export async function runProofRoots(deps: AppDeps): Promise<number> {
  if (!deps.config.features.privateProofs) return 0;
  const chainId = deps.config.chain.id;
  const now = deps.clock.now();
  let changed = await confirmPublishing(deps, chainId, now);
  const inFlight = await one(
    deps.db,
    "SELECT 1 AS x FROM proof_root WHERE chain_id = $1 AND status = 'publishing' LIMIT 1",
    [chainId],
  );
  if (inFlight) return changed; // one root at a time: epochs land in order
  const state = await treeState(deps, chainId, now);
  const latest = await latestValidRoot(deps.db, chainId, now);
  const due =
    latest === undefined ||
    now.getTime() - latest.snapshot_at.getTime() >= deps.config.proofs.rootIntervalSeconds * 1000;
  if (!state.dirty && !due) return changed;
  const leaves = await snapshotLeaves(deps, chainId, now);
  if (leaves.length === 0) {
    // Nothing to attest. A narrowing change (the last agent disabled or frozen) still revokes.
    if (state.narrowing) changed += await revokeValidRoots(deps, chainId, null, now);
    await clearDirty(deps, chainId, state.version, now);
    return changed;
  }
  return changed + (await publishTree(deps, chainId, leaves, state, now));
}

/** Expire reservations whose time is up: void the hold, `proof_reservation.expired`. */
export async function expireProofReservations(deps: AppDeps, now: Date): Promise<number> {
  const due = await all<ProofReservationRow>(
    deps.db,
    `SELECT * FROM proof_reservation WHERE status IN ('pending', 'active') AND expires_at <= $1
      ORDER BY expires_at LIMIT 200`,
    [now],
  );
  let expired = 0;
  for (const reservation of due) {
    const closed = await closeProofReservation(deps, reservation, "expired", now);
    if (closed.changed) expired++;
  }
  return expired;
}

/** Persist `expired` on lapsed roots and prune leaves a day past the validity window. */
export async function pruneProofRoots(deps: AppDeps, now: Date): Promise<number> {
  await deps.db.query(
    "UPDATE proof_root SET status = 'expired' WHERE status = 'published' AND valid_until < $1",
    [now],
  );
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS);
  const pruned = await deps.db.query(
    `DELETE FROM proof_leaf l USING proof_root r
      WHERE l.chain_id = r.chain_id AND l.epoch = r.epoch
        AND (r.valid_until < $1 OR (r.status = 'failed' AND r.created_at < $1))`,
    [cutoff],
  );
  return pruned.rowCount;
}

/** The `proofs-reservations` job. */
export async function runProofReservations(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  return (await expireProofReservations(deps, now)) + (await pruneProofRoots(deps, now));
}
