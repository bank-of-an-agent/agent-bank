import {
  AgentBankError,
  canonicalJson,
  canonicalKeccak,
  LOOSENING_DELAY_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  ownerPayloads,
  type FreezeInternal,
  type OwnerActionPayload,
  type OwnerAuthorization,
  type PolicyDocument,
  type PolicyStateInternal,
  type PolicyVersionInternal,
  type PutPolicyInternal,
  type RegisterMandateInternal,
  type RegisterSessionInternal,
  type RotateOwnerInternal,
  type SetTreasuryInternal,
  type UnfreezeInternal,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import {
  classifyChange,
  compileMandate,
  compilePolicy,
  compileSessionScope,
  effectiveAt,
  requiresOwnerSignatureForChange,
} from "@agentbank/policy";
import { getAddress } from "viem";
import { assertChain, assertIds, sameAddress, transaction, type ServiceContext } from "./context";
import { verifyOwnerAction, type VerifiedAuthorization } from "./owner-auth";
import * as store from "./store";

// ------------------------------------------------------------------ owner authorizations

/**
 * Verify an owner authorization over core's canonical payload (`ownerPayloads`)
 * against the owner key pinned for the org, never one the caller names.
 */
async function verifyOwner(
  ctx: ServiceContext,
  tx: SqlClient,
  orgId: string,
  claimedOwner: string,
  authorization: OwnerAuthorization,
  action: OwnerActionPayload,
  now: Date,
): Promise<VerifiedAuthorization> {
  const owner = await store.getOrgOwner(tx, orgId);
  if (owner === null) throw new AgentBankError("not_found", `Unknown org ${orgId}`);
  if (!sameAddress(owner, claimedOwner)) {
    throw new AgentBankError(
      "owner_signature_required",
      `${claimedOwner} is not the registered owner key of ${orgId}`,
    );
  }
  return verifyOwnerAction({
    authorization,
    owner,
    chainId: ctx.config.ownerAuthorizationChainId ?? ctx.config.chainId,
    action,
    now: Math.floor(now.getTime() / 1000),
    verifier: ctx.verifier,
  });
}

/** Owner authorizations are single-use (keyed by their EIP-712 digest). */
async function consumeAuthorization(
  tx: SqlClient,
  verified: VerifiedAuthorization,
  ref: string,
  now: Date,
): Promise<void> {
  if (await store.getAuthorizationUse(tx, verified.digest)) {
    throw new AgentBankError("conflict", "This owner authorization was already used");
  }
  await store.insertAuthorizationUse(tx, {
    digest: verified.digest,
    action: verified.action,
    subject: verified.subject,
    payload_hash: verified.payloadHash,
    signer: verified.signer,
    ref,
    used_at: now,
  });
}

/** Non-custodial line: Agent Bank's co-signer key is never an owner (or treasury) key. */
function assertNotCosignerKey(ctx: ServiceContext, address: string, what: string): void {
  if (sameAddress(address, ctx.signer.address)) {
    throw new AgentBankError(
      "invalid_request",
      `${what} must not be the co-signer's key; Agent Bank never holds an owner key`,
    );
  }
}

// ------------------------------------------------------------------ sessions

export async function registerSession(ctx: ServiceContext, input: RegisterSessionInternal): Promise<void> {
  assertIds({
    session_id: input.session_id,
    org_id: input.org_id,
    agent_id: input.agent_id,
    account_id: input.account_id,
  });
  assertChain(ctx, input.chain_id);
  assertNotCosignerKey(ctx, input.owner_address, "The owner key");
  if (sameAddress(input.public_key, ctx.signer.address)) {
    // A session key equal to the co-signer's key would make the 2-of-2 a 1-of-1.
    throw new AgentBankError("invalid_request", "The session key must not be the co-signer's key");
  }
  const now = ctx.clock.now();
  const scope = compileSessionScope(input.scope);
  const expires = scope.expiresAt.getTime();
  if (expires <= now.getTime())
    throw new AgentBankError("session_expired", "The session scope has already expired");
  if (expires > now.getTime() + (MAX_SESSION_TTL_SECONDS + 300) * 1000) {
    throw new AgentBankError("invalid_request", "Session keys live at most 7 days");
  }
  const normalizedScope = scope.source;

  await transaction(ctx, async (tx, audit) => {
    if (await store.isRevokedId(tx, "session", input.session_id)) {
      throw new AgentBankError("session_revoked", `Session ${input.session_id} was revoked`);
    }
    const existing = await store.getSession(tx, input.session_id);
    if (existing?.revoked_at)
      throw new AgentBankError("session_revoked", `Session ${input.session_id} was revoked`);
    if (existing) {
      const same =
        existing.org_id === input.org_id &&
        existing.agent_id === input.agent_id &&
        existing.account_id === input.account_id &&
        existing.chain_id === input.chain_id &&
        sameAddress(existing.account_address, input.account_address) &&
        sameAddress(existing.public_key, input.public_key) &&
        canonicalJson(existing.scope) === canonicalJson(normalizedScope);
      if (same) return;
      throw new AgentBankError(
        "conflict",
        `Session ${input.session_id} is already registered with other parameters`,
      );
    }
    await store.bindOrg(tx, input.org_id, input.owner_address, now);
    await store.bindAgent(tx, input.agent_id, input.org_id, now);
    await store.bindAccount(tx, {
      accountId: input.account_id,
      agentId: input.agent_id,
      chainId: input.chain_id,
      address: input.account_address,
      at: now,
    });
    const verified = await verifyOwner(
      ctx,
      tx,
      input.org_id,
      input.owner_address,
      input.owner_authorization,
      ownerPayloads.sessionGrant({
        account_id: input.account_id,
        public_key: input.public_key,
        scope: input.scope,
      }),
      now,
    );
    await consumeAuthorization(tx, verified, `session:${input.session_id}`, now);
    await store.insertSession(tx, {
      id: input.session_id,
      org_id: input.org_id,
      agent_id: input.agent_id,
      account_id: input.account_id,
      chain_id: input.chain_id,
      account_address: input.account_address,
      public_key: input.public_key,
      scope: normalizedScope,
      owner_authorization: input.owner_authorization,
      expires_at: scope.expiresAt,
      created_at: now,
    });
    await audit({
      at: now,
      actor: `owner:${verified.signer}`,
      action: "session.registered",
      subject: input.session_id,
      payload: {
        org_id: input.org_id,
        agent_id: input.agent_id,
        account_id: input.account_id,
        account_address: getAddress(input.account_address),
        public_key: getAddress(input.public_key),
        scope: normalizedScope,
        authorization_digest: verified.digest,
      },
    });
  });
}

/** Revoke immediately (tightening; idempotent). Unknown ids are tombstoned so a late registration cannot revive them. */
export async function revokeSession(ctx: ServiceContext, sessionId: string): Promise<void> {
  assertIds({ session_id: sessionId });
  const now = ctx.clock.now();
  await transaction(ctx, async (tx, audit) => {
    const existing = await store.getSession(tx, sessionId);
    if (existing) {
      if (!(await store.revokeSessionRow(tx, sessionId, now))) return;
    } else {
      if (await store.isRevokedId(tx, "session", sessionId)) return;
      await store.addRevocation(tx, "session", sessionId, now);
    }
    await audit({
      at: now,
      actor: "api",
      action: "session.revoked",
      subject: sessionId,
      payload: { known: existing !== null, agent_id: existing?.agent_id ?? null },
    });
  });
}

// ------------------------------------------------------------------ policies

function toVersion(row: store.PolicyRow): PolicyVersionInternal {
  return {
    agent_id: row.agent_id,
    version: row.version,
    policy: row.document as PolicyDocument,
    policy_hash: row.policy_hash,
    change_kind: row.change_kind,
    effective_at: row.effective_at.toISOString(),
    signed_by: row.signed_by === null ? null : getAddress(row.signed_by),
  };
}

/**
 * Store a policy version. Semantics (documented and tested):
 * - changes are classified against the version **in force now**, never a pending one;
 * - tightening (and neutral changes) take effect immediately; loosening and
 *   mixed changes need an owner authorization (`policy.loosen` over the policy
 *   document, signed by the org's owner key) and take effect after 1 hour; the
 *   first policy and auto-save changes need the authorization but no delay;
 * - writing any new version cancels a version that is still pending, so a
 *   pending loosening can never override a newer tightening; to loosen again
 *   the owner signs a new loosening relative to the policy in force;
 * - re-submitting the pending document, or the one in force when nothing is
 *   pending, changes nothing and returns that version.
 */
export async function putPolicy(
  ctx: ServiceContext,
  input: PutPolicyInternal,
): Promise<PolicyVersionInternal> {
  assertIds({ org_id: input.org_id, agent_id: input.agent_id });
  assertChain(ctx, input.chain_id);
  assertNotCosignerKey(ctx, input.owner_address, "The owner key");
  if (input.policy.agent !== undefined && input.policy.agent !== input.agent_id) {
    throw new AgentBankError(
      "invalid_request",
      `The policy names agent ${input.policy.agent}, not ${input.agent_id}`,
    );
  }
  const document = compilePolicy(input.policy, 0).source;
  const documentJson = canonicalJson(document);
  const policyHash = canonicalKeccak(document);

  return transaction(ctx, async (tx, audit) => {
    const now = ctx.clock.now();
    await store.bindOrg(tx, input.org_id, input.owner_address, now);
    await store.bindAgent(tx, input.agent_id, input.org_id, now);
    await store.lockAgent(tx, input.agent_id);
    const current = await store.currentPolicy(tx, input.agent_id, now);
    const pending = await store.pendingPolicy(tx, input.agent_id, now);
    if (pending && canonicalJson(pending.document) === documentJson) return toVersion(pending);
    if (current && !pending && canonicalJson(current.document) === documentJson) return toVersion(current);

    const classification = classifyChange((current?.document ?? null) as PolicyDocument | null, document);
    const kind = classification.kind;
    let verified: VerifiedAuthorization | null = null;
    // The first policy, loosening and mixed changes, and any auto-save edit are owner-signed.
    if (requiresOwnerSignatureForChange(classification)) {
      if (!input.owner_authorization) {
        const loosened = classification.changes.filter((c) => c.direction === "loosen").map((c) => c.path);
        const autoSave = classification.neutral.filter((p) => p.startsWith("auto_save"));
        throw new AgentBankError(
          "owner_signature_required",
          kind === "initial"
            ? "An agent's first policy must be authorized by the owner key (policy.loosen)"
            : loosened.length > 0
              ? `This change loosens the policy (${loosened.join(", ")}); it needs an owner authorization (policy.loosen) and takes effect after 1 hour`
              : `Auto-save rules are owner-signed (${autoSave.join(", ")}); this change needs an owner authorization (policy.loosen)`,
        );
      }
      verified = await verifyOwner(
        ctx,
        tx,
        input.org_id,
        input.owner_address,
        input.owner_authorization,
        ownerPayloads.policyLoosen(input.agent_id, input.policy),
        now,
      );
    }
    const version = (await store.latestPolicyVersion(tx, input.agent_id)) + 1;
    const effective = effectiveAt(kind, now);
    const cancelled = await store.cancelPendingPolicies(tx, input.agent_id, now, version);
    await store.insertPolicyVersion(tx, {
      agent_id: input.agent_id,
      version,
      document,
      policy_hash: policyHash,
      change_kind: kind,
      effective_at: effective,
      signed_by: verified?.signer ?? null,
      owner_authorization: verified ? (input.owner_authorization ?? null) : null,
      created_at: now,
    });
    if (verified) await consumeAuthorization(tx, verified, `policy:${input.agent_id}:${version}`, now);
    await audit({
      at: now,
      actor: verified ? `owner:${verified.signer}` : "api",
      action: "policy.version",
      subject: input.agent_id,
      payload: {
        org_id: input.org_id,
        version,
        change_kind: kind,
        effective_at: effective.toISOString(),
        policy_hash: policyHash,
        previous_version: current?.version ?? null,
        changes: classification.changes,
        neutral: classification.neutral,
        cancelled_pending_versions: cancelled,
        authorization_digest: verified?.digest ?? null,
      },
    });
    const row = await store.getPolicyVersion(tx, input.agent_id, version);
    if (!row) throw new Error("policy version vanished");
    return toVersion(row);
  });
}

export async function getPolicy(ctx: ServiceContext, agentId: string): Promise<PolicyStateInternal> {
  assertIds({ agent_id: agentId });
  const now = ctx.clock.now();
  const current = await store.currentPolicy(ctx.db, agentId, now);
  const pending = await store.pendingPolicy(ctx.db, agentId, now);
  return { current: current ? toVersion(current) : null, pending: pending ? toVersion(pending) : null };
}

// ------------------------------------------------------------------ mandates

export async function registerMandate(ctx: ServiceContext, input: RegisterMandateInternal): Promise<void> {
  assertIds({ mandate_id: input.mandate_id, org_id: input.org_id, agent_id: input.agent_id });
  assertChain(ctx, input.chain_id);
  assertNotCosignerKey(ctx, input.owner_address, "The owner key");
  if (input.mandate.agent_id !== input.agent_id) {
    throw new AgentBankError(
      "mandate_invalid",
      `The mandate is granted to ${input.mandate.agent_id}, not ${input.agent_id}`,
    );
  }
  const compiled = compileMandate(input.mandate);
  const now = ctx.clock.now();
  if (compiled.expiresAt.getTime() <= now.getTime()) {
    throw new AgentBankError("mandate_expired", `The mandate expired at ${compiled.expiresAt.toISOString()}`);
  }
  const mandateHash = canonicalKeccak(compiled.source);
  await transaction(ctx, async (tx, audit) => {
    if (await store.isRevokedId(tx, "mandate", input.mandate_id)) {
      throw new AgentBankError("invalid_state", `Mandate ${input.mandate_id} was revoked`);
    }
    const existing = await store.getMandate(tx, input.mandate_id);
    if (existing) {
      if (existing.agent_id === input.agent_id && existing.mandate_hash === mandateHash) return;
      throw new AgentBankError(
        "conflict",
        `Mandate ${input.mandate_id} is already registered with other content`,
      );
    }
    await store.bindOrg(tx, input.org_id, input.owner_address, now);
    await store.bindAgent(tx, input.agent_id, input.org_id, now);
    const verified = await verifyOwner(
      ctx,
      tx,
      input.org_id,
      input.owner_address,
      input.owner_authorization,
      ownerPayloads.mandateIssue(input.agent_id, input.mandate),
      now,
    );
    await consumeAuthorization(tx, verified, `mandate:${input.mandate_id}`, now);
    await store.insertMandate(tx, {
      id: input.mandate_id,
      org_id: input.org_id,
      agent_id: input.agent_id,
      chain_id: input.chain_id,
      document: compiled.source,
      mandate_hash: mandateHash,
      signer: verified.signer,
      owner_authorization: input.owner_authorization,
      expires_at: compiled.expiresAt,
      created_at: now,
    });
    await audit({
      at: now,
      actor: `owner:${verified.signer}`,
      action: "mandate.registered",
      subject: input.mandate_id,
      payload: {
        org_id: input.org_id,
        agent_id: input.agent_id,
        mandate_hash: mandateHash,
        expires_at: compiled.expiresAt.toISOString(),
        authorization_digest: verified.digest,
      },
    });
  });
}

export async function revokeMandate(ctx: ServiceContext, mandateId: string): Promise<void> {
  assertIds({ mandate_id: mandateId });
  const now = ctx.clock.now();
  await transaction(ctx, async (tx, audit) => {
    const existing = await store.getMandate(tx, mandateId);
    if (existing) {
      if (!(await store.revokeMandateRow(tx, mandateId, now))) return;
    } else {
      if (await store.isRevokedId(tx, "mandate", mandateId)) return;
      await store.addRevocation(tx, "mandate", mandateId, now);
    }
    await audit({
      at: now,
      actor: "api",
      action: "mandate.revoked",
      subject: mandateId,
      payload: { known: existing !== null, agent_id: existing?.agent_id ?? null },
    });
  });
}

// ------------------------------------------------------------------ treasury & owner

/**
 * Register the org treasury (`treasury.set`, subject = org id, payload =
 * `{ account_id }`, signed by the pinned owner): the only address a savings
 * sweep may go to. The account id is pinned to its address; an address that
 * belongs to an agent account or to another org's treasury is refused.
 */
export async function setTreasury(ctx: ServiceContext, input: SetTreasuryInternal): Promise<void> {
  assertIds({ org_id: input.org_id, account_id: input.account_id });
  assertChain(ctx, input.chain_id);
  assertNotCosignerKey(ctx, input.owner_address, "The owner key");
  assertNotCosignerKey(ctx, input.treasury_address, "The treasury");
  if (sameAddress(input.treasury_address, ctx.config.revenueAddress)) {
    throw new AgentBankError("invalid_request", "The treasury must not be the Agent Bank revenue address");
  }
  const now = ctx.clock.now();
  await transaction(ctx, async (tx, audit) => {
    await store.bindOrg(tx, input.org_id, input.owner_address, now);
    const verified = await verifyOwner(
      ctx,
      tx,
      input.org_id,
      input.owner_address,
      input.owner_authorization,
      ownerPayloads.treasurySet(input.org_id, input.account_id),
      now,
    );
    const existing = await store.getTreasury(tx, input.org_id);
    for (const held of await store.findTreasuryHolding(tx, input.account_id, input.treasury_address)) {
      const sameAccount = held.account_id === input.account_id;
      if (
        held.org_id !== input.org_id ||
        (sameAccount && !sameAddress(held.address, input.treasury_address))
      ) {
        throw new AgentBankError(
          "forbidden",
          `Treasury account ${input.account_id} or address ${input.treasury_address} is already pinned elsewhere`,
        );
      }
    }
    if (
      (await store.getAccount(tx, input.account_id)) !== null ||
      (await store.getAccountByAddress(tx, input.chain_id, input.treasury_address)) !== null
    ) {
      throw new AgentBankError("forbidden", "An agent account cannot be registered as the org treasury");
    }
    if (
      existing &&
      existing.account_id === input.account_id &&
      sameAddress(existing.address, input.treasury_address)
    )
      return;
    await consumeAuthorization(tx, verified, `treasury:${input.org_id}:${input.account_id}`, now);
    await store.upsertTreasury(tx, {
      org_id: input.org_id,
      account_id: input.account_id,
      address: input.treasury_address,
      signed_by: verified.signer,
      set_at: now,
    });
    await audit({
      at: now,
      actor: `owner:${verified.signer}`,
      action: "treasury.set",
      subject: input.org_id,
      payload: {
        account_id: input.account_id,
        treasury_address: getAddress(input.treasury_address),
        previous: existing
          ? { account_id: existing.account_id, address: getAddress(existing.address) }
          : null,
        authorization_digest: verified.digest,
      },
    });
  });
}

/**
 * Voluntary owner rotation (`owner.rotate`, subject = org id, payload =
 * `{ new_owner_address }`), authorized by the **current** pinned owner. The
 * only off-chain way to change an org's owner key; recovery of a lost key is
 * on-chain (guardians) plus an operator runbook.
 */
export async function rotateOwner(ctx: ServiceContext, input: RotateOwnerInternal): Promise<void> {
  assertIds({ org_id: input.org_id });
  assertChain(ctx, input.chain_id);
  assertNotCosignerKey(ctx, input.new_owner_address, "The new owner key");
  const now = ctx.clock.now();
  const action = ownerPayloads.ownerRotate(input.org_id, input.new_owner_address);
  const ref = `owner:${input.org_id}:${input.new_owner_address.toLowerCase()}`;
  await transaction(ctx, async (tx, audit) => {
    const pinned = await store.getOrgOwner(tx, input.org_id);
    if (pinned === null) throw new AgentBankError("not_found", `Unknown org ${input.org_id}`);
    if (sameAddress(pinned, input.new_owner_address)) {
      // An identical retry of a rotation that already happened gets the same answer.
      const retried = await verifyOwnerAction({
        authorization: input.owner_authorization,
        owner: input.owner_address,
        chainId: ctx.config.ownerAuthorizationChainId ?? ctx.config.chainId,
        action,
        now: Math.floor(now.getTime() / 1000),
        verifier: ctx.verifier,
      });
      if ((await store.getAuthorizationUse(tx, retried.digest))?.ref === ref) return;
      throw new AgentBankError(
        "invalid_request",
        `${input.new_owner_address} is already the owner of ${input.org_id}`,
      );
    }
    const verified = await verifyOwner(
      ctx,
      tx,
      input.org_id,
      input.owner_address,
      input.owner_authorization,
      action,
      now,
    );
    await consumeAuthorization(tx, verified, ref, now);
    await store.rotateOrgOwner(tx, input.org_id, input.new_owner_address);
    await audit({
      at: now,
      actor: `owner:${verified.signer}`,
      action: "owner.rotated",
      subject: input.org_id,
      payload: {
        previous_owner: getAddress(pinned),
        new_owner: getAddress(input.new_owner_address),
        authorization_digest: verified.digest,
      },
    });
  });
}

// ------------------------------------------------------------------ freezes

/** Freeze immediately. Always allowed (it only tightens), also for targets not seen yet; cancels a pending unfreeze. */
export async function freeze(ctx: ServiceContext, input: FreezeInternal): Promise<void> {
  assertIds({ id: input.id });
  const now = ctx.clock.now();
  await transaction(ctx, async (tx, audit) => {
    const active = await store.activeFreeze(tx, input.scope, input.id, now, true);
    let action = "freeze";
    let freezeId: bigint;
    let cancelledUnfreeze: string | null = null;
    if (active) {
      freezeId = active.id;
      if (active.unfreeze_effective_at) {
        cancelledUnfreeze = active.unfreeze_effective_at.toISOString();
        await store.cancelUnfreeze(tx, active.id);
        action = "freeze.unfreeze_cancelled";
      } else {
        action = "freeze.repeated";
      }
    } else {
      freezeId = (await store.insertFreeze(tx, input.scope, input.id, input.reason, now)).id;
    }
    await audit({
      at: now,
      actor: "api",
      action,
      subject: `${input.scope}:${input.id}`,
      payload: {
        scope: input.scope,
        id: input.id,
        reason: input.reason,
        freeze_id: freezeId.toString(),
        cancelled_unfreeze_effective_at: cancelledUnfreeze,
      },
    });
  });
}

async function orgOfTarget(tx: SqlClient, scope: store.FreezeScope, id: string): Promise<string | null> {
  if (scope === "org") return (await store.getOrgOwner(tx, id)) === null ? null : id;
  if (scope === "agent") return store.getAgentOrg(tx, id);
  return (await store.getSession(tx, id))?.org_id ?? null;
}

/**
 * Unfreezing is a loosening: it needs the owner's authorization and takes
 * effect after 1 hour; a freeze in the meantime cancels it. Canonical
 * payloads: `org.unfreeze` (subject org id) and `agent.unfreeze` (subject
 * agent id; for a session freeze, the session id), payload `{ reason }`.
 */
export async function unfreeze(
  ctx: ServiceContext,
  input: UnfreezeInternal,
): Promise<{ effective_at: string }> {
  assertIds({ id: input.id });
  assertChain(ctx, input.chain_id);
  const now = ctx.clock.now();
  return transaction(ctx, async (tx, audit) => {
    const orgId = await orgOfTarget(tx, input.scope, input.id);
    if (orgId === null)
      throw new AgentBankError("not_found", `The co-signer does not know ${input.scope} ${input.id}`);
    const action =
      input.scope === "org"
        ? ownerPayloads.orgUnfreeze(input.id, input.reason)
        : ownerPayloads.agentUnfreeze(input.id, input.reason);
    const verified = await verifyOwner(
      ctx,
      tx,
      orgId,
      input.owner_address,
      input.owner_authorization,
      action,
      now,
    );
    const used = await store.getAuthorizationUse(tx, verified.digest);
    if (used) {
      // An identical retry gets the same answer; anything else is a replay.
      const prior = used.ref.startsWith("unfreeze:")
        ? await store.getFreeze(tx, BigInt(used.ref.slice("unfreeze:".length)))
        : null;
      if (prior?.unfreeze_effective_at && prior.scope === input.scope && prior.target_id === input.id) {
        return { effective_at: prior.unfreeze_effective_at.toISOString() };
      }
      throw new AgentBankError("conflict", "This owner authorization was already used");
    }
    const active = await store.activeFreeze(tx, input.scope, input.id, now, true);
    if (!active) throw new AgentBankError("invalid_state", `${input.scope} ${input.id} is not frozen`);
    if (active.unfreeze_effective_at) return { effective_at: active.unfreeze_effective_at.toISOString() };
    const effective = new Date(now.getTime() + LOOSENING_DELAY_SECONDS * 1000);
    await store.scheduleUnfreeze(tx, active.id, {
      requestedAt: now,
      effectiveAt: effective,
      reason: input.reason,
      signedBy: verified.signer,
    });
    await consumeAuthorization(tx, verified, `unfreeze:${active.id}`, now);
    await audit({
      at: now,
      actor: `owner:${verified.signer}`,
      action: "unfreeze.scheduled",
      subject: `${input.scope}:${input.id}`,
      payload: {
        scope: input.scope,
        id: input.id,
        reason: input.reason,
        freeze_id: active.id.toString(),
        effective_at: effective.toISOString(),
        authorization_digest: verified.digest,
      },
    });
    return { effective_at: effective.toISOString() };
  });
}
