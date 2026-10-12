import { AgentBankError, unixSeconds, verifyRequest, type ErrorCode } from "@agentbank/core";
import type { OperationId, RouteDef } from "@agentbank/core/api";
import type { FastifyRequest } from "fastify";
import { one } from "../db/sql";
import type { MemberRole, SessionStatus } from "../db/rows";
import type { AppDeps } from "../deps";
import { applyDueUnfreezes } from "../domain/freeze";
import { safeEqual, sha256Hex } from "../util/crypto";

/**
 * Authentication and authorization of API callers.
 *
 * | Caller    | Credential                                                       |
 * | --------- | ---------------------------------------------------------------- |
 * | principal | `Authorization: Bearer abk_test_…` (SHA-256 stored) or console cookie |
 * | agent     | RFC 9421 signature by a live session key (`keyid` = session id)  |
 * | approver  | a principal whose member role / key scope allows `approvals:decide` |
 * | staff     | `Authorization: Bearer <STAFF_TOKEN>` (internal dashboards only) |
 *
 * Every query that follows is scoped to the caller's org; agents may only touch their own
 * agent and the account their session belongs to.
 */

export const API_KEY_SCOPES = [
  "admin",
  "agents:write",
  "payments:read",
  "approvals:decide",
  "ledger:read",
  "webhooks:write",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** `read` is satisfied by any principal credential. */
export type Permission = ApiKeyScope | "read";

/** Name of the httpOnly console session cookie. */
export const SESSION_COOKIE = "agentbank_session";

export interface PublicAuth {
  kind: "public";
}

export interface StaffAuth {
  kind: "staff";
}

export interface PrincipalAuth {
  kind: "principal";
  via: "api_key" | "console";
  orgId: string;
  /** The member acting (console user, or the member an API key was issued to). */
  memberId: string | null;
  memberRole: MemberRole | null;
  apiKeyId: string | null;
  consoleSessionId: string | null;
  scopes: ReadonlySet<ApiKeyScope>;
}

export interface AgentAuth {
  kind: "agent";
  orgId: string;
  agentId: string;
  /** The account the signing session belongs to; agents act only on this account. */
  accountId: string;
  sessionId: string;
  publicKey: string;
}

export type AuthContext = PublicAuth | StaffAuth | PrincipalAuth | AgentAuth;

/** Permission each principal route requires (API key scope, or `read` for any credential). */
export const ROUTE_PERMISSIONS: Partial<Record<OperationId, Permission>> = {
  getCurrentOrg: "read",
  startKyb: "admin",
  freezeOrg: "agents:write",
  unfreezeOrg: "admin",
  createTreasuryAccount: "admin",
  setTreasury: "admin",
  listApiKeys: "admin",
  createApiKey: "admin",
  revokeApiKey: "admin",
  listMembers: "read",
  createMember: "admin",
  createAgent: "agents:write",
  listAgents: "read",
  getAgent: "read",
  freezeAgent: "agents:write",
  unfreezeAgent: "agents:write",
  createAccount: "agents:write",
  listAccounts: "read",
  getAccount: "read",
  getBalances: "ledger:read",
  createSession: "agents:write",
  getSession: "read",
  revokeSession: "agents:write",
  installSession: "agents:write",
  getOwnerOperation: "read",
  submitOwnerSignature: "agents:write",
  createMandate: "agents:write",
  getMandate: "read",
  revokeMandate: "agents:write",
  getPolicy: "read",
  putPolicy: "agents:write",
  checkPolicy: "read",
  listPayments: "payments:read",
  getPayment: "payments:read",
  cancelPayment: "agents:write",
  createPaymentRequest: "agents:write",
  getPaymentRequest: "payments:read",
  registerX402Payee: "agents:write",
  getEscrow: "payments:read",
  releaseEscrow: "agents:write",
  refundEscrow: "agents:write",
  disputeEscrow: "agents:write",
  getStream: "payments:read",
  cancelStream: "agents:write",
  listApprovals: "payments:read",
  getApproval: "payments:read",
  decideApproval: "approvals:decide",
  listEntries: "ledger:read",
  getStatement: "ledger:read",
  createVault: "agents:write",
  listVaults: "ledger:read",
  getVault: "ledger:read",
  depositVault: "agents:write",
  withdrawVault: "admin",
  getAutoTopUp: "read",
  putAutoTopUp: "admin",
  listFunds: "read",
  putSweepRule: "admin",
  createWebhookEndpoint: "webhooks:write",
  listWebhookEndpoints: "webhooks:write",
  deleteWebhookEndpoint: "webhooks:write",
  listEvents: "read",
  getSubscription: "read",
  changePlan: "admin",
  getFees: "ledger:read",
  listSessions: "read",
  listMandates: "read",
  listOwnerOperations: "read",
  prepareOwnerSwap: "admin",
  listEscrows: "payments:read",
  listStreams: "payments:read",
  listAutoTopUpRules: "read",
  getSweepRule: "read",
  attachSpendKey: "agents:write",
  sandboxFaucet: "agents:write",
  getProofSettings: "read",
  updateProofSettings: "agents:write",
  getProofIdentity: "read",
  listProofReservations: "read",
  getProofReservation: "read",
  releaseProofReservation: "agents:write",
};

const ROLE_SCOPES: Record<MemberRole, readonly ApiKeyScope[]> = {
  admin: API_KEY_SCOPES,
  approver: ["payments:read", "ledger:read", "approvals:decide"],
  viewer: ["payments:read", "ledger:read"],
};

export function scopesForRole(role: MemberRole): ReadonlySet<ApiKeyScope> {
  return new Set(ROLE_SCOPES[role]);
}

export function hasPermission(auth: PrincipalAuth, permission: Permission): boolean {
  if (permission === "read") return true;
  return auth.scopes.has("admin") || auth.scopes.has(permission);
}

function forbid(detail: string, code: ErrorCode = "forbidden"): never {
  throw new AgentBankError(code, detail);
}

// ---------------------------------------------------------------- credentials

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = headerValue(request, "authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/**
 * A stable fingerprint of the credential a request presents (not verified), used as the rate
 * limit key so limits apply per credential rather than per IP.
 */
export function credentialFingerprint(request: FastifyRequest): string {
  const input = headerValue(request, "signature-input");
  if (input) {
    const keyid = /keyid="([^"]+)"/.exec(input)?.[1];
    if (keyid) return `session:${keyid}`;
  }
  const bearer = bearerToken(request);
  if (bearer) return `bearer:${sha256Hex(bearer).slice(0, 32)}`;
  const cookie = request.cookies?.[SESSION_COOKIE];
  if (cookie) return `console:${sha256Hex(cookie).slice(0, 32)}`;
  return `ip:${request.ip}`;
}

