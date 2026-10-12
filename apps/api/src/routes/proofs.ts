import {
  AgentBankError,
  base64UrlToBytes,
  bytesToBase64Url,
  isAgentBankError,
  newId,
  ownerPayloads,
  toPositiveMinor,
  unixSeconds,
  utf8,
} from "@agentbank/core";
import { DISCLOSURE_CLASSES } from "@agentbank/core/api";
import type { SqlParam } from "@agentbank/db";
import manifest from "@agentbank/proofs/manifest.json" with { type: "json" };
import {
  ATTRIBUTES,
  buildWitness,
  CLAIMS_SCHEMA,
  CLASS_ATTRIBUTES,
  disclosureMask,
  fromBytes32,
  isFieldElement,
  leafHash,
  MAX_U64,
  rootStatusOf,
  scopeField,
  scopeTag,
  toBytes32,
  VERIFICATION_KEY,
  verifyPresentation,
  type DisclosureClass,
  type RootInfo,
} from "@agentbank/proofs";
import type {
  ProofIdentityRow,
  ProofLeafRow,
  ProofReservationRow,
  ProofRootRow,
  ProofSettingsRow,
} from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import type { AppDeps } from "../deps";
import { loadAccount, loadAgent, loadOrg } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { emitEvent } from "../domain/events";
import { ledgerIn } from "../domain/ledger-tx";
import { verifyOwnerAuth } from "../domain/owner-auth";
import {
  assertProofsEnabled,
  claimsVerifierAddress,
  closeProofReservation,
  markProofTreeDirty,
  registryAddress,
  treeOfRoot,
} from "../domain/proofs";
import { requireAgent, requirePrincipal, type AuthContext } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import {
  proofReservationStatus,
  proofRootStatus,
  serializeProofIdentity,
  serializeProofReservation,
  serializeProofRoot,
  serializeProofSettings,
} from "../serializers";

/**
 * Private proofs (docs/private-proofs.md, ADR 0014): the circuit, attested-facts roots,
 * verification, per-agent disclosure settings, identity enrollment, witnesses and proof-of-funds
 * reservations. Every operation answers `403 feature_gated` while `FEATURE_PRIVATE_PROOFS` is
 * off, except reading and releasing reservations: held funds stay visible and releasable.
 *
 * Errors an agent can act on carry a `reason` extension: `not_enrolled` (404), `proofs_disabled`,
 * `reservations_not_disclosed`, `proof_not_ready` (no published root includes the leaf yet; the
 * next root is built within a minute) and `reservation_closed` (409 `invalid_state`).
 */

type ProofOperation =
  | "getProofCircuit"
  | "listProofRoots"
  | "getProofRoot"
  | "verifyProof"
  | "getProofSettings"
  | "updateProofSettings"
  | "enrollProofIdentity"
  | "getProofIdentity"
  | "getProofWitness"
  | "createProofReservation"
  | "listProofReservations"
  | "getProofReservation"
  | "releaseProofReservation";

/** Reservations last more than a minute and at most seven days. */
const MIN_RESERVATION_MS = 60_000;
const MAX_RESERVATION_MS = 7 * 86_400_000;

const unix = (at: Date): number => Math.floor(at.getTime() / 1000);

type WitnessLeaf = Pick<
  ProofLeafRow,
  "leaf_index" | "leaf" | "attributes" | "disclosure_mask" | "reservation_id"
>;

function notReady(detail: string, reason: string): AgentBankError {
  return new AgentBankError("invalid_state", detail, { reason });
}

/** Disclosure classes in canonical (class) order, deduplicated. */
function canonicalClasses(classes: readonly string[]): DisclosureClass[] {
  return DISCLOSURE_CLASSES.filter((c) => classes.includes(c));
}

async function settingsOf(deps: AppDeps, agentId: string): Promise<ProofSettingsRow | undefined> {
  return one<ProofSettingsRow>(deps.db, "SELECT * FROM proof_settings WHERE agent_id = $1", [agentId]);
}

