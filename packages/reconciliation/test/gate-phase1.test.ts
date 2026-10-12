import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAmount } from "@agentbank/core";
import type { Address, Hex, LocalAccount } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { SimBank, usd, type SimAccount } from "./support/sim-bank";

/**
 * Phase 1 gate (design § Implementation plan): "10,000 simulated deposits and transfers
 * reconcile with zero drift, including injected reorgs."
 *
 * Random deposits (faucet mints, transfers and EIP-3009 payments from outside Agent Bank),
 * payments between Agent Bank accounts and to external addresses (session key + co-signer, or
 * owner signatures), x402 payments from spend keys and spend-key refills run on the
 * `SimulatedChain` while the real indexer loop pushes evidence to the real reconciler; reorgs of
 * depth 1–5 are injected throughout (same order, shuffled, dropped and re-queued, dropped for
 * good). At the end every watched address must hold on-chain exactly what the ledger says, the
 * ledger's invariants must hold, suspense must be zero and every chain event must match at most
 * one entry.
 *
 * GATE_MOVEMENTS (default 10,000, InMemoryLedger), GATE_PG_MOVEMENTS (default 1,000,
 * PostgresLedger on PGlite, or PostgreSQL when DATABASE_URL is set) and GATE_SEED tune the run.
 * `pnpm --filter @agentbank/reconciliation gate` (GATE_EVIDENCE=1) rewrites
 * docs/gates/evidence/phase-1-reconciliation.md after a full-size run where every run passed;
 * `pnpm test` (CI) runs the same gate without touching the file.
 */

const MOVEMENTS = Number(process.env.GATE_MOVEMENTS ?? 10_000);
const PG_MOVEMENTS = Number(process.env.GATE_PG_MOVEMENTS ?? 1_000);
const SEED = Number(process.env.GATE_SEED ?? 20261011);
const EVIDENCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/gates/evidence/phase-1-reconciliation.md",
);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type MovementKind =
  | "deposit.faucet"
  | "deposit.transfer"
  | "deposit.eip3009_x402_sale"
  | "deposit.spend_key"
  | "payment.agent_to_agent"
  | "payment.external"
  | "x402.external"
  | "x402.agent"
  | "refill";

interface Summary {
  ledger: "memory" | "postgres";
  database: string;
  seed: number;
  movements: number;
  byKind: Record<string, number>;
  bySigner: { session: number; owner: number };
  large: number;
  skipped: number;
  reorgs: {
    total: number;
    byDepth: Record<number, number>;
    byMode: Record<string, number>;
    orphanedBlocks: number;
  };
  payments: { settled: number; failed: number; open: number };
  chain: {
    blocks: bigint;
    transactions: Record<string, number>;
    events: Record<string, number>;
    matchedEvents: number;
  };
  reconciler: Record<string, number>;
  ledgerStats: { accounts: number; entries: number; lines: number; holds: number };
  balances: { addresses: number; mismatches: number; totalOnchain: bigint };
  violations: { ledger: number; reconciliation: number };
  suspense: bigint;
  revenue: bigint;
  indexer: { ticks: number; reorgsDetected: number; orphanedBlocks: number; eventsPushed: number };
  runtimeMs: number;
  startedAt: string;
}

