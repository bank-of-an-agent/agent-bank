import { AgentBankError, isAgentBankError, newId, ownerPayloads } from "@agentbank/core";
import { getAddress } from "viem";
import type { AccountRow, ApiKeyRow, MemberRow, OrgRow, PlanRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { loadOrg } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { freezeOrg, unfreezeOrg } from "../domain/freeze";
import { verifyOwnerAuth } from "../domain/owner-auth";
import { requirePrincipal } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import type { KybProvider } from "../providers/kyb";
import { serializeApiKey, serializeMember, serializeOrg } from "../serializers";
import { apiKeyDisplayPrefix, newApiKeySecret, sha256Hex } from "../util/crypto";
import { monthWindow } from "../util/time";
import type { SqlClient, SqlParam } from "@agentbank/db";

/** Start (or resume) KYB with the configured provider and record the outcome on the org. */
async function runKyb(db: SqlClient, kyb: KybProvider, org: OrgRow) {
  const result = await kyb.start({
    orgId: org.id,
    legalName: org.legal_name,
    kind: org.kind,
    country: org.country.trim(),
    contactEmail: org.contact_email,
  });
  const updated = await one<OrgRow>(
    db,
    `UPDATE org SET kyc_status = $2, kyc_provider = $3, kyc_reference = $4 WHERE id = $1 RETURNING *`,
    [org.id, result.status, result.provider, result.reference],
  );
  return { org: updated ?? org, result };
}

export const orgHandlers: Pick<
  Handlers,
  | "createOrg"
  | "getCurrentOrg"
  | "startKyb"
  | "freezeOrg"
  | "unfreezeOrg"
  | "setTreasury"
  | "rotateOwner"
  | "listApiKeys"
  | "createApiKey"
  | "revokeApiKey"
  | "listMembers"
  | "createMember"
> = {
  async createOrg({ body }, { deps, now }) {
    if (!deps.config.allowOpenSignup) {
      throw new AgentBankError("forbidden", "Open signup is disabled on this deployment");
    }
    const orgId = newId("org", now.getTime());
    const memberId = newId("member", now.getTime());
    const keyId = newId("apiKey", now.getTime());
    const secret = newApiKeySecret();
    const email = body.contact_email.toLowerCase();
    const period = monthWindow(now);
    const { org, key } = await deps.db.transaction(async (tx) => {
      const org = await one<OrgRow>(
        tx,
        `INSERT INTO org (id, legal_name, kind, country, contact_email, kyc_status, tier, status, owner_address, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'free', 'active', $6, $7) RETURNING *`,
        [orgId, body.legal_name, body.kind, body.country, email, getAddress(body.owner_address), now],
      );
      await tx.query(
        `INSERT INTO member (id, org_id, user_id, email, role, created_at) VALUES ($1, $2, $3, $3, 'admin', $4)`,
        [memberId, orgId, email, now],
      );
      const key = await one<ApiKeyRow>(
        tx,
        `INSERT INTO api_key (id, org_id, name, prefix, secret_hash, scopes, created_at, member_id)
         VALUES ($1, $2, 'Default admin key', $3, $4, $5, $6, $7) RETURNING *`,
        [keyId, orgId, apiKeyDisplayPrefix(secret), sha256Hex(secret), ["admin"], now, memberId],
      );
      await tx.query(
        `INSERT INTO subscription (org_id, plan_code, status, current_period_start, current_period_end, created_at)
         VALUES ($1, 'free', 'active', $2, $3, $4)`,
        [orgId, period.start, period.end, now],
      );
      await audit(tx, now, {
        actor: "public",
        action: "org.create",
        subject: orgId,
        payload: { member_id: memberId },
      });
      return { org: org as OrgRow, key: key as ApiKeyRow };
    });
    let current = org;
    try {
      current = (await runKyb(deps.db, deps.kyb, org)).org;
    } catch (error) {
      deps.logger.warn({ err: error, orgId }, "KYB provider unavailable; org stays pending");
    }
    return new Envelope({ org: serializeOrg(current), api_key: { ...serializeApiKey(key), secret } }, 201);
  },

  async getCurrentOrg(_input, { deps, auth }) {
    const principal = requirePrincipal(auth);
    return serializeOrg(await loadOrg(deps.db, principal.orgId));
  },

  async startKyb(_input, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const org = await loadOrg(deps.db, principal.orgId);
    let outcome;
    try {
      outcome = await runKyb(deps.db, deps.kyb, org);
    } catch {
      throw new AgentBankError("internal", "The verification provider is unavailable; try again later");
    }
    await audit(deps.db, now, {
      actor: actorOf(auth),
      action: "org.kyb_started",
      subject: org.id,
      payload: { provider: outcome.result.provider, status: outcome.result.status },
    });
    return {
      org_id: org.id,
      provider: outcome.result.provider,
      status: outcome.org.kyc_status,
      verification_url: outcome.result.verificationUrl,
    };
  },

  async freezeOrg({ body }, { deps, auth, now }) {
    return serializeOrg(await freezeOrg(deps, auth, body.reason, now));
  },

  async unfreezeOrg({ body }, { deps, auth, now }) {
    return serializeOrg(await unfreezeOrg(deps, auth, body, now));
  },

  async setTreasury({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const org = await loadOrg(deps.db, principal.orgId);
    const account = await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1 AND org_id = $2", [
      body.account_id,
      org.id,
    ]);
    if (!account) throw new AgentBankError("not_found", "Account not found");
    if (account.role !== "treasury") {
      throw new AgentBankError("invalid_request", "Only a treasury account can be the org treasury");
    }
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.treasurySet(org.id, account.id),
      authorization: body.owner_authorization,
      now,
    });
    // The co-signer learns the treasury too (savings sweeps to it), verifying the same authorization.
    await deps.cosigner.setTreasury({
      org_id: org.id,
      chain_id: deps.config.chain.id,
      owner_address: getAddress(org.owner_address),
      account_id: account.id,
      treasury_address: getAddress(account.address),
      owner_authorization: body.owner_authorization,
    });
    const updated = await deps.db.transaction(async (tx) => {
      const row = await one<OrgRow>(tx, "UPDATE org SET treasury_account_id = $2 WHERE id = $1 RETURNING *", [
        org.id,
        account.id,
      ]);
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "org.treasury_set",
        subject: org.id,
        payload: { account_id: account.id },
      });
      return row as OrgRow;
    });
    return serializeOrg(updated);
  },

  async rotateOwner({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const org = await loadOrg(deps.db, principal.orgId);
    const next = getAddress(body.new_owner_address);
    if (next.toLowerCase() === org.owner_address.toLowerCase()) {
      throw new AgentBankError("invalid_request", "new_owner_address is already the owner");
    }
    // Signed by the CURRENT owner key.
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.ownerRotate(org.id, body.new_owner_address),
      authorization: body.owner_authorization,
      now,
    });
    await deps.cosigner
      .rotateOwner({
        org_id: org.id,
        chain_id: deps.config.chain.id,
        owner_address: getAddress(org.owner_address),
        new_owner_address: next,
        owner_authorization: body.owner_authorization,
      })
      .catch((error: unknown) => {
        // Not pinned there yet (no policy, session or treasury so far): the co-signer pins the
        // new owner when it first sees the org. Anything else fails closed.
        if (isAgentBankError(error) && error.code === "not_found") return;
        throw error;
      });
    const updated = await deps.db.transaction(async (tx) => {
      const row = await one<OrgRow>(tx, "UPDATE org SET owner_address = $2 WHERE id = $1 RETURNING *", [
        org.id,
        next,
      ]);
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "org.owner_rotated",
        subject: org.id,
        payload: { previous: org.owner_address, next },
      });
      return row as OrgRow;
    });
    return serializeOrg(updated);
  },

  async listApiKeys({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    const sql = `SELECT * FROM api_key WHERE org_id = $1${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<ApiKeyRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map(serializeApiKey), next_cursor: page.nextCursor };
  },

  async createApiKey({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const secret = newApiKeySecret();
    const id = newId("apiKey", now.getTime());
    const key = await deps.db.transaction(async (tx) => {
      const row = await one<ApiKeyRow>(
        tx,
        `INSERT INTO api_key (id, org_id, name, prefix, secret_hash, scopes, created_at, member_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          id,
          principal.orgId,
          body.name,
          apiKeyDisplayPrefix(secret),
          sha256Hex(secret),
          body.scopes,
          now,
          principal.memberId,
        ],
      );
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "api_key.create",
        subject: id,
        payload: { name: body.name, scopes: body.scopes },
      });
      return row as ApiKeyRow;
    });
    return new Envelope({ ...serializeApiKey(key), secret }, 201);
  },

  async revokeApiKey({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const key = await deps.db.transaction(async (tx) => {
      const existing = await one<ApiKeyRow>(tx, "SELECT * FROM api_key WHERE id = $1 AND org_id = $2", [
        params.id,
        principal.orgId,
      ]);
      if (!existing) throw new AgentBankError("not_found", "API key not found");
      if (existing.revoked_at) return existing;
      const row = await one<ApiKeyRow>(tx, "UPDATE api_key SET revoked_at = $2 WHERE id = $1 RETURNING *", [
        params.id,
        now,
      ]);
      await audit(tx, now, { actor: actorOf(auth), action: "api_key.revoke", subject: params.id });
      return row as ApiKeyRow;
    });
    return serializeApiKey(key);
  },

  async listMembers({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    const sql = `SELECT * FROM member WHERE org_id = $1${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<MemberRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map(serializeMember), next_cursor: page.nextCursor };
  },

  async createMember({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const email = body.email.toLowerCase();
    const id = newId("member", now.getTime());
    const member = await deps.db.transaction(async (tx) => {
      const existing = await one<MemberRow>(tx, "SELECT * FROM member WHERE org_id = $1 AND email = $2", [
        principal.orgId,
        email,
      ]);
      if (existing) throw new AgentBankError("conflict", "A member with this email already exists");
      const row = await one<MemberRow>(
        tx,
        `INSERT INTO member (id, org_id, user_id, email, role, created_at) VALUES ($1, $2, $3, $3, $4, $5) RETURNING *`,
        [id, principal.orgId, email, body.role, now],
      );
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "member.create",
        subject: id,
        payload: { role: body.role },
      });
      return row as MemberRow;
    });
    return new Envelope(serializeMember(member), 201);
  },
};

/** The org's plan (for agent limits and features). */
export async function orgPlan(db: SqlClient, orgId: string): Promise<PlanRow> {
  const plan = await one<PlanRow>(
    db,
    `SELECT p.* FROM subscription s JOIN plan p ON p.code = s.plan_code WHERE s.org_id = $1`,
    [orgId],
  );
  if (plan) return plan;
  const free = await one<PlanRow>(db, "SELECT * FROM plan WHERE code = 'free'");
  if (!free) throw new AgentBankError("internal", "Plans are not configured");
  return free;
}
