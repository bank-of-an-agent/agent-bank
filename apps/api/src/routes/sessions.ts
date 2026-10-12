import {
  onchainScopeFromWire,
  ownerRotationCalls,
  SENTINEL_OWNERS,
  sessionPermissionId,
  sessionRevokeCall,
  sessionSalt,
} from "@agentbank/chain";
import {
  AgentBankError,
  isAgentBankError,
  MAX_SESSION_TTL_SECONDS,
  newId,
  ownerPayloads,
  unixSeconds,
} from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { getAddress, zeroAddress, type Hex } from "viem";
import type { AccountRow, AgentRow, OwnerOperationRow, PaymentRow, SessionRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { loadAccount, loadOrg } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { cosignerAddress, sessionSetupCalls, usdcAddress } from "../domain/chain";
import { deliverCosignerOutbox, enqueueCosigner } from "../domain/cosigner-outbox";
import { emitEvent } from "../domain/events";
import { verifyOwnerAuth } from "../domain/owner-auth";
import {
  insertOwnerOperation,
  loadOwnerOperation,
  prepareOwnerOperation,
  settleCarriedPermit,
  submitOwnerSignature,
} from "../domain/owner-ops";
import { failPayment, markSubmitted } from "../domain/payments";
import { clearVaultPending, processOwnerOperation } from "../domain/receipts";
import type { AppDeps } from "../deps";
import { requirePrincipal, type AuthContext } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeOwnerOperation, serializeSession } from "../serializers";

/** Response header naming an owner operation created as a side effect (see the report). */
export const OWNER_OPERATION_HEADER = "agentbank-owner-operation-id";

async function loadSession(
  deps: AppDeps,
  auth: AuthContext,
  id: string,
): Promise<{ session: SessionRow; account: AccountRow }> {
  const session = await one<SessionRow>(deps.db, "SELECT * FROM session_key WHERE id = $1", [id]);
  if (!session) throw new AgentBankError("not_found", "Session not found");
  const account = await loadAccount(deps.db, auth, session.account_id).catch(() => {
    throw new AgentBankError("not_found", "Session not found");
  });
  return { session, account };
}

function grantFor(deps: AppDeps, session: SessionRow, cosigner: `0x${string}`) {
  return {
    sessionKey: getAddress(session.public_key),
    cosigner,
    salt: sessionSalt(session.id),
    scope: onchainScopeFromWire(session.scope_json as never, {
      token: usdcAddress(deps),
      issuedAt: unixSeconds(session.created_at),
    }),
  };
}

/** SQL for a session's wire status (`expired` is derived from `expires_at`); pushes its params. */
function sessionStatusClause(status: SessionRow["status"], now: Date, params: SqlParam[]): string {
  if (status === "revoked") return "s.status = 'revoked'";
  params.push(now);
  const at = `$${params.length}`;
  if (status === "expired") {
    return `(s.status = 'expired' OR (s.status IN ('active', 'pending_install') AND s.expires_at <= ${at}))`;
  }
  params.push(status);
  return `(s.status = $${params.length} AND s.expires_at > ${at})`;
}

export const sessionHandlers: Pick<
  Handlers,
  | "createSession"
  | "listSessions"
  | "getSession"
  | "revokeSession"
  | "installSession"
  | "listOwnerOperations"
  | "getOwnerOperation"
  | "submitOwnerSignature"
  | "prepareOwnerSwap"