async function runGate(ledger: "memory" | "postgres", movements: number, seed: number): Promise<Summary> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const bank = await SimBank.create({
    ledger,
    automine: false,
    finalityDepth: 12,
    indexerDatabase: "separate",
  });
  try {
    // ---------------------------------------------------------------- population
    const accounts: SimAccount[] = [];
    /** Agents registered as x402 sellers (they pay the 0.5% receive fee on facilitator sales). */
    const payees402 = new Set<string>();
    const orgCount = movements >= 5_000 ? 6 : 3;
    for (let o = 0; o < orgCount; o++) {
      const org = await bank.createOrg();
      for (let i = 0; i < 6; i++) {
        const account = await bank.createAccount(org, { spendKey: i % 2 === 0, x402Payee: i % 3 === 0 });
        if (i % 3 === 0) payees402.add(account.id);
        accounts.push(account);
      }
    }
    // A quarter of the agents sign with a session key + the co-signer; the rest use the owner key.
    for (const [i, account] of accounts.entries()) {
      if (i % 4 === 0) await bank.installSession(account);
    }
    bank.chain.mine();
    const buyers: LocalAccount[] = Array.from({ length: 6 }, () => bank.externalWallet(usd(100_000_000)));
    const payees: Address[] = Array.from(
      { length: 24 },
      (_, i) => `0x${(0xe0000 + i).toString(16).padStart(40, "0")}` as Address,
    );
    for (const account of accounts) {
      bank.faucet(account.address, usd(20 + Math.floor(rand() * 80)));
      if (account.spendKey) bank.faucet(account.spendKey.address, usd(5 + Math.floor(rand() * 20)));
    }
    bank.chain.mine();
    await bank.sync();

    // ---------------------------------------------------------------- movements
    const summary: Summary = {
      ledger,
      database: await databaseOf(bank),
      seed,
      movements,
      byKind: {},
      bySigner: { session: 0, owner: 0 },
      large: 0,
      skipped: 0,
      reorgs: { total: 0, byDepth: {}, byMode: {}, orphanedBlocks: 0 },
      payments: { settled: 0, failed: 0, open: 0 },
      chain: { blocks: 0n, transactions: {}, events: {}, matchedEvents: 0 },
      reconciler: {},
      ledgerStats: { accounts: 0, entries: 0, lines: 0, holds: 0 },
      balances: { addresses: 0, mismatches: 0, totalOnchain: 0n },
      violations: { ledger: 0, reconciliation: 0 },
      suspense: 0n,
      revenue: 0n,
      indexer: { ticks: 0, reorgsDetected: 0, orphanedBlocks: 0, eventsPushed: 0 },
      runtimeMs: 0,
      startedAt,
    };
    const pendingOps = new Set<string>();
    let nonce = 0;
    let executed = 0;
    const count = (kind: MovementKind) => {
      executed++;
      summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
    };
    /** Mostly small amounts; 3% at or above the $100 finality threshold. */
    const amount = (max: bigint): bigint => {
      if (rand() < 0.03 && max >= usd(100)) {
        summary.large++;
        const span = (max < usd(400) ? max : usd(400)) - usd(100);
        return usd(100) + BigInt(Math.floor(rand() * Number(span / 10_000n))) * 10_000n;
      }
      const cap = max < usd(50) ? max : usd(50);
      return 10_000n + BigInt(Math.floor(rand() * Number(cap / 10_000n))) * 10_000n;
    };
    const ready = (account: SimAccount) => {
      if (pendingOps.has(account.id)) {
        bank.chain.mine();
        pendingOps.clear();
      }
    };
    const reorg = (): void => {
      if (bank.chain.pendingCount > 0) bank.chain.mine();
      pendingOps.clear();
      const room = Number(bank.chain.head.number - bank.chain.resolveTag("finalized"));
      const depth = Math.min(1 + Math.floor(rand() * 5), room);
      if (depth < 1) return;
      const m = rand();
      const mode = m < 0.65 ? "same" : m < 0.8 ? "shuffle" : m < 0.92 ? "drop+requeue" : "drop";
      const result = bank.chain.injectReorg(depth, {
        ...(mode === "shuffle" ? { order: "shuffle" as const, seed: Math.floor(rand() * 1e9) } : {}),
        ...(mode === "drop+requeue" ? { drop: "all" as const, requeue: true } : {}),
        ...(mode === "drop" ? { drop: "all" as const } : {}),
      });
      summary.reorgs.total++;
      summary.reorgs.byDepth[depth] = (summary.reorgs.byDepth[depth] ?? 0) + 1;
      summary.reorgs.byMode[mode] = (summary.reorgs.byMode[mode] ?? 0) + 1;
      summary.reorgs.orphanedBlocks += result.removed.length;
      if (mode === "drop+requeue") bank.chain.mine();
    };
    let nextSync = 10;
    // Exactly `movements` executed movements; attempts that find no funds yet are skipped.
    for (let i = 0; executed < movements; i++) {
      if (i > movements * 2) throw new Error(`only ${executed} movements executed in ${i} attempts`);
      bank.tick(1 + Math.floor(rand() * 3));
      const roll = rand();
      const account = pick(accounts);
      try {
        if (roll < 0.3) {
          // Deposits from outside Agent Bank.
          const r = rand();
          const big = rand() < 0.04;
          const value = big
            ? usd(100 + Math.floor(rand() * 400))
            : 10_000n + BigInt(Math.floor(rand() * 4_000)) * 10_000n;
          if (big) summary.large++;
          if (r < 0.3) {
            bank.faucet(account.address, value);
            count("deposit.faucet");
          } else if (r < 0.65) {
            bank.externalTransfer(pick(buyers), account.address, value);
            count("deposit.transfer");
          } else if (r < 0.85) {
            // An x402 sale settled by Agent Bank's facilitator (the seller pays the receive fee).
            await bank.authorizedTransfer(
              pick(buyers),
              account.address,
              value,
              `0x${(++nonce).toString(16).padStart(64, "0")}` as Hex,
              { payeeAccountId: payees402.has(account.id) ? account.id : null },
            );
            count("deposit.eip3009_x402_sale");
          } else if (account.spendKey) {
            bank.faucet(account.spendKey.address, value / 10n + 1n);
            count("deposit.spend_key");
          } else {
            bank.faucet(account.address, value);
            count("deposit.faucet");
          }
        } else if (roll < 0.7) {
          // Session/owner-signed payments between agents and to external addresses.
          const available = await bank.available(account);
          if (available < 20_000n) {
            summary.skipped++;
            continue;
          }
          const value = amount((available * 99n) / 100n - 10_000n);
          ready(account);
          const path = account.session && rand() < 0.35 ? "session" : "owner";
          if (roll < 0.5) {
            let payee = pick(accounts);
            if (payee.id === account.id)
              payee = accounts[(accounts.indexOf(payee) + 1) % accounts.length] as SimAccount;
            await bank.pay(account, payee.address, value, { toAccount: payee, path });
            count("payment.agent_to_agent");
          } else {
            await bank.pay(account, pick(payees), value, { path });
            count("payment.external");
          }
          summary.bySigner[path]++;
          pendingOps.add(account.id);
        } else if (roll < 0.88) {
          // x402 from the spend key's float.
          const payer = account.spendKey ? account : (accounts.find((a) => a.spendKey) as SimAccount);
          const float = await bank.available(payer, "spend");
          if (float < 20_000n) {
            summary.skipped++;
            continue;
          }
          const cap = float < usd(5) ? float : usd(5);
          const value = 10_000n + BigInt(Math.floor(rand() * Number((cap - 10_000n) / 10_000n))) * 10_000n;
          if (rand() < 0.7) {
            await bank.x402(payer, pick(payees), value);
            count("x402.external");
          } else {
            const seller =
              accounts.find((a) => a.id !== payer.id && rand() < 0.2) ?? (accounts[0] as SimAccount);
            await bank.x402(payer, seller.address, value);
            count("x402.agent");
          }
        } else {
          // Spend-key refills from the smart account.
          const payer = account.spendKey ? account : (accounts.find((a) => a.spendKey) as SimAccount);
          const available = await bank.available(payer);
          if (available < 1_000_000n) {
            summary.skipped++;
            continue;
          }
          ready(payer);
          const cap = available / 2n < usd(10) ? available / 2n : usd(10);
          const value = 10_000n + BigInt(Math.floor(rand() * Number(cap / 10_000n))) * 10_000n;
          const path = payer.session && rand() < 0.35 ? "session" : "owner";
          await bank.refill(payer, value, path);
          summary.bySigner[path]++;
          pendingOps.add(payer.id);
          count("refill");
        }
      } catch (error) {
        // The chain refused the operation (e.g. a nonce reused across a reorg): the hold was voided.
        summary.skipped++;
        if (process.env.GATE_DEBUG) console.warn("movement refused:", (error as Error).message);
        continue;
      }

      if (rand() < 0.45) {
        bank.chain.mine();
        pendingOps.clear();
      }
      // Reorgs of depth 1–5 of blocks the indexer has not seen yet...
      if (rand() < 0.01) reorg();
      if (i >= nextSync) {
        nextSync = i + 5 + Math.floor(rand() * 25);
        if (bank.chain.pendingCount > 0) {
          bank.chain.mine();
          pendingOps.clear();
        }
        const ticks = (await bank.sync()) as unknown[];
        summary.indexer.ticks += ticks.length;
        await bank.apiWorker();
        // ...and of blocks it has already reconciled.
        if (rand() < 0.3) reorg();
      }
    }

    // ---------------------------------------------------------------- drain and check
    await bank.settleAll();
    const comparison = await bank.compareBalances();
    const mismatches = comparison.filter((c) => c.onchain !== c.expected);
    summary.balances = {
      addresses: comparison.length,
      mismatches: mismatches.length,
      totalOnchain: comparison.reduce((s, c) => s + c.onchain, 0n),
    };
    const invariants = await bank.ledger.verifyInvariants();
    const reconciliation = await bank.reconciler.verify();
    summary.suspense = await bank.suspense();
    summary.revenue = await bank.ledger.balance({ ownerRef: "system", code: "sys:revenue", asset: "USDC" });
    summary.ledgerStats = {
      accounts: invariants.accounts,
      entries: invariants.entries,
      lines: invariants.lines,
      holds: invariants.holds,
    };
    const statuses = await bank.db.query<{ status: string; n: bigint }>(
      "SELECT status, count(*) AS n FROM payment GROUP BY status",
    );
    for (const row of statuses.rows) {
      if (row.status === "settled") summary.payments.settled = Number(row.n);
      else if (row.status === "failed") summary.payments.failed = Number(row.n);
      else summary.payments.open += Number(row.n);
    }
    const txs = await bank.db.query<{ status: string; n: bigint }>(
      "SELECT status, count(*) AS n FROM chain_tx GROUP BY status",
    );
    const events = await bank.db.query<{ outcome: string; n: bigint }>(
      `SELECT CASE WHEN status = 'processed' THEN result ELSE status END AS outcome, count(*) AS n
         FROM chain_event GROUP BY 1`,
    );
    summary.chain = {
      blocks: bank.chain.head.number,
      transactions: Object.fromEntries(txs.rows.map((r) => [r.status, Number(r.n)])),
      events: Object.fromEntries(events.rows.map((r) => [r.outcome, Number(r.n)])),
      matchedEvents: reconciliation.matchedEvents,
    };
    summary.violations = {
      ledger: invariants.violations.length,
      reconciliation: reconciliation.violations.length,
    };
    summary.reconciler = { ...bank.reconciler.stats() } as unknown as Record<string, number>;
    summary.indexer.reorgsDetected = bank.indexer.metrics.value("indexer_reorgs_total");
    summary.indexer.orphanedBlocks = bank.indexer.metrics.value("indexer_orphaned_blocks_total");
    summary.indexer.eventsPushed = bank.indexer.metrics.value("indexer_events_pushed_total");
    summary.runtimeMs = Math.round(performance.now() - started);

    if (mismatches.length > 0) console.error("balance mismatches:", mismatches.slice(0, 10));
    if (!invariants.ok) console.error("ledger invariant violations:", invariants.violations.slice(0, 10));
    if (!reconciliation.ok)
      console.error("reconciliation violations:", reconciliation.violations.slice(0, 10));
    expect(mismatches).toEqual([]);
    expect(invariants.violations).toEqual([]);
    expect(reconciliation.violations).toEqual([]);
    expect(summary.suspense).toBe(0n);
    expect(summary.payments.open).toBe(0);
    expect(summary.reorgs.total).toBeGreaterThan(0);
    return summary;
  } finally {
    await bank.close();
  }
}

