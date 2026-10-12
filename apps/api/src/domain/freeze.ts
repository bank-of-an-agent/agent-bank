import {
  AgentBankError,
  isAgentBankError,
  LOOSENING_DELAY_SECONDS,
  ownerPayloads,
  type OwnerAuthorization,
} from "@agentbank/core";
import type { AgentRow, OrgRow } from "../db/rows";
import { one } from "../db/sql";
import type { AppDeps } from "../deps";
import { requirePrincipal, type AuthContext } from "../http/auth";
import { serializeAgent, serializeOrg } from "../serializers";
import { loadAgent, loadOrg } from "./access";
import { actorOf, audit } from "./audit";
import { deliverCosignerOutbox, enqueueCosigner } from "./cosigner-outbox";
import { emitEvent } from "./events";
import { verifyOwnerAuth } from "./owner-auth";

/**
 * Freezing is a tightening change: it applies at once in the API (frozen agents cannot write)
 * and is pushed to the co-signer through the outbox, so it lands even if the co-signer is
 * briefly down (which already refuses everything while down). Unfreezing is a loosening
 * change: it needs an owner authorization, the co-signer must accept it (fail closed), and it
 * takes effect after a 1-hour delay.
 */

export async function freezeAgent(
  deps: AppDeps,
  auth: AuthContext,
  agentId: string,
  reason: string,
  now: Date,
) {
  const principal = requirePrincipal(auth);
  const { agent, outboxId } = await deps.db.transaction(async (tx) => {
    await loadAgent(tx, principal, agentId);
    const updated = await one<AgentRow>(
      tx,
      `UPDATE agent SET status = 'frozen', frozen_reason = $2, pending_unfreeze_at = NULL
        WHERE id = $1 RETURNING *`,
      [agentId, reason],
    );
    if (!updated) throw new AgentBankError("not_found", "Agent not found");
    await emitEvent(tx, now, { orgId: updated.org_id, type: "agent.frozen", data: serializeAgent(updated) });
    await audit(tx, now, {
      actor: actorOf(auth),
      action: "agent.freeze",
      subject: agentId,
      payload: { reason },
    });
    const id = await enqueueCosigner(tx, now, {
      kind: "freeze",
      payload: { scope: "agent", id: agentId, reason },
    });
    return { agent: updated, outboxId: id };
  });
  await deliverCosignerOutbox(deps, [outboxId]).catch(() => 0);
  return agent;
}

export async function unfreezeAgent(
  deps: AppDeps,
  auth: AuthContext,
  agentId: string,
  body: { reason: string; owner_authorization: OwnerAuthorization },
  now: Date,
) {
  const principal = requirePrincipal(auth);
  const agent = await loadAgent(deps.db, principal, agentId);
  if (agent.status !== "frozen") throw new AgentBankError("invalid_state", "The agent is not frozen");
  const org = await loadOrg(deps.db, principal.orgId);
  await verifyOwnerAuth(deps, {
    ownerAddress: org.owner_address,
    ...ownerPayloads.agentUnfreeze(agentId, body.reason),
    authorization: body.owner_authorization,
    now,
  });
  const result = await deps.cosigner
    .unfreeze({
      scope: "agent",
      id: agentId,
      reason: body.reason,
      chain_id: deps.config.chain.id,
      owner_address: org.owner_address,
      owner_authorization: body.owner_authorization,
    })
    .catch((error: unknown) => {
      // The co-signer learns agents from their policy; its freeze of an unknown agent stays.
      if (isAgentBankError(error) && error.code === "not_found") {
        throw new AgentBankError(
          "invalid_state",
          "The co-signer has no record of this agent yet: set the agent's policy, then unfreeze it",
        );
      }
      throw error;
    });
  const effectiveAt = laterOf(
    new Date(result.effective_at),
    new Date(now.getTime() + LOOSENING_DELAY_SECONDS * 1000),
  );
  return deps.db.transaction(async (tx) => {
    const updated = await one<AgentRow>(
      tx,
      "UPDATE agent SET pending_unfreeze_at = $2 WHERE id = $1 AND status = 'frozen' RETURNING *",
      [agentId, effectiveAt],
    );
    if (!updated) throw new AgentBankError("invalid_state", "The agent is not frozen");
    await audit(tx, now, {
      actor: actorOf(auth),
      action: "agent.unfreeze_requested",
      subject: agentId,
      payload: { reason: body.reason, effective_at: effectiveAt.toISOString() },
    });
    return updated;
  });
}