/** The absolute URL the agent signed: `PUBLIC_BASE_URL` + path, or the request's own URL. */
export function targetUri(request: FastifyRequest, publicBaseUrl: string | undefined): string {
  if (publicBaseUrl) return `${publicBaseUrl}${request.url}`;
  return `${request.protocol}://${request.host}${request.url}`;
}

// ---------------------------------------------------------------- authenticate

interface ApiKeyLookup {
  id: string;
  org_id: string;
  scopes: string[];
  revoked_at: Date | null;
  member_id: string | null;
  member_role: MemberRole | null;
  last_used_at: Date | null;
}

async function authenticateApiKey(deps: AppDeps, secret: string, now: Date): Promise<PrincipalAuth> {
  const row = await one<ApiKeyLookup>(
    deps.db,
    `SELECT k.id, k.org_id, k.scopes, k.revoked_at, k.member_id, k.last_used_at, m.role AS member_role
       FROM api_key k LEFT JOIN member m ON m.id = k.member_id
      WHERE k.secret_hash = $1`,
    [sha256Hex(secret)],
  );
  if (!row || row.revoked_at !== null) throw new AgentBankError("unauthorized", "Invalid or revoked API key");
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > 60_000) {
    await deps.db.query("UPDATE api_key SET last_used_at = $2 WHERE id = $1", [row.id, now]);
  }
  const scopes = new Set(
    row.scopes.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s)),
  );
  return {
    kind: "principal",
    via: "api_key",
    orgId: row.org_id,
    memberId: row.member_id,
    memberRole: row.member_role,
    apiKeyId: row.id,
    consoleSessionId: null,
    scopes,
  };
}

interface ConsoleLookup {
  id: string;
  member_id: string;
  org_id: string;
  role: MemberRole;
  last_seen_at: Date | null;
}