> = {
  async createSession({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const account = await loadAccount(deps.db, principal, body.account_id);
    if (account.role !== "agent" || !account.agent_id) {
      throw new AgentBankError("invalid_request", "Sessions are granted on agent accounts");
    }
    const org = await loadOrg(deps.db, principal.orgId);
    const agent = (await one<AgentRow>(deps.db, "SELECT * FROM agent WHERE id = $1", [
      account.agent_id,
    ])) as AgentRow;
    if (org.status === "frozen") throw new AgentBankError("org_frozen", "The organization is frozen");
    if (agent.status === "frozen") throw new AgentBankError("agent_frozen", "The agent is frozen");
    const expiresAt = new Date(body.scope.expires_at);
    if (expiresAt.getTime() <= now.getTime())
      throw new AgentBankError("invalid_request", "scope.expires_at must be in the future");
    if (expiresAt.getTime() - now.getTime() > MAX_SESSION_TTL_SECONDS * 1000) {
      throw new AgentBankError("invalid_request", "Sessions last at most 7 days");
    }
    const publicKey = getAddress(body.public_key);
    if (
      [account.address, account.owner_address, account.spend_key_address].some(
        (a) => a?.toLowerCase() === publicKey.toLowerCase(),
      )
    ) {
      throw new AgentBankError("invalid_request", "public_key must be a fresh session key");
    }
    // Refills of the x402 float are transfers to the spend key: a session that restricts
    // recipients must allow it (ADR 0001), or every refill would revert on-chain.
    const recipients = body.scope.allowed_recipients;
    if (
      account.spend_key_address &&
      recipients &&
      recipients.length > 0 &&
      !recipients.some((r) => r.toLowerCase() === account.spend_key_address?.toLowerCase())
    ) {
      throw new AgentBankError(
        "invalid_request",
        "scope.allowed_recipients must include the account's spend key (x402 float refills)",
      );
    }
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.sessionGrant({
        account_id: body.account_id,
        public_key: body.public_key,
        scope: body.scope,
      }),
      authorization: body.owner_authorization,
      now,
    });
    const id = newId("session", now.getTime());
    const cosigner = await cosignerAddress(deps);
    const permissionId = sessionPermissionId(
      {
        sessionKey: publicKey,
        cosigner,
        salt: sessionSalt(id),
        scope: onchainScopeFromWire(body.scope, { token: usdcAddress(deps), issuedAt: unixSeconds(now) }),
      },
      deps.chain.contracts,
    );
    // Granting authority is a loosening change: the co-signer must accept it (fail closed).
    await deps.cosigner.registerSession({
      session_id: id,
      org_id: org.id,
      agent_id: account.agent_id,
      account_id: account.id,
      chain_id: deps.config.chain.id,
      account_address: getAddress(account.address),
      owner_address: getAddress(org.owner_address),
      public_key: body.public_key,
      scope: body.scope,
      owner_authorization: body.owner_authorization,
    });
    const session = await deps.db.transaction(async (tx) => {
      const row = await one<SessionRow>(
        tx,
        `INSERT INTO session_key (id, account_id, public_key, scope_json, owner_authorization, status, expires_at,
                                  permission_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending_install', $6, $7, $8) RETURNING *`,
        [id, account.id, publicKey, body.scope, body.owner_authorization, expiresAt, permissionId, now],
      );
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "session.grant",
        subject: id,
        payload: { account_id: account.id, public_key: publicKey, scope: body.scope },
      });
      return row as SessionRow;
    });
    return new Envelope(serializeSession(session, now), 201);
  },

  async listSessions({ query }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    let where = "a.org_id = $1";
    if (query.account_id) {
      params.push(query.account_id);
      where += ` AND s.account_id = $${params.length}`;
    }
    if (query.agent_id) {
      params.push(query.agent_id);
      where += ` AND a.agent_id = $${params.length}`;
    }
    if (query.status) where += ` AND ${sessionStatusClause(query.status, now, params)}`;
    const sql = `SELECT s.* FROM session_key s JOIN account a ON a.id = s.account_id WHERE ${where}${pageClause(
      decodeCursor(query.cursor),
      query.limit,
      params,
      "s",
    )}`;
    const page = toPage(await all<SessionRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map((row) => serializeSession(row, now)), next_cursor: page.nextCursor };
  },

  async getSession({ params }, { deps, auth, now }) {
    const { session } = await loadSession(deps, auth, params.id);
    return serializeSession(session, now);
  },

  async installSession({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const { session, account } = await loadSession(deps, principal, params.id);
    if (session.status === "active") return serializeSession(session, now);
    if (session.status !== "pending_install" || session.revoked_at) {
      throw new AgentBankError("invalid_state", `A ${session.status} session cannot be installed`);
    }
    if (session.expires_at.getTime() <= now.getTime())
      throw new AgentBankError("session_expired", "Session expired");
    if (session.install_operation_id) {
      const op = await one<OwnerOperationRow>(deps.db, "SELECT * FROM owner_operation WHERE id = $1", [
        session.install_operation_id,
      ]);
      if (
        op &&
        (op.status === "submitted" ||
          (op.status === "requires_signature" && op.expires_at.getTime() > now.getTime()))
      ) {
        return serializeSession(session, now);
      }
    }
    const cosigner = await cosignerAddress(deps);
    const { calls, carriesPermit } = await sessionSetupCalls(
      deps,
      account,
      grantFor(deps, session, cosigner),
      now,
    );
    const prepared = await prepareOwnerOperation(deps, account, calls, now, { setsUpAccount: true });
    const updated = await deps.db.transaction(async (tx) => {
      const op = await insertOwnerOperation(tx, {
        account,
        purpose: "session.install",
        subjectId: session.id,
        prepared,
        now,
        carriesPermit,
      });
      return (await one<SessionRow>(
        tx,
        "UPDATE session_key SET install_operation_id = $2 WHERE id = $1 RETURNING *",
        [session.id, op.id],
      )) as SessionRow;
    });
    return serializeSession(updated, now);
  },

  async revokeSession({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const { session, account } = await loadSession(deps, principal, params.id);
    if (session.status === "revoked") return serializeSession(session, now);
    const wasInstalled = session.status === "active";
    const { row, outboxId } = await deps.db.transaction(async (tx) => {
      const updated = (await one<SessionRow>(
        tx,
        "UPDATE session_key SET status = 'revoked', revoked_at = $2 WHERE id = $1 RETURNING *",
        [session.id, now],
      )) as SessionRow;
      await emitEvent(tx, now, {
        orgId: account.org_id,
        type: "session.revoked",
        data: serializeSession(updated, now),
      });
      await audit(tx, now, { actor: actorOf(auth), action: "session.revoke", subject: session.id });
      const id = await enqueueCosigner(tx, now, {
        kind: "revoke_session",
        payload: { session_id: session.id },
      });
      return { row: updated, outboxId: id };
    });
    await deliverCosignerOutbox(deps, [outboxId]).catch(() => 0);
    // Off-chain revocation is immediate. On-chain removal (revoke_operation_id, signed by the
    // owner key) is the hard backstop.
    const headers: Record<string, string> = {};
    let result = row;
    if (wasInstalled && session.permission_id) {
      try {
        const prepared = await prepareOwnerOperation(
          deps,
          account,
          [
            sessionRevokeCall({
              contracts: deps.chain.contracts,
              permissionId: session.permission_id as Hex,
            }),
          ],
          now,
        );
        result = await deps.db.transaction(async (tx) => {
          const op = await insertOwnerOperation(tx, {
            account,
            purpose: "session.revoke",
            subjectId: session.id,
            prepared,
            now,
          });
          headers[OWNER_OPERATION_HEADER] = op.id;
          return (await one<SessionRow>(
            tx,
            "UPDATE session_key SET revoke_operation_id = $2 WHERE id = $1 RETURNING *",
            [session.id, op.id],
          )) as SessionRow;
        });
      } catch (error) {
        deps.logger.warn(
          { err: error, sessionId: session.id },
          "could not prepare on-chain session revocation",
        );
      }
    }
    return new Envelope(serializeSession(result, now), 200, headers);
  },

  async listOwnerOperations({ query }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    let where = "a.org_id = $1";
    if (query.account_id) {
      params.push(query.account_id);
      where += ` AND o.account_id = $${params.length}`;
    }
    // `expired` is derived for unsigned operations past their deadline (the worker persists it).
    if (query.status === "expired") {
      params.push(now);
      where += ` AND (o.status = 'expired' OR (o.status = 'requires_signature' AND o.expires_at <= $${params.length}))`;
    } else if (query.status === "requires_signature") {
      params.push(now);
      where += ` AND o.status = 'requires_signature' AND o.expires_at > $${params.length}`;
    } else if (query.status) {
      params.push(query.status);
      where += ` AND o.status = $${params.length}`;
    }
    const sql = `SELECT o.* FROM owner_operation o JOIN account a ON a.id = o.account_id WHERE ${where}${pageClause(
      decodeCursor(query.cursor),
      query.limit,
      params,
      "o",
    )}`;
    const page = toPage(await all<OwnerOperationRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map((row) => serializeOwnerOperation(row, now)), next_cursor: page.nextCursor };
  },

  async prepareOwnerSwap({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const account = await loadAccount(deps.db, principal, params.id);
    const oldOwner = getAddress(account.owner_address);
    const newOwner = getAddress(body.new_owner_address);
    if (newOwner === oldOwner) {
      throw new AgentBankError("invalid_request", "new_owner_address is already the account's owner");
    }
    const cosigner = await cosignerAddress(deps);
    const forbidden = [zeroAddress, SENTINEL_OWNERS, account.address, account.spend_key_address, cosigner];
    if (forbidden.some((a) => a !== null && a.toLowerCase() === newOwner.toLowerCase())) {
      throw new AgentBankError("invalid_request", "new_owner_address must be a key the principal holds");
    }
    const pending = await one<OwnerOperationRow>(
      deps.db,
      `SELECT * FROM owner_operation WHERE account_id = $1 AND purpose = 'owner.swap'
          AND (status = 'submitted' OR (status = 'requires_signature' AND expires_at > $2))`,
      [account.id, now],
    );
    if (pending) {
      throw new AgentBankError(
        "conflict",
        `An owner swap is already pending for this account (owner operation ${pending.id})`,
        { owner_operation_id: pending.id },
      );
    }
    // One owner operation signed by the current key rotates both owner records: the Safe owner
    // (native exit path) and the OwnableValidator owner (owner operations). The account's hook
    // allowlists the OwnableValidator (`policyHookConfig`), so the batch passes it.
    const prepared = await prepareOwnerOperation(
      deps,
      account,
      ownerRotationCalls({
        account: getAddress(account.address),
        contracts: deps.chain.contracts,
        currentOwner: oldOwner,
        newOwner,
      }),
      now,
    );
    const op = await deps.db.transaction(async (tx) => {
      const row = await insertOwnerOperation(tx, {
        account,
        purpose: "owner.swap",
        subjectId: newOwner,
        prepared,
        now,
      });
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "account.owner_swap_prepared",
        subject: account.id,
        payload: { owner_operation_id: row.id, old_owner_address: oldOwner, new_owner_address: newOwner },
      });
      return row;
    });
    return new Envelope(serializeOwnerOperation(op, now), 201);
  },

  async getOwnerOperation({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    return serializeOwnerOperation(await loadOwnerOperation(deps.db, principal.orgId, params.id), now);
  },

  async submitOwnerSignature({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const op = await loadOwnerOperation(deps.db, principal.orgId, params.id);
    if (op.status === "submitted" || op.status === "succeeded") return serializeOwnerOperation(op, now);
    if (op.status !== "requires_signature") {
      throw new AgentBankError("invalid_state", `The owner operation is ${op.status}`);
    }
    let userOpHash: `0x${string}`;
    try {
      ({ userOpHash } = await submitOwnerSignature(deps, op, body.signature, now));
    } catch (error) {
      if (isAgentBankError(error) && error.code === "invalid_state") {
        // Stale (nonce or deadline): this operation can never be submitted; prepare a new one.
        await deps.db.query("UPDATE owner_operation SET status = 'failed', updated_at = $2 WHERE id = $1", [
          op.id,
          now,
        ]);
        await settleCarriedPermit(deps.db, op, "expired", now);
        await clearVaultPending(deps.db, op.id);
        if (op.purpose === "payment") {
          const payment = await one<PaymentRow>(
            deps.db,
            "SELECT * FROM payment WHERE owner_operation_id = $1",
            [op.id],
          );
          if (payment && payment.status === "requires_signature") {
            await failPayment(
              deps,
              payment,
              `Owner operation went stale: ${error.message}`.slice(0, 500),
              now,
            );
          }
        }
      }
      throw error;
    }
    await deps.db.transaction(async (tx) => {
      await tx.query("UPDATE owner_operation SET status = 'submitted', updated_at = $2 WHERE id = $1", [
        op.id,
        now,
      ]);
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "owner_operation.submit",
        subject: op.id,
        payload: { purpose: op.purpose },
      });
    });
    if (op.purpose === "payment") {
      const payment = await one<PaymentRow>(deps.db, "SELECT * FROM payment WHERE owner_operation_id = $1", [
        op.id,
      ]);
      if (payment && payment.status === "requires_signature")
        await markSubmitted(deps, payment, userOpHash, now);
    }
    const processed = await processOwnerOperation(deps, op.id, now);
    return serializeOwnerOperation(processed, now);
  },
};
