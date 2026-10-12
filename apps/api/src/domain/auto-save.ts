import { isAgentBankError } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { LedgerAccountRef } from "@agentbank/ledger";
import {
  compilePolicy,
  excessAboveMaxBalance,
  incomeSplit,
  roundUp,
  scheduledDue,
  type CompiledPolicy,
  type SaveAction,
} from "@agentbank/policy";
import type { AccountRow, PaymentRow, PolicyRow, VaultRow } from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import { pocket, vaultPocketRef } from "./ledger-refs";

/**
 * Auto-save (owner-signed policy rules, `auto_save`): ledger-only moves inside one account.
 * `treasury` targets go to `pocket:savings` (swept to the org treasury with an outgoing
 * operation), `vault:<id>` targets to that goal vault's pocket. Income split and round-up run
 * when a payment settles; scheduled saves and the excess sweep (`max_balance`) run in the worker.
 */

/** The agent's policy in effect at `now` (the API's display copy of the co-signer's policy). */
export async function effectivePolicy(
  db: SqlClient,
  agentId: string,
  now: Date,
): Promise<PolicyRow | undefined> {
  return one<PolicyRow>(
    db,
    "SELECT * FROM policy WHERE agent_id = $1 AND effective_at <= $2 ORDER BY version DESC LIMIT 1",
    [agentId, now],
  );
}

async function compiled(db: SqlClient, agentId: string, now: Date): Promise<CompiledPolicy | null> {
  const row = await effectivePolicy(db, agentId, now);
  if (!row) return null;
  try {
    return compilePolicy(row.rules_json as never, row.version);
  } catch {
    return null;
  }
}

async function targetRef(
  db: SqlClient,
  account: AccountRow,
  action: SaveAction,
): Promise<LedgerAccountRef | null> {
  if (action.to === "treasury") return pocket(account.id, "savings");
  const vaultId = action.to.slice("vault:".length);
  const vault = await one<VaultRow>(db, "SELECT * FROM vault WHERE id = $1 AND account_id = $2", [
    vaultId,
    account.id,
  ]);
  if (!vault || vault.kind !== "goal") return null; // locked vaults need an on-chain deposit
  return vaultPocketRef(account.id, vault.id);
}

async function move(
  deps: AppDeps,
  account: AccountRow,
  action: SaveAction,
  key: string,
  refId: string,
): Promise<boolean> {
  const to = await targetRef(deps.db, account, action);
  if (!to) return false;
  try {
    await deps.ledger.post({
      idempotencyKey: key,
      lines: [
        { account: pocket(account.id, "operating"), amount: -action.amount },
        { account: to, amount: action.amount },
      ],
      refType: "auto_save",
      refId,
      agentId: account.agent_id,
      memo: `Auto-save (${action.rule})`,
      metadata: { rule: action.rule },
    });
    return true;
  } catch (error) {
    if (isAgentBankError(error) && (error.code === "insufficient_funds" || error.code === "not_found"))
      return false;
    throw error;
  }
}

export async function applyIncomeSplit(
  deps: AppDeps,
  account: AccountRow,
  inbound: bigint,
  sourceRef: string,
  now: Date,
): Promise<boolean> {
  if (!account.agent_id) return false;
  const policy = await compiled(deps.db, account.agent_id, now);
  const action = policy ? incomeSplit(policy, inbound) : null;
  if (!action) return false;
  return move(deps, account, action, `autosave:income_split:${sourceRef}:${account.id}`, sourceRef);
}

export async function applyRoundUp(deps: AppDeps, payment: PaymentRow, now: Date): Promise<boolean> {
  if (!payment.agent_id) return false;
  const policy = await compiled(deps.db, payment.agent_id, now);
  const action = policy ? roundUp(policy, payment.amount) : null;
  if (!action) return false;
  const account = await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [payment.account_id]);
  if (!account) return false;
  return move(deps, account, action, `autosave:round_up:${payment.id}`, payment.id);
}

/** Worker job: scheduled saves and the excess sweep for every agent account with a policy. */
export async function runAutoSave(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const accounts = await all<AccountRow>(
    deps.db,
    `SELECT a.* FROM account a JOIN agent g ON g.id = a.agent_id
      WHERE a.role = 'agent' AND g.status = 'active' AND a.chain_id = $1
        AND EXISTS (SELECT 1 FROM policy p WHERE p.agent_id = a.agent_id)`,
    [deps.config.chain.id],
  );
  let moved = 0;
  for (const account of accounts) {
    const policy = await compiled(deps.db, account.agent_id as string, now);
    if (!policy) continue;
    const runs = await all<{ rule_key: string; last_run_at: Date }>(
      deps.db,
      "SELECT rule_key, last_run_at FROM auto_save_run WHERE agent_id = $1",
      [account.agent_id],
    );
    const last: Record<string, Date> = {};
    for (const r of runs) last[r.rule_key] = r.last_run_at;
    for (const action of scheduledDue(policy, last, now)) {
      if (
        await move(
          deps,
          account,
          action,
          `autosave:scheduled:${account.id}:${action.key}:${now.getTime()}`,
          action.key,
        )
      ) {
        moved++;
      }
      await deps.db.query(
        `INSERT INTO auto_save_run (agent_id, rule_key, last_run_at) VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, rule_key) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
        [account.agent_id, action.key, now],
      );
    }
    try {
      const balance = await deps.ledger.balance(pocket(account.id, "operating"));
      const excess = excessAboveMaxBalance(policy, balance);
      if (
        excess &&
        (await move(deps, account, excess, `autosave:excess:${account.id}:${now.getTime()}`, account.id))
      ) {
        moved++;
      }
    } catch (error) {
      deps.logger.warn({ err: error, accountId: account.id }, "excess sweep failed");
    }
  }
  return moved;
}