async function databaseOf(bank: SimBank): Promise<string> {
  const url = process.env.DATABASE_URL;
  const { rows } = await bank.db.query<{ server_version: string }>("SHOW server_version");
  const version = rows[0]?.server_version.split(" ")[0] ?? "?";
  return url && !url.startsWith("pglite://") ? `PostgreSQL ${version}` : `PGlite (PostgreSQL ${version})`;
}

const results: Summary[] = [];

const fmt = (n: number | bigint): string => n.toLocaleString("en-US");

function usdc(value: bigint): string {
  const [whole = "0", fraction] = formatAmount(value, 6).split(".");
  return `$${fmt(BigInt(whole))}${fraction ? `.${fraction}` : ""}`;
}

/** A two-column Markdown table (left, right aligned) padded the way Prettier prints it. */
function table(header: readonly [string, string], rows: readonly (readonly [string, string])[]): string[] {
  const all = [header, ...rows];
  const width = (c: 0 | 1) => Math.max(3, ...all.map((row) => row[c].length));
  const [left, right] = [width(0), width(1)];
  const line = (row: readonly [string, string]) => `| ${row[0].padEnd(left)} | ${row[1].padStart(right)} |`;
  return [line(header), `| ${"-".repeat(left)} | ${"-".repeat(right - 1)}: |`, ...rows.map(line), ""];
}

