import {
  AgentBankError,
  canonicalKeccak,
  isAgentBankError,
  newId,
  ownerPayloads,
  toPositiveMinor,
  unixSeconds,
} from "@agentbank/core";
import type { SqlClient, SqlParam } from "@agentbank/db";
import * as policyEngine from "@agentbank/policy";
import { classifyChange, compileMandate, compilePolicy, requiresOwnerSignature } from "@agentbank/policy";
import { getAddress } from "viem";
import type { MandateRow, PolicyRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { agentAccountOnChain, loadAccount, loadAgent, loadOrg } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { deliverCosignerOutbox, enqueueCosigner } from "../domain/cosigner-outbox";
import { recordDecision } from "../domain/decisions";
import { emitEvent } from "../domain/events";
import { verifyOwnerAuth } from "../domain/owner-auth";
import type { AppDeps } from "../deps";
import { requirePrincipal } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeMandate, serializePolicyVersion, type Wire } from "../serializers";
import type * as R from "@agentbank/core/api";

/** Cumulative settled spend under a mandate (recomputed, so it can never double count). */
export async function mandateSpent(db: SqlClient, mandateId: string): Promise<bigint> {
  const row = await one<{ total: bigint | null }>(
    db,
    "SELECT sum(amount)::bigint AS total FROM payment WHERE mandate_id = $1 AND status = 'settled'",
    [mandateId],
  );
  return row?.total ?? 0n;
}

async function mandateView(db: SqlClient, row: MandateRow, now: Date): Promise<Wire<typeof R.Mandate>> {
  return serializeMandate({ ...row, spent: await mandateSpent(db, row.id) }, now);
}

async function policyView(db: SqlClient, agentId: string, now: Date): Promise<Wire<typeof R.AgentPolicy>> {
  const current = await one<PolicyRow>(
    db,
    "SELECT * FROM policy WHERE agent_id = $1 AND effective_at <= $2 ORDER BY version DESC LIMIT 1",
    [agentId, now],
  );
  const pending = await one<PolicyRow>(
    db,
    "SELECT * FROM policy WHERE agent_id = $1 AND effective_at > $2 AND version > $3 ORDER BY version DESC LIMIT 1",
    [agentId, now, current?.version ?? 0],
  );
  return {
    object: "agent_policy",
    agent_id: agentId,
    current: current ? serializePolicyVersion(current) : null,
    pending: pending ? serializePolicyVersion(pending) : null,
  };
}

/**
 * Whether a change needs the owner's `policy.loosen` authorization: initial, loosening and mixed
 * changes, and any change to `auto_save` (auto-save rules are owner-signed policy).
 */
function needsOwnerSignature(classification: ReturnType<typeof classifyChange>): boolean {
  const helper = (policyEngine as Record<string, unknown>).requiresOwnerSignatureForChange;
  if (typeof helper === "function") return Boolean((helper as (c: unknown) => boolean)(classification));
  return (
    requiresOwnerSignature(classification.kind) ||
    classification.neutral.some((path) => path === "auto_save" || path.startsWith("auto_save."))
  );
}

async function loadMandate(deps: AppDeps, orgId: string, id: string, agentId?: string): Promise<MandateRow> {
  const row = await one<MandateRow>(
    deps.db,
    `SELECT m.* FROM mandate m JOIN agent g ON g.id = m.agent_id WHERE m.id = $1 AND g.org_id = $2`,
    [id, orgId],
  );
  if (!row || (agentId !== undefined && row.agent_id !== agentId))
    throw new AgentBankError("not_found", "Mandate not found");
  return row;
}

export const authorityHandlers: Pick<
  Handlers,
  | "createMandate"
  | "listMandates"
  | "getMandate"
  | "revokeMandate"
  | "getPolicy"
  | "putPolicy"
  | "checkPolicy"
