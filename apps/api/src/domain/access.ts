import { AgentBankError } from "@agentbank/core";
import type { SqlClient, SqlParam } from "@agentbank/db";
import type { AccountRow, AgentRow, OrgRow } from "../db/rows";
import { one } from "../db/sql";
import type { AuthContext } from "../http/auth";

/**
 * Scoped lookups. Every read of an org-owned resource goes through one of these so the org
 * scope (and, for agents, the own-agent / own-account restriction) is never forgotten.
 * Resources the caller may not see are reported as `not_found`, never as `forbidden`, so ids
 * of other orgs cannot be probed.
 */

export async function loadOrg(db: SqlClient, orgId: string): Promise<OrgRow> {
  const org = await one<OrgRow>(db, "SELECT * FROM org WHERE id = $1", [orgId]);
  if (!org) throw new AgentBankError("not_found", "Organization not found");
  return org;
}

/** An agent visible to the caller: any agent of a principal's org, or an agent itself. */
export async function loadAgent(
  db: SqlClient,
  auth: AuthContext,
  agentId: string,
  forUpdate = false,
): Promise<AgentRow> {
  if (auth.kind === "agent" && auth.agentId !== agentId)
    throw new AgentBankError("not_found", "Agent not found");
  if (auth.kind !== "agent" && auth.kind !== "principal")
    throw new AgentBankError("not_found", "Agent not found");
  const agent = await one<AgentRow>(
    db,
    `SELECT * FROM agent WHERE id = $1 AND org_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [agentId, auth.orgId],
  );
  if (!agent) throw new AgentBankError("not_found", "Agent not found");
  return agent;
}

/** An account visible to the caller: any account of a principal's org, or an agent's own account. */
export async function loadAccount(db: SqlClient, auth: AuthContext, accountId: string): Promise<AccountRow> {
  if (auth.kind === "agent" && auth.accountId !== accountId) {
    throw new AgentBankError("not_found", "Account not found");
  }
  if (auth.kind !== "agent" && auth.kind !== "principal")
    throw new AgentBankError("not_found", "Account not found");
  const account = await one<AccountRow>(db, "SELECT * FROM account WHERE id = $1 AND org_id = $2", [
    accountId,
    auth.orgId,
  ]);
  if (!account) throw new AgentBankError("not_found", "Account not found");
  return account;
}

/** Account by id without caller scoping (internal use: payees, workers). */
export async function accountById(db: SqlClient, accountId: string): Promise<AccountRow | undefined> {
  return one<AccountRow>(db, "SELECT * FROM account WHERE id = $1", [accountId]);
}

/** The agent account of an agent on a chain, if any. */
export async function agentAccountOnChain(
  db: SqlClient,
  agentId: string,
  chainId: number,
): Promise<AccountRow | undefined> {
  return one<AccountRow>(
    db,
    "SELECT * FROM account WHERE agent_id = $1 AND chain_id = $2 AND role = 'agent'",
    [agentId, chainId],
  );
}

/** A known Agent Bank account (or spend key) at an address on a chain. */
export async function accountByAddress(
  db: SqlClient,
  chainId: number,
  address: string,
): Promise<AccountRow | undefined> {
  return one<AccountRow>(db, "SELECT * FROM account WHERE chain_id = $1 AND lower(address) = lower($2)", [
    chainId,
    address,
  ]);
}

/**
 * WHERE clause (over `alias`, an escrow or stream row) for the rows the caller may list: those
 * whose payer or payee is one of the caller's accounts (an agent: its own account). With
 * `accountId`, only that account's rows (`not_found` when the caller cannot see the account).
 * Returns null when nothing can match. Pushes its parameters onto `params`.
 */
export async function partyClause(
  db: SqlClient,
  auth: AuthContext,
  alias: string,
  accountId: string | undefined,
  params: SqlParam[],
): Promise<string | null> {
  const forAccount = (account: AccountRow): string => {
    params.push(account.id, account.address.toLowerCase());
    return `(${alias}.payer_account_id = $${params.length - 1} OR lower(${alias}.payee_address) = $${params.length})`;
  };
  if (auth.kind === "agent") {
    if (accountId !== undefined && accountId !== auth.accountId) return null;
    return forAccount(await loadAccount(db, auth, auth.accountId));
  }
  if (auth.kind !== "principal") return null;
  if (accountId !== undefined) return forAccount(await loadAccount(db, auth, accountId));
  params.push(auth.orgId);
  return `EXISTS (SELECT 1 FROM account x WHERE x.org_id = $${params.length}
            AND (x.id = ${alias}.payer_account_id OR lower(x.address) = lower(${alias}.payee_address)))`;
}