export async function freezeOrg(deps: AppDeps, auth: AuthContext, reason: string, now: Date) {
  const principal = requirePrincipal(auth);
  const { org, outboxId } = await deps.db.transaction(async (tx) => {
    const updated = await one<OrgRow>(
      tx,
      `UPDATE org SET status = 'frozen', frozen_reason = $2, pending_unfreeze_at = NULL WHERE id = $1 RETURNING *`,
      [principal.orgId, reason],
    );
    if (!updated) throw new AgentBankError("not_found", "Organization not found");
    await emitEvent(tx, now, { orgId: updated.id, type: "org.frozen", data: serializeOrg(updated) });
    await audit(tx, now, {
      actor: actorOf(auth),
      action: "org.freeze",
      subject: updated.id,
      payload: { reason },
    });
    const id = await enqueueCosigner(tx, now, {
      kind: "freeze",
      payload: { scope: "org", id: updated.id, reason },
    });
    return { org: updated, outboxId: id };
  });
  await deliverCosignerOutbox(deps, [outboxId]).catch(() => 0);
  return org;
}

export async function unfreezeOrg(
  deps: AppDeps,
  auth: AuthContext,
  body: { reason: string; owner_authorization: OwnerAuthorization },
  now: Date,
) {
  const principal = requirePrincipal(auth);
  const org = await loadOrg(deps.db, principal.orgId);
  if (org.status !== "frozen") throw new AgentBankError("invalid_state", "The organization is not frozen");
  await verifyOwnerAuth(deps, {
    ownerAddress: org.owner_address,
    ...ownerPayloads.orgUnfreeze(org.id, body.reason),
    authorization: body.owner_authorization,
    now,
  });
  const result = await deps.cosigner.unfreeze({
    scope: "org",
    id: org.id,
    reason: body.reason,
    chain_id: deps.config.chain.id,
    owner_address: org.owner_address,
    owner_authorization: body.owner_authorization,
  });
  const effectiveAt = laterOf(
    new Date(result.effective_at),
    new Date(now.getTime() + LOOSENING_DELAY_SECONDS * 1000),
  );
  return deps.db.transaction(async (tx) => {
    const updated = await one<OrgRow>(
      tx,
      "UPDATE org SET pending_unfreeze_at = $2 WHERE id = $1 AND status = 'frozen' RETURNING *",
      [org.id, effectiveAt],
    );
    if (!updated) throw new AgentBankError("invalid_state", "The organization is not frozen");
    await audit(tx, now, {
      actor: actorOf(auth),
      action: "org.unfreeze_requested",
      subject: org.id,
      payload: { reason: body.reason, effective_at: effectiveAt.toISOString() },
    });
    return updated;
  });
}

function laterOf(a: Date, b: Date): Date {
  if (Number.isNaN(a.getTime())) return b;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Apply unfreezes whose delay has elapsed (worker job; also applied lazily on access). */
export async function applyDueUnfreezes(deps: AppDeps, now: Date): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const agents = await tx.query<AgentRow>(
      `UPDATE agent SET status = 'active', frozen_reason = NULL, pending_unfreeze_at = NULL
        WHERE status = 'frozen' AND pending_unfreeze_at IS NOT NULL AND pending_unfreeze_at <= $1
        RETURNING *`,
      [now],
    );
    for (const agent of agents.rows) {
      await emitEvent(tx, now, { orgId: agent.org_id, type: "agent.unfrozen", data: serializeAgent(agent) });
      await audit(tx, now, { actor: "system", action: "agent.unfrozen", subject: agent.id });
    }
    const orgs = await tx.query<OrgRow>(
      `UPDATE org SET status = 'active', frozen_reason = NULL, pending_unfreeze_at = NULL
        WHERE status = 'frozen' AND pending_unfreeze_at IS NOT NULL AND pending_unfreeze_at <= $1
        RETURNING *`,
      [now],
    );
    for (const org of orgs.rows) {
      await audit(tx, now, { actor: "system", action: "org.unfrozen", subject: org.id });
    }
    return agents.rows.length + orgs.rows.length;
  });
}
