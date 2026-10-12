import { streamSettleCall, topUpCall } from "@agentbank/chain";
import { isAgentBankError } from "@agentbank/core";
import { getAddress } from "viem";
import type { AccountRow, AutoTopUpRuleRow, StreamRow } from "../db/rows";
import { all, one } from "../db/sql";
import { contractAddress } from "../domain/chain";
import { relay } from "../domain/followups";
import { pocket } from "../domain/ledger-refs";
import type { AppDeps } from "../deps";

/**
 * Keeper triggers (ADR 0009): permissionless calls a keeper wallet relays. The keeper only pays
 * gas; the contracts decide where funds go (stream payees, the org's own agent accounts). The
 * resulting movements are posted by the reconciler from the contracts' events.
 */

/** Accrued but unsettled amount of a stream at `now` (bigint math, whole intervals only). */
export function accrued(stream: StreamRow, now: Date): bigint {
  const end = stream.stop_at && stream.stop_at.getTime() < now.getTime() ? stream.stop_at : now;
  const elapsed = BigInt(Math.max(0, Math.floor((end.getTime() - stream.start_at.getTime()) / 1000)));
  const intervals = elapsed / BigInt(stream.interval_seconds);
  const total = intervals * stream.amount_per_interval;
  const capped = total > stream.deposit ? stream.deposit : total;
  return capped > stream.settled ? capped - stream.settled : 0n;
}

/** Settle active streams every `settle_every_seconds` (default hourly). */
export async function settleStreams(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const due = await all<StreamRow>(
    deps.db,
    `SELECT * FROM stream WHERE status = 'active' AND onchain_id IS NOT NULL AND pending_action IS NULL
        AND COALESCE(last_settled_at, start_at) + make_interval(secs => settle_every_seconds) <= $1
      ORDER BY last_settled_at NULLS FIRST LIMIT 100`,
    [now],
  );
  let settled = 0;
  for (const stream of due) {
    if (accrued(stream, now) === 0n) {
      await deps.db.query("UPDATE stream SET last_settled_at = $2 WHERE id = $1", [stream.id, now]);
      continue;
    }
    try {
      const txHash = await relay(
        deps,
        streamSettleCall({
          streams: getAddress(stream.contract_address),
          streamId: BigInt(stream.onchain_id as string),
        }),
      );
      await deps.db.query(
        "UPDATE stream SET last_settled_at = $2, tx_hash = $3, updated_at = $2 WHERE id = $1",
        [stream.id, now, txHash],
      );
      settled++;
    } catch (error) {
      deps.logger.warn({ err: error, streamId: stream.id }, "stream settlement failed");
    }
  }
  return settled;
}

const TOPUP_COOLDOWN_MS = 10 * 60_000;

/** Trigger `TopUpExecutor.topUp(treasury, agent)` for agents below their refill threshold. */
export async function triggerTopUps(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const rules = await all<AutoTopUpRuleRow>(deps.db, "SELECT * FROM auto_topup_rule WHERE status = 'active'");
  let triggered = 0;
  for (const rule of rules) {
    if (rule.last_triggered_at && now.getTime() - rule.last_triggered_at.getTime() < TOPUP_COOLDOWN_MS)
      continue;
    const agentAccount = await one<AccountRow>(
      deps.db,
      "SELECT * FROM account WHERE agent_id = $1 AND chain_id = $2 AND role = 'agent'",
      [rule.agent_id, deps.config.chain.id],
    );
    const treasury = await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [
      rule.treasury_account_id,
    ]);
    if (!agentAccount || !treasury) continue;
    let balance: bigint;
    try {
      balance = await deps.ledger.balance(pocket(agentAccount.id, "operating"));
    } catch (error) {
      if (isAgentBankError(error) && error.code === "not_found") continue;
      throw error;
    }
    if (balance >= rule.when_below) continue;
    try {
      const txHash = await relay(
        deps,
        topUpCall({
          executor: contractAddress(deps, "topUpExecutor"),
          treasury: getAddress(treasury.address),
          agent: getAddress(agentAccount.address),
        }),
      );
      await deps.db.query(
        "UPDATE auto_topup_rule SET last_triggered_at = $2, updated_at = $2 WHERE id = $1",
        [rule.id, now],
      );
      deps.logger.info({ ruleId: rule.id, txHash }, "auto top-up triggered");
      triggered++;
    } catch (error) {
      deps.logger.warn({ err: error, ruleId: rule.id }, "auto top-up trigger failed");
    }
  }
  return triggered;
}