async function authenticateConsole(
  deps: AppDeps,
  request: FastifyRequest,
  token: string,
  now: Date,
): Promise<PrincipalAuth> {
  const row = await one<ConsoleLookup>(
    deps.db,
    `SELECT s.id, s.member_id, s.org_id, s.last_seen_at, m.role
       FROM console_session s JOIN member m ON m.id = s.member_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [sha256Hex(token), now],
  );
  if (!row) throw new AgentBankError("unauthorized", "Console session expired or invalid; sign in again");
  // Cookie-authenticated writes must come from the console origin (CSRF defense in depth on
  // top of SameSite=Strict and CORS).
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = headerValue(request, "origin");
    const allowed = deps.config.consoleOrigin;
    if (origin !== undefined && allowed !== undefined && origin !== allowed) {
      forbid("Cross-origin request rejected");
    }
  }
  if (!row.last_seen_at || now.getTime() - row.last_seen_at.getTime() > 60_000) {
    await deps.db.query("UPDATE console_session SET last_seen_at = $2 WHERE id = $1", [row.id, now]);
  }
  return {
    kind: "principal",
    via: "console",
    orgId: row.org_id,
    memberId: row.member_id,
    memberRole: row.role,
    apiKeyId: null,
    consoleSessionId: row.id,
    scopes: scopesForRole(row.role),
  };
}

interface SessionLookup {
  id: string;
  account_id: string;
  public_key: string;
  status: SessionStatus;
  expires_at: Date;
  revoked_at: Date | null;
  agent_id: string | null;
  org_id: string;
}

async function authenticateAgent(deps: AppDeps, request: FastifyRequest, now: Date): Promise<AgentAuth> {
  let session: SessionLookup | undefined;
  const headers: Record<string, string> = {};
  for (const name of Object.keys(request.headers)) {
    const v = headerValue(request, name);
    if (v !== undefined) headers[name] = v;
  }
  await verifyRequest(
    {
      method: request.method,
      url: targetUri(request, deps.config.publicBaseUrl),
      headers,
      body: request.rawBody ?? null,
    },
    {
      now: unixSeconds(now),
      resolveKey: async (keyId) => {
        session = await one<SessionLookup>(
          deps.db,
          `SELECT s.id, s.account_id, s.public_key, s.status, s.expires_at, s.revoked_at, a.agent_id, a.org_id
             FROM session_key s JOIN account a ON a.id = s.account_id
            WHERE s.id = $1`,
          [keyId],
        );
        if (!session || session.agent_id === null) return undefined;
        if (session.revoked_at !== null || session.status === "revoked") {
          throw new AgentBankError("session_revoked", "Session key was revoked");
        }
        if (session.status === "expired" || session.expires_at.getTime() <= now.getTime()) {
          throw new AgentBankError("session_expired", "Session key expired");
        }
        return session.public_key as `0x${string}`;
      },
      checkAndStoreNonce: async (keyId, nonce, expires) => {
        const { rows } = await deps.db.query<{ nonce: string }>(
          `INSERT INTO request_nonce (key_id, nonce, expires_at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING nonce`,
          [keyId, nonce, new Date(expires * 1000)],
        );
        return rows.length === 0;
      },
    },
  );
  if (!session || session.agent_id === null) throw new AgentBankError("unauthorized", "Unknown session");
  return {
    kind: "agent",
    orgId: session.org_id,
    agentId: session.agent_id,
    accountId: session.account_id,
    sessionId: session.id,
    publicKey: session.public_key,
  };
}

interface StatusLookup {
  agent_status: "active" | "frozen";
  agent_unfreeze_at: Date | null;
  org_status: "active" | "frozen";
  org_unfreeze_at: Date | null;
}

/** Frozen agents (or agents of a frozen org) may read but not write. */
async function assertAgentMayWrite(deps: AppDeps, auth: AgentAuth, now: Date): Promise<void> {
  let row = await one<StatusLookup>(
    deps.db,
    `SELECT g.status AS agent_status, g.pending_unfreeze_at AS agent_unfreeze_at,
            o.status AS org_status, o.pending_unfreeze_at AS org_unfreeze_at
       FROM agent g JOIN org o ON o.id = g.org_id WHERE g.id = $1`,
    [auth.agentId],
  );
  if (!row) throw new AgentBankError("unauthorized", "Unknown agent");
  const due = (at: Date | null) => at !== null && at.getTime() <= now.getTime();
  if (
    (row.agent_status === "frozen" && due(row.agent_unfreeze_at)) ||
    (row.org_status === "frozen" && due(row.org_unfreeze_at))
  ) {
    await applyDueUnfreezes(deps, now);
    row = (await one<StatusLookup>(
      deps.db,
      `SELECT g.status AS agent_status, g.pending_unfreeze_at AS agent_unfreeze_at,
              o.status AS org_status, o.pending_unfreeze_at AS org_unfreeze_at
         FROM agent g JOIN org o ON o.id = g.org_id WHERE g.id = $1`,
      [auth.agentId],
    )) as StatusLookup;
  }
  if (row.org_status === "frozen") throw new AgentBankError("org_frozen", "The organization is frozen");
  if (row.agent_status === "frozen") throw new AgentBankError("agent_frozen", "The agent is frozen");
}

/**
 * Authenticate a request for a route and check the route-level permission. Routes that only
 * allow `public` ignore credentials entirely.
 */
export async function authenticate(
  request: FastifyRequest,
  def: RouteDef,
  deps: AppDeps,
  now: Date,
): Promise<AuthContext> {
  const allowed = new Set(def.auth);
  if (allowed.size === 1 && allowed.has("public")) return { kind: "public" };

  const bearer = bearerToken(request);
  if (allowed.has("staff")) {
    const token = deps.config.staffToken;
    if (!bearer) throw new AgentBankError("unauthorized", "Staff token required");
    if (!token || !safeEqual(bearer, token)) throw new AgentBankError("unauthorized", "Invalid staff token");
    return { kind: "staff" };
  }

  const signed = request.headers["signature-input"] !== undefined || request.headers.signature !== undefined;
  if (signed) {
    if (!allowed.has("agent")) forbid("Agents cannot call this operation");
    const auth = await authenticateAgent(deps, request, now);
    if (request.method !== "GET" && request.method !== "HEAD") await assertAgentMayWrite(deps, auth, now);
    return auth;
  }

  const principalAllowed = allowed.has("principal") || allowed.has("approver");
  let principal: PrincipalAuth | undefined;
  if (bearer) {
    if (!principalAllowed) {
      if (allowed.has("public")) return { kind: "public" };
      forbid(
        allowed.has("agent")
          ? "This operation must be signed by an agent session key (RFC 9421)"
          : "This credential cannot call this operation",
      );
    }
    principal = await authenticateApiKey(deps, bearer, now);
  } else {
    const cookie = request.cookies?.[SESSION_COOKIE];
    if (cookie && principalAllowed) principal = await authenticateConsole(deps, request, cookie, now);
  }

  if (!principal) {
    if (allowed.has("public")) return { kind: "public" };
    throw new AgentBankError("unauthorized", "Authentication required");
  }

  const permission = ROUTE_PERMISSIONS[def.operationId as OperationId] ?? "admin";
  if (!hasPermission(principal, permission)) {
    forbid(`This credential lacks the "${permission}" scope`);
  }
  return principal;
}

/** Authenticate a principal (API key or console cookie) outside the registry (e.g. `/auth/*`). */
export async function authenticatePrincipal(
  request: FastifyRequest,
  deps: AppDeps,
  now: Date,
): Promise<PrincipalAuth> {
  const bearer = bearerToken(request);
  if (bearer) return authenticateApiKey(deps, bearer, now);
  const cookie = request.cookies?.[SESSION_COOKIE];
  if (cookie) return authenticateConsole(deps, request, cookie, now);
  throw new AgentBankError("unauthorized", "Authentication required");
}

// ---------------------------------------------------------------- guards used by handlers

export function requirePrincipal(auth: AuthContext): PrincipalAuth {
  if (auth.kind !== "principal") forbid("Only principals can perform this operation");
  return auth;
}

export function requireAgent(auth: AuthContext): AgentAuth {
  if (auth.kind !== "agent") forbid("Only agents can perform this operation");
  return auth;
}

/** Org of an authenticated principal or agent. */
export function orgIdOf(auth: AuthContext): string {
  if (auth.kind === "principal" || auth.kind === "agent") return auth.orgId;
  throw new AgentBankError("unauthorized", "Authentication required");
}

/**
 * An approver: a member with the approver or admin role, acting through the console or an
 * API key with `approvals:decide` (or `admin`) that was issued to that member.
 */
export function requireApprover(
  auth: AuthContext,
): PrincipalAuth & { memberId: string; memberRole: MemberRole } {
  const principal = requirePrincipal(auth);
  if (!hasPermission(principal, "approvals:decide"))
    forbid('This credential lacks the "approvals:decide" scope');
  if (!principal.memberId || !principal.memberRole) {
    forbid(
      "Approvals are recorded per member; use a member's console session or an API key issued to a member",
    );
  }
  if (principal.memberRole !== "admin" && principal.memberRole !== "approver") {
    forbid("Only members with the approver or admin role can decide approvals");
  }
  return principal as PrincipalAuth & { memberId: string; memberRole: MemberRole };
}