const passed = (s: Summary): boolean =>
  s.balances.mismatches === 0 &&
  s.suspense === 0n &&
  s.violations.ledger === 0 &&
  s.violations.reconciliation === 0 &&
  s.payments.open === 0;

function render(summaries: readonly Summary[]): string {
  const sum = (f: (s: Summary) => number) => summaries.reduce((total, s) => total + f(s), 0);
  const executed = (s: Summary) => Object.values(s.byKind).reduce((a, b) => a + b, 0);
  const verdict = summaries.every(passed) ? "PASS" : "FAIL";
  const lines: string[] = [
    "# Phase 1 gate evidence: reconciliation",
    "",
    "Gate criterion (design § Implementation plan, Phase 1): **10,000 simulated deposits and transfers reconcile with zero drift, including injected reorgs.**",
    "",
    `**Result: ${verdict}.** ${fmt(sum(executed))} movements in ${summaries.length} runs, ${fmt(sum((s) => s.reorgs.total))} reorgs of depth 1–5 injected (${fmt(sum((s) => s.reorgs.orphanedBlocks))} blocks orphaned), ${fmt(sum((s) => s.balances.mismatches))} balance mismatches, \`sys:suspense\` ${usdc(summaries.reduce((t, s) => t + s.suspense, 0n))}, ${fmt(sum((s) => s.violations.ledger + s.violations.reconciliation))} ledger or reconciliation invariant violations.`,
    "",
    "Generated by `packages/reconciliation/test/gate-phase1.test.ts`. Random deposits, payments, x402 payments and spend-key refills run on the in-memory `SimulatedChain` (production validation rules: owner or session key + co-signer signatures, EIP-3009 authorizations, block finality) while the real indexer loop (`apps/indexer`, with its own database) pushes normalized evidence to the real reconciler (`packages/reconciliation`) in-process; reorgs of depth 1–5 are injected throughout, both ahead of and behind the indexer's cursor, keeping the orphaned transactions in the same order, shuffling them, dropping and re-queueing them, or dropping them for good. The API side (payment rows with an `allow` decision, ledger holds, facilitator records for x402 sales, failing operations that reverted or were dropped) is simulated the way the API does it.",
    "",
    "Reproduce with `pnpm --filter @agentbank/reconciliation gate`, which rewrites this file (`GATE_MOVEMENTS`, `GATE_PG_MOVEMENTS` and `GATE_SEED` tune the run; with `DATABASE_URL` set the bank's database is that PostgreSQL server, otherwise PGlite). `pnpm test` runs the same gate in CI on PostgreSQL 16 without rewriting it.",
    "",
  ];
  for (const s of summaries) {
    const name = s.ledger === "memory" ? "InMemoryLedger" : "PostgresLedger";
    lines.push(
      `## ${name} run: ${fmt(s.movements)} movements, ${passed(s) ? "PASS: zero drift" : "FAIL"}`,
      "",
    );
    lines.push(
      `Seed ${s.seed}; started ${s.startedAt}; runtime ${(s.runtimeMs / 1000).toFixed(1)} s on Node ${process.version} (${platform()} ${arch()}, ${cpus().length} CPUs). Bank database: ${s.database}${s.ledger === "memory" ? "; the ledger is in memory" : ", which also holds the ledger"}. Indexer database: its own PGlite instance.`,
      "",
    );
    lines.push(
      ...table(
        ["Movement", "Count"],
        [
          ...Object.entries(s.byKind)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([kind, n]) => [kind, fmt(n)] as const),
          ["**total executed**", `**${fmt(executed(s))}**`],
          ["attempts skipped (no funds yet, or refused by the chain; not counted)", fmt(s.skipped)],
        ],
      ),
    );
    lines.push(
      `Operations signed by session key + co-signer: ${fmt(s.bySigner.session)}; by the owner key: ${fmt(s.bySigner.owner)}. Movements at or above the $100 finality threshold: ${fmt(s.large)}.`,
      "",
    );
    lines.push(
      ...table(
        ["Reorgs", "Count"],
        [
          ["injected", fmt(s.reorgs.total)],
          ...Object.entries(s.reorgs.byDepth)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([depth, n]) => [`depth ${depth}`, fmt(n)] as const),
          ...Object.entries(s.reorgs.byMode)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([mode, n]) => [`mode: ${mode}`, fmt(n)] as const),
          ["orphaned blocks", fmt(s.reorgs.orphanedBlocks)],
          [
            "detected by the indexer from block hashes (blocks it had indexed)",
            `${fmt(s.indexer.reorgsDetected)} (${fmt(s.indexer.orphanedBlocks)} blocks)`,
          ],
          ["re-included transactions rebound to their new block", fmt(s.reconciler.rebound ?? 0)],
          ["ledger entries reversed", fmt(s.reconciler.reversedEntries ?? 0)],
          ["reversals that had to wait for held funds", fmt(s.reconciler.pendingReversals ?? 0)],
        ],
      ),
    );
    const txs = s.chain.transactions;
    const events = s.chain.events;
    lines.push(
      ...table(
        ["Chain evidence (final state)", "Count"],
        [
          ["blocks mined", fmt(s.chain.blocks)],
          ["transactions reconciled", fmt(txs.processed ?? 0)],
          ["transactions orphaned by a reorg (reversed or rebound)", fmt(txs.reorged ?? 0)],
          ["transactions still deferred", fmt(txs.deferred ?? 0)],
          ["events matched to an expected movement", fmt(events.matched ?? 0)],
          ["events booked as deposits", fmt(events.deposit ?? 0)],
          [
            "events with no ledger effect of their own (e.g. user-operation receipts)",
            fmt(events.ignored ?? 0),
          ],
          ["events orphaned by a reorg", fmt(events.reorged ?? 0)],
          ["events in suspense", `**${fmt(events.suspense ?? 0)}**`],
          ["events pushed by the indexer (including resends)", fmt(s.indexer.eventsPushed)],
          ["indexer ticks", fmt(s.indexer.ticks)],
        ],
      ),
    );
    lines.push(
      ...table(
        ["Result", "Value"],
        [
          [
            "payments settled / failed (reverted or dropped by a reorg) / open",
            `${fmt(s.payments.settled)} / ${fmt(s.payments.failed)} / ${fmt(s.payments.open)}`,
          ],
          [
            "ledger accounts / entries / lines / holds",
            [s.ledgerStats.accounts, s.ledgerStats.entries, s.ledgerStats.lines, s.ledgerStats.holds]
              .map(fmt)
              .join(" / "),
          ],
          ["watched addresses checked (on-chain == expected)", fmt(s.balances.addresses)],
          ["balance mismatches", `**${fmt(s.balances.mismatches)}**`],
          ["USDC held on-chain by watched addresses", usdc(s.balances.totalOnchain)],
          ["`sys:suspense`", `**${usdc(s.suspense)}**`],
          ["`sys:revenue` (fees collected)", usdc(s.revenue)],
          ["ledger invariant violations (`verifyInvariants`)", `**${fmt(s.violations.ledger)}**`],
          ["reconciliation invariant violations", `**${fmt(s.violations.reconciliation)}**`],
        ],
      ),
    );
  }
  lines.push(
    "## Assertions",
    "",
    "- For every watched address (agent accounts, spend keys, revenue address, escrow/stream/vault contracts) the on-chain USDC balance equals the ledger's expected balance (sum of the pockets located there).",
    "- `Ledger.verifyInvariants()` is clean: every entry balances, cached balances equal the journal, no negative pocket, holds and reserves agree, reversals mirror their originals.",
    "- `sys:suspense` is zero (no unexplained movement was injected) and no payment is left open.",
    "- Reconciliation invariants: each chain event matches at most one entry and each entry at most one live event; every orphaned transaction's entries are reversed or rebound; no payment is settled without an `allow` decision, an approval or an owner signature; every settled payment's hold is posted.",
  );
  return `${lines.join("\n")}\n`;
}

