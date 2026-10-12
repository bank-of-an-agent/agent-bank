import { AgentBankError, formatAmount, isAgentBankError, isId } from "@agentbank/core";
import type { JournalEntry, JournalLine } from "@agentbank/ledger";
import type { AccountRow } from "../db/rows";
import { all, one } from "../db/sql";
import { loadAccount } from "../domain/access";
import { ASSET } from "../domain/ledger-refs";
import type { AppDeps } from "../deps";
import type { AuthContext } from "../http/auth";
import { RawResponse, type Handlers } from "../http/registry";
import { decimal, iso, type Wire } from "../serializers";
import { periodWindow } from "../util/time";
import type * as R from "@agentbank/core/api";

const signed = (minor: bigint): string => formatAmount(minor, 6);

function idOrNull(kind: Parameters<typeof isId>[0], value: string | null): string | null {
  return value !== null && isId(kind, value) ? value : null;
}

/**
 * Ledger lines as the caller may see them: lines of the account itself in full, system lines
 * with `account_id: null`, lines of accounts in the caller's own org in full (principals), and
 * every other account's line redacted to `counterparty`.
 */
async function visibleLines(
  deps: AppDeps,
  auth: AuthContext,
  account: AccountRow,
  lines: readonly JournalLine[],
): Promise<Wire<typeof R.LedgerLine>[]> {
  const sameOrg = new Map<string, boolean>();
  const out: Wire<typeof R.LedgerLine>[] = [];
  for (const line of lines) {
    if (line.ownerRef === account.id) {
      out.push({
        ledger_account: line.code,
        account_id: account.id,
        amount: signed(line.amount),
        asset: "USDC",
      });
      continue;
    }
    if (line.ownerRef === "system") {
      out.push({ ledger_account: line.code, account_id: null, amount: signed(line.amount), asset: "USDC" });
      continue;
    }
    let visible = false;
    if (auth.kind === "principal") {
      if (!sameOrg.has(line.ownerRef)) {
        const row = await one(deps.db, "SELECT 1 AS x FROM account WHERE id = $1 AND org_id = $2", [
          line.ownerRef,
          auth.orgId,
        ]);
        sameOrg.set(line.ownerRef, row !== undefined);
      }
      visible = sameOrg.get(line.ownerRef) === true;
    }
    out.push(
      visible
        ? { ledger_account: line.code, account_id: line.ownerRef, amount: signed(line.amount), asset: "USDC" }
        : { ledger_account: "counterparty", account_id: null, amount: signed(line.amount), asset: "USDC" },
    );
  }
  return out;
}

async function entryView(
  deps: AppDeps,
  auth: AuthContext,
  account: AccountRow,
  entry: JournalEntry,
): Promise<Wire<typeof R.LedgerEntry>> {
  return {
    id: entry.id,
    object: "ledger_entry",
    ref_type: entry.refType,
    ref_id: entry.refId,
    memo: entry.memo,
    payment_id: idOrNull("payment", entry.paymentId),
    agent_id: idOrNull("agent", entry.agentId),
    mandate_id: idOrNull("mandate", entry.mandateId),
    decision_id: idOrNull("decision", entry.decisionId),
    reverses_entry_id: idOrNull("entry", entry.reversesEntryId),
    lines: await visibleLines(deps, auth, account, entry.lines),
    created_at: iso(entry.createdAt),
  };
}

/** Net change of the account's pockets in an entry (zero for moves between its own pockets). */
function netFor(account: AccountRow, entry: JournalEntry): bigint {
  let net = 0n;
  for (const line of entry.lines) if (line.ownerRef === account.id) net += line.amount;
  return net;
}

function describe(entry: JournalEntry): string {
  if (entry.memo) return entry.memo;
  const ref = entry.refId ? ` ${entry.refId}` : "";
  return `${entry.refType}${ref}`;
}