/** The caller's own account (agents act only on the account their session belongs to). */
async function ownAgentAccount(deps: AppDeps, auth: AuthContext, accountId: string) {
  const agent = requireAgent(auth);
  if (agent.accountId !== accountId) throw new AgentBankError("not_found", "Account not found");
  return loadAccount(deps.db, agent, accountId);
}

/** A reservation the caller may see: its agent's own account, or any account of the principal's org. */
async function loadReservation(deps: AppDeps, auth: AuthContext, id: string): Promise<ProofReservationRow> {
  const row = await one<ProofReservationRow>(deps.db, "SELECT * FROM proof_reservation WHERE id = $1", [id]);
  const visible =
    row !== undefined &&
    ((auth.kind === "agent" && row.account_id === auth.accountId) ||
      (auth.kind === "principal" && row.org_id === auth.orgId));
  if (!visible) throw new AgentBankError("not_found", "Reservation not found");
  return row;
}

/** The registry's view of a stored root, for `verifyPresentation`. */
function rootInfoOf(row: ProofRootRow, now: Date): RootInfo {
  return {
    epoch: row.epoch,
    snapshotAt: unix(row.snapshot_at),
    publishedAt: row.published_at ? unix(row.published_at) : null,
    validUntil: unix(row.valid_until),
    leafCount: row.leaf_count,
    revoked: row.status === "revoked",
    status: proofRootStatus(row, now),
  };
}

function encodeEpochCursor(epoch: bigint): string {
  return bytesToBase64Url(utf8(JSON.stringify({ e: epoch.toString() })));
}

function decodeEpochCursor(value: string | undefined): bigint | null {
  if (value === undefined || value === "") return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as { e?: unknown };
    if (typeof parsed.e !== "string" || !/^[1-9][0-9]{0,18}$/.test(parsed.e)) throw new Error("shape");
    return BigInt(parsed.e);
  } catch {
    throw new AgentBankError("invalid_request", "Invalid pagination cursor");
  }
}

/** Computed root status in SQL (published past valid_until reads as expired). */
const ROOT_STATUS_SQL = (nowParam: string) =>
  `(CASE WHEN status = 'published' AND valid_until < ${nowParam} THEN 'expired' ELSE status END)`;

/** Computed reservation status in SQL (pending/active past expires_at reads as expired). */
const RESERVATION_STATUS_SQL = (nowParam: string) =>
  `(CASE WHEN status IN ('pending', 'active') AND expires_at <= ${nowParam} THEN 'expired' ELSE status END)`;