const RUNS = (MOVEMENTS > 0 ? 1 : 0) + (PG_MOVEMENTS > 0 ? 1 : 0);

describe("Phase 1 gate: simulated deposits and transfers reconcile with zero drift, including injected reorgs", () => {
  afterAll(() => {
    if (results.length === 0) return;
    const text = render(results);
    // Vitest hides console output of passing tests; the summary is part of the evidence.
    process.stdout.write(`\n${text}`);
    if (process.env.GATE_EVIDENCE !== "1") return;
    // Only a full-size run where every run passed is gate evidence.
    if (MOVEMENTS < 10_000 || results.length !== RUNS || !results.every(passed)) {
      process.stdout.write(`\nNot writing ${EVIDENCE}: not a full, passing gate run.\n`);
      return;
    }
    mkdirSync(dirname(EVIDENCE), { recursive: true });
    writeFileSync(EVIDENCE, text);
    process.stdout.write(`\nWrote ${EVIDENCE}\n`);
  });

  it.skipIf(MOVEMENTS === 0)(
    `InMemoryLedger: ${MOVEMENTS.toLocaleString("en-US")} movements`,
    async () => {
      results.push(await runGate("memory", MOVEMENTS, SEED));
    },
    900_000,
  );

  it.skipIf(PG_MOVEMENTS === 0)(
    `PostgresLedger: ${PG_MOVEMENTS.toLocaleString("en-US")} movements`,
    async () => {
      results.push(await runGate("postgres", PG_MOVEMENTS, SEED + 1));
    },
    900_000,
  );
});