async function accountTotalAt(deps: AppDeps, account: AccountRow, at: Date): Promise<bigint> {
  let pockets;
  try {
    pockets = await deps.ledger.listAccounts(account.id, ASSET);
  } catch (error) {
    if (isAgentBankError(error) && error.code === "not_found") return 0n;
    throw error;
  }
  let total = 0n;
  for (const p of pockets) total += await deps.ledger.balanceAt(p, at);
  return total;
}

function csvField(value: string | null): string {
  const v = value ?? "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const ledgerHandlers: Pick<Handlers, "listEntries" | "getStatement"> = {
  async listEntries({ params, query }, { deps, auth }) {
    const account = await loadAccount(deps.db, auth, params.id);
    let page;
    try {
      page = await deps.ledger.listEntries(
        { ownerRef: account.id, asset: ASSET, ...(query.payment_id ? { paymentId: query.payment_id } : {}) },
        { cursor: query.cursor ?? null, limit: query.limit },
      );
    } catch (error) {
      if (isAgentBankError(error) && error.code === "invalid_request")
        throw new AgentBankError("invalid_request", "Invalid pagination cursor");
      throw error;
    }
    const data = [];
    for (const entry of page.entries) data.push(await entryView(deps, auth, account, entry));
    return { data, next_cursor: page.nextCursor };
  },

  async getStatement({ query }, { deps, auth, now }) {
    const account = await loadAccount(deps.db, auth, query.account_id);
    const window = periodWindow(query.period);
    const entries: JournalEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await deps.ledger.listEntries(
        { ownerRef: account.id, asset: ASSET, since: window.start, until: window.end },
        { cursor, limit: 500 },
      );
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    entries.reverse(); // oldest first
    const opening = await accountTotalAt(deps, account, new Date(window.start.getTime() - 1));
    let balance = opening;
    let totalIn = 0n;
    let totalOut = 0n;
    const lines: Wire<typeof R.Statement>["lines"] = [];
    for (const entry of entries) {
      const net = netFor(account, entry);
      if (net === 0n) continue; // holds and other moves between the account's own pockets
      balance += net;
      if (net > 0n) totalIn += net;
      else totalOut -= net;
      lines.push({
        entry_id: entry.id,
        date: iso(entry.createdAt),
        description: describe(entry),
        amount: signed(net),
        balance: signed(balance),
        ref_type: entry.refType,
        ref_id: entry.refId,
      });
    }
    const fees = await all<{ total: bigint | null }>(
      deps.db,
      "SELECT sum(amount)::bigint AS total FROM fee_charge WHERE account_id = $1 AND created_at >= $2 AND created_at < $3",
      [account.id, window.start, window.end],
    );
    const statement: Wire<typeof R.Statement> = {
      id: `stm_${query.period}_${account.id}`,
      object: "statement",
      account_id: account.id,
      period: query.period,
      asset: "USDC",
      opening_balance: decimal(opening < 0n ? 0n : opening),
      closing_balance: decimal(balance < 0n ? 0n : balance),
      total_in: decimal(totalIn),
      total_out: decimal(totalOut),
      fees: decimal(fees[0]?.total ?? 0n),
      entry_count: lines.length,
      lines,
      generated_at: iso(now),
    };
    if (query.format !== "csv") return statement;
    const header = ["entry_id", "date", "description", "amount", "balance", "ref_type", "ref_id"];
    const rows = lines.map((l) =>
      [l.entry_id, l.date, l.description, l.amount, l.balance, l.ref_type, l.ref_id].map(csvField).join(","),
    );
    const summary = [
      `# account,${account.id}`,
      `# period,${query.period}`,
      `# opening_balance,${statement.opening_balance}`,
      `# closing_balance,${statement.closing_balance}`,
      `# total_in,${statement.total_in}`,
      `# total_out,${statement.total_out}`,
      `# fees,${statement.fees}`,
    ];
    const csv = [...summary, header.join(","), ...rows].join("\r\n") + "\r\n";
    return new RawResponse(csv, "text/csv; charset=utf-8", 200, {
      "content-disposition": `attachment; filename="statement-${account.id}-${query.period}.csv"`,
    });
  },
};