export const proofHandlers: Pick<Handlers, ProofOperation> = {
  // ------------------------------------------------------------ circuit, roots, verification

  async getProofCircuit(_input, { deps }) {
    assertProofsEnabled(deps);
    return {
      object: "proof_circuit",
      schema: CLAIMS_SCHEMA,
      protocol: "groth16",
      curve: "bn128",
      tree_depth: manifest.tree_depth,
      attributes: [...ATTRIBUTES],
      disclosure_classes: Object.fromEntries(
        DISCLOSURE_CLASSES.map((c) => [c, [...CLASS_ATTRIBUTES[c]]]),
      ) as Record<DisclosureClass, (typeof ATTRIBUTES)[number][]>,
      public_signals: [...manifest.public_signals],
      constraints: manifest.constraints,
      verification_key: VERIFICATION_KEY as Record<string, unknown>,
      sha256: { ...manifest.sha256 },
      chain_id: deps.config.chain.id,
      registry: registryAddress(deps),
      verifier: claimsVerifierAddress(deps),
    };
  },

  async listProofRoots({ query }, { deps, now }) {
    assertProofsEnabled(deps);
    const params: SqlParam[] = [deps.config.chain.id];
    let where = "chain_id = $1";
    if (query.status) {
      params.push(now, query.status);
      where += ` AND ${ROOT_STATUS_SQL(`$${params.length - 1}`)} = $${params.length}`;
    }
    const cursor = decodeEpochCursor(query.cursor);
    if (cursor !== null) {
      params.push(cursor);
      where += ` AND epoch < $${params.length}`;
    }
    params.push(query.limit + 1);
    const rows = await all<ProofRootRow>(
      deps.db,
      `SELECT * FROM proof_root WHERE ${where} ORDER BY epoch DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const registry = registryAddress(deps);
    return {
      data: items.map((r) => serializeProofRoot(r, registry, now)),
      next_cursor: rows.length > query.limit && last ? encodeEpochCursor(last.epoch) : null,
    };
  },

  async getProofRoot({ params }, { deps, now }) {
    assertProofsEnabled(deps);
    const root = toBytes32(fromBytes32(params.root));
    const row = await one<ProofRootRow>(
      deps.db,
      "SELECT * FROM proof_root WHERE chain_id = $1 AND root = $2",
      [deps.config.chain.id, root],
    );
    if (!row) throw new AgentBankError("not_found", "Root not found on this chain");
    return serializeProofRoot(row, registryAddress(deps), now);
  },

  async verifyProof({ body }, { deps, now }) {
    assertProofsEnabled(deps);
    const configured = registryAddress(deps);
    // The root check uses the request's own min_anonymity_set, exactly as the SDK verifiers do.
    const result = await verifyPresentation({
      request: body.request,
      presentation: body.presentation,
      now: unixSeconds(now),
      rootResolver: async ({ root, chainId, registry }) => {
        if (chainId !== deps.config.chain.id) return null;
        if (registry !== null && (configured === null || registry.toLowerCase() !== configured.toLowerCase()))
          return null;
        const row = await one<ProofRootRow>(
          deps.db,
          "SELECT * FROM proof_root WHERE chain_id = $1 AND root = $2",
          [chainId, root.toLowerCase()],
        );
        return row ? rootInfoOf(row, now) : null;
      },
    });
    return {
      object: "proof_verification",
      valid: result.valid,
      reason: result.reason,
      nullifier: result.nullifier,
      root: result.root,
      root_status: rootStatusOf(result.rootInfo, unixSeconds(now)),
    };
  },

  // ------------------------------------------------------------ settings (owner control)

  async getProofSettings({ params }, { deps, auth }) {
    assertProofsEnabled(deps);
    const principal = requirePrincipal(auth);
    const agent = await loadAgent(deps.db, principal, params.id);
    return serializeProofSettings(agent.id, await settingsOf(deps, agent.id));
  },

  async updateProofSettings({ params, body }, { deps, auth, now }) {
    assertProofsEnabled(deps);
    const principal = requirePrincipal(auth);
    const agent = await loadAgent(deps.db, principal, params.id);
    const current = await settingsOf(deps, agent.id);
    const wasEnabled = current?.enabled ?? false;
    const before = new Set(current?.disclose ?? []);
    const next = canonicalClasses(body.disclose);
    const added = next.filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !next.includes(c as DisclosureClass));
    // Widening needs the owner; narrowing is urgent and needs only the API key.
    const widening = (!wasEnabled && body.enabled) || added.length > 0;
    const narrowing = wasEnabled && (!body.enabled || removed.length > 0);
    const changed = wasEnabled !== body.enabled || added.length > 0 || removed.length > 0;
    if (widening) {
      const owner = ownerPayloads.proofsDisclose(agent.id, { enabled: body.enabled, disclose: next });
      if (!body.owner_authorization) {
        throw new AgentBankError(
          "owner_signature_required",
          "Enabling private proofs or disclosing another class needs the owner's authorization (proofs.disclose)",
          { action: owner.action, subject: owner.subject, payload: owner.payload },
        );
      }
      const org = await loadOrg(deps.db, principal.orgId);
      await verifyOwnerAuth(deps, {
        ownerAddress: org.owner_address,
        ...owner,
        authorization: body.owner_authorization,
        now,
      });
    }
    const row = await deps.db.transaction(async (tx) => {
      const saved = (await one<ProofSettingsRow>(
        tx,
        `INSERT INTO proof_settings (agent_id, org_id, enabled, disclose, disclosure_mask, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (agent_id) DO UPDATE SET enabled = EXCLUDED.enabled, disclose = EXCLUDED.disclose,
           disclosure_mask = EXCLUDED.disclosure_mask, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [agent.id, agent.org_id, body.enabled, next, disclosureMask(next), now, actorOf(auth)],
      )) as ProofSettingsRow;
      if (changed) {
        if (wasEnabled || body.enabled) {
          await markProofTreeDirty(tx, deps.config.chain.id, { narrowing }, now);
        }
        await emitEvent(tx, now, {
          orgId: agent.org_id,
          type: "proof_settings.updated",
          data: serializeProofSettings(agent.id, saved),
        });
      }
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "proofs.settings.update",
        subject: agent.id,
        payload: { enabled: body.enabled, disclose: next, widening, narrowing },
      });
      return saved;
    });
    return serializeProofSettings(agent.id, row);
  },

  // ------------------------------------------------------------ identity

  async enrollProofIdentity({ params, body }, { deps, auth, now }) {
    assertProofsEnabled(deps);
    const account = await ownAgentAccount(deps, auth, params.id);
    const value = fromBytes32(body.identity_commitment);
    if (value === 0n || !isFieldElement(value)) {
      throw new AgentBankError(
        "invalid_request",
        "identity_commitment must be a non-zero BN254 field element (Poseidon(secret))",
      );
    }
    const commitment = toBytes32(value);
    const row = await deps.db.transaction(async (tx) => {
      const existing = await one<ProofIdentityRow>(
        tx,
        "SELECT * FROM proof_identity WHERE account_id = $1 FOR UPDATE",
        [account.id],
      );
      if (existing?.identity_commitment === commitment) return existing;
      const saved = (await one<ProofIdentityRow>(
        tx,
        `INSERT INTO proof_identity (account_id, agent_id, org_id, identity_commitment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (account_id) DO UPDATE SET identity_commitment = EXCLUDED.identity_commitment,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [account.id, account.agent_id, account.org_id, commitment, now],
      )) as ProofIdentityRow;
      const enabled = await one(tx, "SELECT 1 AS x FROM proof_settings WHERE agent_id = $1 AND enabled", [
        account.agent_id,
      ]);
      // A new commitment replaces the agent's leaves: proofs from the old secret must stop verifying.
      if (enabled) await markProofTreeDirty(tx, account.chain_id, { narrowing: existing !== undefined }, now);
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "proofs.identity.enroll",
        subject: account.id,
        payload: { identity_commitment: commitment, replaced: existing !== undefined },
      });
      return saved;
    });
    return serializeProofIdentity(row);
  },

  async getProofIdentity({ params }, { deps, auth }) {
    assertProofsEnabled(deps);
    const account = await loadAccount(deps.db, auth, params.id);
    const row = await one<ProofIdentityRow>(deps.db, "SELECT * FROM proof_identity WHERE account_id = $1", [
      account.id,
    ]);
    if (!row) {
      throw new AgentBankError("not_found", "No identity commitment is enrolled for this account", {
        reason: "not_enrolled",
      });
    }
    return serializeProofIdentity(row);
  },

  // ------------------------------------------------------------ witness

  async getProofWitness({ params, query }, { deps, auth, now }) {
    assertProofsEnabled(deps);
    const account = await ownAgentAccount(deps, auth, params.id);
    const settings = await settingsOf(deps, account.agent_id as string);
    if (!settings?.enabled) {
      throw notReady("The owner has not enabled private proofs for this agent", "proofs_disabled");
    }
    const identity = await one<ProofIdentityRow>(
      deps.db,
      "SELECT * FROM proof_identity WHERE account_id = $1",
      [account.id],
    );
    if (!identity) {
      throw new AgentBankError("not_found", "Enroll an identity commitment first (PUT …/proofs/identity)", {
        reason: "not_enrolled",
      });
    }
    // Frozen agents (or agents of a frozen org) leave the tree: no new witnesses either.
    const standing = await one<{ agent: string; agent_due: boolean; org: string; org_due: boolean }>(
      deps.db,
      `SELECT g.status AS agent, (g.pending_unfreeze_at IS NOT NULL AND g.pending_unfreeze_at <= $2) AS agent_due,
              o.status AS org, (o.pending_unfreeze_at IS NOT NULL AND o.pending_unfreeze_at <= $2) AS org_due
         FROM agent g JOIN org o ON o.id = g.org_id WHERE g.id = $1`,
      [account.agent_id, now],
    );
    if (standing?.org === "frozen" && !standing.org_due) {
      throw new AgentBankError("org_frozen", "The organization is frozen");
    }
    if (standing?.agent === "frozen" && !standing.agent_due) {
      throw new AgentBankError("agent_frozen", "The agent is frozen");
    }
    const reservationId = query.reservation_id ?? null;
    if (reservationId !== null) {
      const reservation = await loadReservation(deps, auth, reservationId);
      const status = proofReservationStatus(reservation, now);
      if (status !== "pending" && status !== "active") {
        throw notReady(`The reservation is ${status}`, "reservation_closed");
      }
    }
    let root: string | null = null;
    if (query.root) {
      root = toBytes32(fromBytes32(query.root));
      const named = await one<ProofRootRow>(
        deps.db,
        "SELECT * FROM proof_root WHERE chain_id = $1 AND root = $2",
        [deps.config.chain.id, root],
      );
      if (!named)
        throw new AgentBankError("not_found", "Root not found on this chain", { reason: "unknown_root" });
      const status = proofRootStatus(named, now);
      if (status !== "published") throw notReady(`The root is ${status}`, `root_${status}`);
    }
    // The newest published, still-valid roots holding this leaf (or the named root).
    const candidates = await all<ProofRootRow & WitnessLeaf>(
      deps.db,
      `SELECT r.*, l.leaf_index, l.leaf, l.attributes, l.disclosure_mask, l.reservation_id
         FROM proof_root r
         JOIN proof_leaf l ON l.chain_id = r.chain_id AND l.epoch = r.epoch
        WHERE r.chain_id = $1 AND r.status = 'published' AND r.valid_until >= $2
          AND l.account_id = $3 AND l.reservation_id IS NOT DISTINCT FROM $4
          AND ($5::text IS NULL OR r.root = $5)
        ORDER BY r.epoch DESC LIMIT 8`,
      [deps.config.chain.id, now, account.id, reservationId, root],
    );
    const identityValue = BigInt(identity.identity_commitment);
    // Skip leaves built for an earlier commitment, and leaves disclosing more than the owner allows
    // now (a narrowing change is served at once, before the older roots' revocation lands).
    const match = candidates.find(
      (c) =>
        (c.disclosure_mask & ~settings.disclosure_mask) === 0 &&
        leafHash(identityValue, c.attributes, c.disclosure_mask) === BigInt(c.leaf),
    );
    if (!match) {
      throw notReady(
        "No published root includes this leaf yet (roots are rebuilt within a minute of a change)",
        "proof_not_ready",
      );
    }
    const tree = await treeOfRoot(deps.db, match);
    if (tree.leaf(match.leaf_index) !== BigInt(match.leaf)) {
      throw new AgentBankError("internal", "The stored leaf does not match the root's tree");
    }
    const witness = buildWitness({
      tree,
      index: match.leaf_index,
      attributes: match.attributes,
      disclosureMask: match.disclosure_mask,
      accountId: account.id,
      chainId: match.chain_id,
      registry: registryAddress(deps),
      epoch: match.epoch,
      snapshotAt: unix(match.snapshot_at),
      validUntil: unix(match.valid_until),
      reservationId: match.reservation_id,
    });
    // The tree also holds the epoch's salt leaf; the anonymity set is the attested leaves.
    return { ...witness, leaf_count: match.leaf_count };
  },

  // ------------------------------------------------------------ reservations (proof of funds)

  async createProofReservation({ params, body }, { deps, auth, now }) {
    assertProofsEnabled(deps);
    const account = await ownAgentAccount(deps, auth, params.id);
    const agentId = account.agent_id as string;
    const settings = await settingsOf(deps, agentId);
    if (!settings?.enabled) {
      throw notReady("The owner has not enabled private proofs for this agent", "proofs_disabled");
    }
    if (!settings.disclose.includes("reservations")) {
      throw notReady("The owner has not disclosed the reservations class", "reservations_not_disclosed");
    }
    if (body.amount.asset !== "USDC")
      throw new AgentBankError("unsupported_asset", "Reservations are in USDC");
    const amount = toPositiveMinor(body.amount);
    if (amount > MAX_U64)
      throw new AgentBankError("invalid_amount", "The amount must be below 2^64 minor units");
    const expiresAt = new Date(body.expires_at);
    const ahead = expiresAt.getTime() - now.getTime();
    if (!(ahead > MIN_RESERVATION_MS && ahead <= MAX_RESERVATION_MS)) {
      throw new AgentBankError(
        "invalid_request",
        "expires_at must be more than 60 seconds and at most 7 days ahead",
      );
    }
    const tag =
      body.scope !== undefined ? scopeTag(scopeField(body.scope)) : BigInt(body.scope_tag as string);
    const id = newId("proofReservation", now.getTime());
    const row = await deps.db.transaction(async (tx) => {
      let holdId: string;
      try {
        const hold = await ledgerIn(deps, tx).hold({
          idempotencyKey: `proof_reservation:${id}:hold`,
          accountId: account.id,
          asset: "USDC",
          amount,
          from: "operating",
          expiresAt,
          refType: "proof_reservation",
          refId: id,
          agentId,
          memo: "Proof-of-funds reservation",
        });
        holdId = hold.id;
      } catch (error) {
        if (isAgentBankError(error) && error.code === "insufficient_funds") {
          throw new AgentBankError("insufficient_funds", "Available balance cannot cover the reservation");
        }
        throw error;
      }
      const saved = (await one<ProofReservationRow>(
        tx,
        `INSERT INTO proof_reservation (id, account_id, agent_id, org_id, chain_id, hold_id, amount, scope_tag, expires_at,
                                        status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) RETURNING *`,
        [
          id,
          account.id,
          agentId,
          account.org_id,
          account.chain_id,
          holdId,
          amount,
          tag.toString(),
          expiresAt,
          now,
        ],
      )) as ProofReservationRow;
      await markProofTreeDirty(tx, account.chain_id, { narrowing: false }, now);
      await emitEvent(tx, now, {
        orgId: account.org_id,
        type: "proof_reservation.created",
        data: serializeProofReservation(saved, now),
      });
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "proofs.reservation.create",
        subject: id,
        payload: { account_id: account.id, amount: amount.toString(), scope_tag: tag.toString() },
      });
      return saved;
    });
    return new Envelope(serializeProofReservation(row, now), 201);
  },

  async listProofReservations({ params, query }, { deps, auth, now }) {
    const account = await loadAccount(deps.db, auth, params.id);
    const sqlParams: SqlParam[] = [account.id];
    let where = "account_id = $1";
    if (query.status) {
      sqlParams.push(now, query.status);
      where += ` AND ${RESERVATION_STATUS_SQL(`$${sqlParams.length - 1}`)} = $${sqlParams.length}`;
    }
    const sql = `SELECT * FROM proof_reservation WHERE ${where}${pageClause(
      decodeCursor(query.cursor),
      query.limit,
      sqlParams,
    )}`;
    const page = toPage(await all<ProofReservationRow>(deps.db, sql, sqlParams), query.limit);
    return { data: page.items.map((r) => serializeProofReservation(r, now)), next_cursor: page.nextCursor };
  },

  async getProofReservation({ params }, { deps, auth, now }) {
    return serializeProofReservation(await loadReservation(deps, auth, params.id), now);
  },

  async releaseProofReservation({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const reservation = await loadReservation(deps, principal, params.id);
    const status = proofReservationStatus(reservation, now);
    if (status !== "pending" && status !== "active") {
      throw notReady(`The reservation is already ${status}`, "reservation_closed");
    }
    const org = await loadOrg(deps.db, principal.orgId);
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.proofReservationRelease(reservation.id),
      authorization: body.owner_authorization,
      now,
    });
    const closed = await closeProofReservation(deps, reservation, "released", now, actorOf(auth));
    return serializeProofReservation(closed.reservation, now);
  },
};