> = {
  async createMandate({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const agent = await loadAgent(deps.db, principal, body.agent_id);
    const org = await loadOrg(deps.db, principal.orgId);
    const mandate = body.mandate;
    if (mandate.agent_id !== agent.id) {
      throw new AgentBankError(
        "mandate_invalid",
        "mandate.agent_id must be the agent the mandate is granted to",
      );
    }
    if (mandate.exp <= unixSeconds(now))
      throw new AgentBankError("mandate_expired", "The mandate is already expired");
    try {
      compileMandate(mandate);
    } catch (error) {
      throw new AgentBankError(
        "mandate_invalid",
        isAgentBankError(error) ? error.message : "The mandate is not valid",
      );
    }
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.mandateIssue(agent.id, mandate),
      authorization: body.owner_authorization,
      now,
    });
    const id = newId("mandate", now.getTime());
    await deps.cosigner.registerMandate({
      mandate_id: id,
      org_id: org.id,
      agent_id: agent.id,
      chain_id: deps.config.chain.id,
      owner_address: getAddress(org.owner_address),
      mandate,
      owner_authorization: body.owner_authorization,
    });
    const row = await deps.db.transaction(async (tx) => {
      const inserted = (await one<MandateRow>(
        tx,
        `INSERT INTO mandate (id, agent_id, signed_payload, signer, signature, mandate_hash, constraints_json, expires_at,
                              created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          id,
          agent.id,
          mandate,
          getAddress(body.owner_authorization.signer),
          body.owner_authorization.signature,
          canonicalKeccak(mandate),
          mandate.constraints,
          new Date(mandate.exp * 1000),
          now,
        ],
      )) as MandateRow;
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "mandate.issue",
        subject: id,
        payload: { agent_id: agent.id },
      });
      return inserted;
    });
    return new Envelope(await mandateView(deps.db, row, now), 201);
  },

  async listMandates({ query }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    let where = "g.org_id = $1";
    if (query.agent_id) {
      params.push(query.agent_id);
      where += ` AND m.agent_id = $${params.length}`;
    }
    if (query.status === "revoked") {
      where += " AND m.revoked_at IS NOT NULL";
    } else if (query.status) {
      params.push(now);
      where += ` AND m.revoked_at IS NULL AND m.expires_at ${query.status === "expired" ? "<=" : ">"} $${params.length}`;
    }
    const sql = `SELECT m.* FROM mandate m JOIN agent g ON g.id = m.agent_id WHERE ${where}${pageClause(
      decodeCursor(query.cursor),
      query.limit,
      params,
      "m",
    )}`;
    const page = toPage(await all<MandateRow>(deps.db, sql, params), query.limit);
    const data = [];
    for (const row of page.items) data.push(await mandateView(deps.db, row, now));
    return { data, next_cursor: page.nextCursor };
  },

  async getMandate({ params }, { deps, auth, now }) {
    if (auth.kind === "agent") {
      return mandateView(deps.db, await loadMandate(deps, auth.orgId, params.id, auth.agentId), now);
    }
    const principal = requirePrincipal(auth);
    return mandateView(deps.db, await loadMandate(deps, principal.orgId, params.id), now);
  },

  async revokeMandate({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const mandate = await loadMandate(deps, principal.orgId, params.id);
    if (mandate.revoked_at) return mandateView(deps.db, mandate, now);
    const { row, outboxId } = await deps.db.transaction(async (tx) => {
      const updated = (await one<MandateRow>(
        tx,
        "UPDATE mandate SET revoked_at = $2 WHERE id = $1 RETURNING *",
        [mandate.id, now],
      )) as MandateRow;
      await audit(tx, now, { actor: actorOf(auth), action: "mandate.revoke", subject: mandate.id });
      const id = await enqueueCosigner(tx, now, {
        kind: "revoke_mandate",
        payload: { mandate_id: mandate.id },
      });
      return { row: updated, outboxId: id };
    });
    await deliverCosignerOutbox(deps, [outboxId]).catch(() => 0);
    return mandateView(deps.db, row, now);
  },

  async getPolicy({ params }, { deps, auth, now }) {
    const agent = await loadAgent(deps.db, auth, params.id);
    return policyView(deps.db, agent.id, now);
  },

  async putPolicy({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const agent = await loadAgent(deps.db, principal, params.id);
    const org = await loadOrg(deps.db, principal.orgId);
    const policy = body.policy;
    if (policy.agent !== undefined && policy.agent !== agent.id) {
      throw new AgentBankError("invalid_request", "policy.agent must match the agent in the path");
    }
    const latest = await one<PolicyRow>(
      deps.db,
      "SELECT * FROM policy WHERE agent_id = $1 ORDER BY version DESC LIMIT 1",
      [agent.id],
    );
    try {
      compilePolicy(policy, (latest?.version ?? 0) + 1);
    } catch (error) {
      throw new AgentBankError(
        "invalid_request",
        isAgentBankError(error) ? error.message : "The policy is not valid",
      );
    }
    const classification = classifyChange(latest ? (latest.rules_json as never) : null, policy);
    if (needsOwnerSignature(classification) && !body.owner_authorization) {
      throw new AgentBankError(
        "owner_signature_required",
        classification.kind === "initial"
          ? "The first policy of an agent needs an owner authorization (policy.loosen)"
          : "This change loosens limits or changes auto-save rules: an owner authorization (policy.loosen) is required",
      );
    }
    if (body.owner_authorization) {
      await verifyOwnerAuth(deps, {
        ownerAddress: org.owner_address,
        ...ownerPayloads.policyLoosen(agent.id, policy),
        authorization: body.owner_authorization,
        now,
      });
    }
    // The co-signer is authoritative: it classifies the change again, enforces the owner
    // signature and the 1-hour delay, and returns the version it stored.
    const version = await deps.cosigner.putPolicy({
      org_id: org.id,
      agent_id: agent.id,
      chain_id: deps.config.chain.id,
      owner_address: getAddress(org.owner_address),
      policy,
      ...(body.owner_authorization ? { owner_authorization: body.owner_authorization } : {}),
    });
    await deps.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO policy (id, agent_id, version, rules_json, policy_hash, change_kind, effective_at, signed_by,
                             owner_authorization, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (agent_id, version) DO UPDATE SET rules_json = EXCLUDED.rules_json, policy_hash = EXCLUDED.policy_hash,
           change_kind = EXCLUDED.change_kind, effective_at = EXCLUDED.effective_at, signed_by = EXCLUDED.signed_by,
           owner_authorization = EXCLUDED.owner_authorization`,
        [
          newId("policy", now.getTime()),
          agent.id,
          version.version,
          version.policy,
          version.policy_hash,
          version.change_kind,
          new Date(version.effective_at),
          version.signed_by,
          body.owner_authorization ?? null,
          now,
        ],
      );
      const stored = (await one<PolicyRow>(tx, "SELECT * FROM policy WHERE agent_id = $1 AND version = $2", [
        agent.id,
        version.version,
      ])) as PolicyRow;
      await emitEvent(tx, now, {
        orgId: org.id,
        type: "policy.updated",
        data: serializePolicyVersion(stored),
      });
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "policy.put",
        subject: agent.id,
        payload: {
          version: version.version,
          change_kind: version.change_kind,
          effective_at: version.effective_at,
        },
      });
    });
    return policyView(deps.db, agent.id, now);
  },

  async checkPolicy({ body }, { deps, auth, now }) {
    const account = await loadAccount(deps.db, auth, body.account_id);
    if (!account.agent_id) throw new AgentBankError("invalid_request", "Policies apply to agent accounts");
    const intent = body.intent;
    const amount = toPositiveMinor(intent.amount);
    let address = intent.to_address;
    if (!address && intent.to_agent_id) {
      address = (await agentAccountOnChain(deps.db, intent.to_agent_id, account.chain_id))?.address;
    }
    const decision = await deps.cosigner.evaluate({
      org_id: account.org_id,
      agent_id: account.agent_id,
      account_id: account.id,
      account_address: getAddress(account.address),
      chain_id: deps.config.chain.id,
      intent: {
        kind: intent.kind,
        amount: amount.toString(),
        asset: "USDC",
        counterparty: {
          ...(address ? { address: getAddress(address) } : {}),
          ...(intent.to_agent_id ? { agent_id: intent.to_agent_id } : {}),
          ...(intent.erc8004_id ? { erc8004_id: intent.erc8004_id } : {}),
          ...(intent.x402_domain ? { x402_domain: intent.x402_domain } : {}),
          ...(intent.contract ? { contract: getAddress(intent.contract) } : {}),
        },
      },
      ...(intent.mandate_id ? { mandate_id: intent.mandate_id } : {}),
      ...(auth.kind === "agent" ? { session_id: auth.sessionId } : {}),
    });
    const recorded = await recordDecision(deps.db, {
      decision,
      agentId: account.agent_id,
      paymentId: null,
      source: "dry_run",
      now,
    });
    return {
      id: recorded.id,
      outcome: decision.outcome,
      rule_hits: decision.rule_hits,
      approvers_required: decision.approvers_required,
      policy_version: decision.policy_version,
      evaluated_at: decision.evaluated_at,
      ...(decision.retry_at !== undefined ? { retry_at: decision.retry_at } : {}),
    };
  },
};
