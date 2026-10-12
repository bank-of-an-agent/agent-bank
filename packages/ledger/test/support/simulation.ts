import { isDeepStrictEqual } from "node:util";
import { AgentBankError, type ManualClock } from "@agentbank/core";
import fc from "fast-check";
import {
  chainRef,
  HOLD_RESERVES,
  pocketRef,
  revenueRef,
  STANDARD_POCKETS,
  vaultRef,
  type EntryKind,
  type Hold,
  type HoldSource,
  type HoldStatus,
  type JournalEntry,
  type Ledger,
  type LedgerAccountRef,
} from "../../src";
import { CHAIN } from "./harness";

/**
 * Model-based simulation of a bank: random deposits, payouts, transfers, pocket moves, holds,
 * settlements, voids, expiries, reversals, idempotent replays and key conflicts. Every command
 * runs against a real `Ledger` and against a tiny reference model (plain bigint arithmetic);
 * the predicted outcome, the exact lines written and every balance must agree, and the
 * ledger's own invariant check must stay clean.
 */

export type Command =
  | {
      kind: "deposit" | "payout" | "save" | "accrueFee" | "sweepFee" | "refill";
      account: number;
      amount: bigint;
    }
  | { kind: "transfer"; from: number; to: number; amount: bigint }
  | { kind: "hold"; account: number; source: HoldSource; amount: bigint; ttl: number }
  /**
   * `hold` indexes the pending holds, or every hold when `any` (to provoke `invalid_state`).
   * `to`: -1 external address, -2 the hold's own spend pocket (refill), else that account.
   */
  | { kind: "post"; hold: number; any: boolean; shareBps: number; feeBps: number; to: number }
  | { kind: "void"; hold: number; any: boolean }
  | { kind: "expire"; advance: number }
  | { kind: "reverse"; entry: number }
  | { kind: "replay" | "conflict"; request: number };

/** Outcome of one command: `ok`, an error code, or `skip` when there was nothing to act on. */
export type Outcome = string;

/** Commands over `accounts` bank accounts. */
export function commandArbitrary(accounts: number): fc.Arbitrary<Command> {
  const account = fc.nat({ max: accounts - 1 });
  const amount = fc.bigInt({ min: 1n, max: 5_000n });
  const pocketMove = (kind: "payout" | "save" | "accrueFee" | "sweepFee" | "refill") =>
    fc.record({ kind: fc.constant(kind), account, amount });
  const any = fc.oneof(
    { weight: 4, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  );
  return fc.oneof(
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant("deposit" as const),
        account,
        amount: fc.bigInt({ min: 1n, max: 20_000n }),
      }),
    },
    { weight: 2, arbitrary: pocketMove("payout") },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant("transfer" as const), from: account, to: account, amount }),
    },
    { weight: 1, arbitrary: pocketMove("save") },
    { weight: 1, arbitrary: pocketMove("accrueFee") },
    { weight: 1, arbitrary: pocketMove("sweepFee") },
    { weight: 1, arbitrary: pocketMove("refill") },
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant("hold" as const),
        account,
        source: fc.constantFrom<HoldSource>("operating", "operating", "spend"),
        amount,
        ttl: fc.integer({ min: 1, max: 3_600_000 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("post" as const),
        hold: fc.nat(),
        any,
        shareBps: fc.oneof(fc.constant(10_000), fc.integer({ min: 1, max: 10_000 })),
        feeBps: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 500 })),
        to: fc.integer({ min: -2, max: accounts - 1 }),
      }),
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("void" as const), hold: fc.nat(), any }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("expire" as const),
        advance: fc.integer({ min: 0, max: 300_000 }),
      }),
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("reverse" as const), entry: fc.nat() }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("replay" as const), request: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("conflict" as const), request: fc.nat() }) },
  );
}

type Line = [ref: LedgerAccountRef, amount: bigint];

interface ModelHold {
  id: string;
  account: number;
  source: HoldSource;
  amount: bigint;
  status: HoldStatus;
  expiresAt: number;
}

interface ModelEntry {
  id: string;
  kind: EntryKind;
  hold: ModelHold | null;
  lines: Line[];
  reversed: boolean;
}

type Request =
  | { method: "post"; input: Parameters<Ledger["post"]>[0]; result: JournalEntry }
  | { method: "hold"; input: Parameters<Ledger["hold"]>[0]; result: Hold }
  | { method: "postHold"; input: Parameters<Ledger["postHold"]>[0]; result: JournalEntry }
  | { method: "voidHold"; input: Parameters<Ledger["voidHold"]>[0]; result: JournalEntry }
  | { method: "reverse"; input: Parameters<Ledger["reverse"]>[0]; result: JournalEntry };

const ASSET = "USDC";
const key = (ref: LedgerAccountRef) => `${ref.ownerRef}|${ref.code}|${ref.asset}`;

export class SimulationError extends Error {}

export class Simulation {
  /** Model balances of every ledger account the simulation can touch. */
  readonly balances = new Map<string, bigint>();
  readonly refs = new Map<string, LedgerAccountRef>();
  readonly holds: ModelHold[] = [];
  readonly entries: ModelEntry[] = [];
  readonly requests: Request[] = [];
  readonly outcomes = new Map<string, Map<Outcome, number>>();
  private sequence = 0;

  private constructor(
    readonly ledger: Ledger,
    readonly clock: ManualClock,
    readonly accounts: readonly string[],
    readonly vaults: readonly string[],
  ) {}

  /**
   * Open `accounts` bank accounts, each with its standard pockets and one goal vault, and fund
   * each with `funding` in operating and a fifth of it in the spend float (through the ledger,
   * so the model sees it too).
   */
  static async create(
    ledger: Ledger,
    clock: ManualClock,
    accounts: readonly string[],
    vaults: readonly string[],
    funding = 20_000n,
  ): Promise<Simulation> {
    const sim = new Simulation(ledger, clock, accounts, vaults);
    for (const [index, accountId] of accounts.entries()) {
      await ledger.openPockets(accountId, ASSET, CHAIN);
      await ledger.ensureAccount(vaultRef(accountId, vaults[index] as string, ASSET));
      for (const pocket of STANDARD_POCKETS) sim.track(pocketRef(accountId, pocket, ASSET));
      sim.track(sim.vault(index));
    }
    sim.track(chainRef(CHAIN, ASSET));
    sim.track(revenueRef(ASSET));
    if (funding > 0n) {
      for (const index of accounts.keys()) {
        await sim.run({ kind: "deposit", account: index, amount: funding });
        await sim.run({ kind: "refill", account: index, amount: funding / 5n });
      }
      sim.outcomes.clear();
    }
    return sim;
  }

  private track(ref: LedgerAccountRef): void {
    this.refs.set(key(ref), ref);
    if (!this.balances.has(key(ref))) this.balances.set(key(ref), 0n);
  }

  private pocket(index: number, pocket: string): LedgerAccountRef {
    return { ownerRef: this.accounts[index] as string, code: `pocket:${pocket}`, asset: ASSET };
  }

  private vault(index: number): LedgerAccountRef {
    return vaultRef(this.accounts[index] as string, this.vaults[index] as string, ASSET);
  }

  private nextKey(): string {
    this.sequence += 1;
    return `sim:${this.sequence}`;
  }

  /** Run one command against the ledger and the model; throws on any disagreement. */
  async run(command: Command): Promise<Outcome> {
    const outcome = await this.execute(command);
    const byKind = this.outcomes.get(command.kind) ?? new Map<Outcome, number>();
    byKind.set(outcome, (byKind.get(outcome) ?? 0) + 1);
    this.outcomes.set(command.kind, byKind);
    return outcome;
  }

  private async execute(command: Command): Promise<Outcome> {
    const chain = chainRef(CHAIN, ASSET);
    switch (command.kind) {
      case "deposit":
        return this.post(command.kind, [
          [chain, -command.amount],
          [this.pocket(command.account, "operating"), command.amount],
        ]);
      case "payout":
        return this.post(command.kind, [
          [this.pocket(command.account, "operating"), -command.amount],
          [chain, command.amount],
        ]);
      case "transfer":
        return this.post(command.kind, [
          [this.pocket(command.from, "operating"), -command.amount],
          [this.pocket(command.to, "operating"), command.amount],
        ]);
      case "save":
        return this.post(command.kind, [
          [this.pocket(command.account, "operating"), -command.amount],
          [this.vault(command.account), command.amount],
        ]);
      case "accrueFee":
        return this.post(command.kind, [
          [this.pocket(command.account, "operating"), -command.amount],
          [this.pocket(command.account, "fees"), command.amount],
        ]);
      case "sweepFee":
        return this.post(command.kind, [
          [this.pocket(command.account, "fees"), -command.amount],
          [revenueRef(ASSET), command.amount],
        ]);
      case "refill":
        return this.post(command.kind, [
          [this.pocket(command.account, "operating"), -command.amount],
          [this.pocket(command.account, "spend"), command.amount],
        ]);
      case "hold":
        return this.hold(command);
      case "post":
        return this.settle(command);
      case "void":
        return this.void(command);
      case "expire":
        return this.expire(command.advance);
      case "reverse":
        return this.reverse(command.entry);
      case "replay":
        return this.replay(command.request);
      case "conflict":
        return this.conflict(command.request);
    }
  }

  // ------------------------------------------------------------------ commands

  private async post(refType: string, lines: Line[]): Promise<Outcome> {
    const input = {
      idempotencyKey: this.nextKey(),
      refType,
      lines: lines.map(([account, amount]) => ({ account, amount })),
    };
    const expected = this.predict(lines);
    const outcome = await attempt(() => this.ledger.post(input));
    this.expectOutcome(`post ${refType}`, outcome.code, expected);
    if (outcome.value) {
      this.expectLines(outcome.value, lines);
      this.apply(lines);
      this.entries.push({ id: outcome.value.id, kind: "direct", hold: null, lines, reversed: false });
      this.requests.push({ method: "post", input, result: outcome.value });
    }
    return outcome.code;
  }

  private async hold(command: Extract<Command, { kind: "hold" }>): Promise<Outcome> {
    const source = this.pocket(command.account, command.source);
    const reserve = this.pocket(command.account, HOLD_RESERVES[command.source]);
    const lines: Line[] = [
      [source, -command.amount],
      [reserve, command.amount],
    ];
    const expiresAt = this.clock.now().getTime() + command.ttl;
    const input = {
      idempotencyKey: this.nextKey(),
      accountId: this.accounts[command.account] as string,
      asset: ASSET,
      amount: command.amount,
      from: command.source,
      expiresAt: new Date(expiresAt),
      refType: "payment",
    };
    const expected = this.predict(lines);
    const outcome = await attempt(() => this.ledger.hold(input));
    this.expectOutcome("hold", outcome.code, expected);
    if (outcome.value) {
      const hold: ModelHold = {
        id: outcome.value.id,
        account: command.account,
        source: command.source,
        amount: command.amount,
        status: "pending",
        expiresAt,
      };
      this.apply(lines);
      this.holds.push(hold);
      this.entries.push({ id: outcome.value.entryId, kind: "hold", hold, lines, reversed: false });
      this.requests.push({ method: "hold", input, result: outcome.value });
    }
    return outcome.code;
  }

  private pickHold(index: number, any: boolean): ModelHold | undefined {
    const pool = any ? this.holds : this.holds.filter((hold) => hold.status === "pending");
    return pool[index % Math.max(1, pool.length)];
  }

  private async settle(command: Extract<Command, { kind: "post" }>): Promise<Outcome> {
    const hold = this.pickHold(command.hold, command.any);
    if (!hold) return "skip";
    let amount = (hold.amount * BigInt(command.shareBps)) / 10_000n;
    if (amount < 1n) amount = 1n;
    const fee = (amount * BigInt(command.feeBps)) / 10_000n;
    const target =
      command.to === -1
        ? chainRef(CHAIN, ASSET)
        : command.to === -2
          ? this.pocket(hold.account, "spend")
          : this.pocket(command.to, "operating");
    const destinations = [
      ...(amount - fee > 0n ? [{ to: target, amount: amount - fee }] : []),
      ...(fee > 0n ? [{ to: revenueRef(ASSET), amount: fee }] : []),
    ];
    const input = {
      idempotencyKey: this.nextKey(),
      holdId: hold.id,
      ...(amount === hold.amount && command.shareBps % 2 === 0 ? {} : { amount }),
      destinations,
    };
    const lines = merge([
      [this.pocket(hold.account, HOLD_RESERVES[hold.source]), -hold.amount],
      ...destinations.map((d): Line => [d.to, d.amount]),
      [this.pocket(hold.account, hold.source), hold.amount - amount],
    ]);
    const expected = hold.status === "pending" ? "ok" : "invalid_state";
    const outcome = await attempt(() => this.ledger.postHold(input));
    this.expectOutcome("postHold", outcome.code, expected);
    if (outcome.value) {
      this.expectLines(outcome.value, lines);
      this.apply(lines);
      hold.status = "posted";
      this.entries.push({ id: outcome.value.id, kind: "hold_post", hold, lines, reversed: false });
      this.requests.push({ method: "postHold", input, result: outcome.value });
    }
    return outcome.code;
  }

  private async void(command: Extract<Command, { kind: "void" }>): Promise<Outcome> {
    const hold = this.pickHold(command.hold, command.any);
    if (!hold) return "skip";
    const lines = this.releaseLines(hold);
    const input = { idempotencyKey: this.nextKey(), holdId: hold.id, reason: "simulated failure" };
    const outcome = await attempt(() => this.ledger.voidHold(input));
    this.expectOutcome("voidHold", outcome.code, hold.status === "pending" ? "ok" : "invalid_state");
    if (outcome.value) {
      this.expectLines(outcome.value, lines);
      this.apply(lines);
      hold.status = "voided";
      this.entries.push({ id: outcome.value.id, kind: "hold_void", hold, lines, reversed: false });
      this.requests.push({ method: "voidHold", input, result: outcome.value });
    }
    return outcome.code;
  }

  private async expire(advance: number): Promise<Outcome> {
    const now = this.clock.advance(advance);
    const due = this.holds.filter((hold) => hold.status === "pending" && hold.expiresAt <= now.getTime());
    const expired = await this.ledger.expireHolds(now);
    if (expired !== due.length) {
      throw new SimulationError(`expireHolds expired ${expired} holds, the model expected ${due.length}`);
    }
    for (const hold of due) {
      const lines = this.releaseLines(hold);
      const stored = await this.ledger.getHold(hold.id);
      if (stored.status !== "expired" || stored.resolutionEntryId === null) {
        throw new SimulationError(`hold ${hold.id} is ${stored.status} after expiry`);
      }
      this.expectLines(await this.ledger.getEntry(stored.resolutionEntryId), lines);
      this.apply(lines);
      hold.status = "expired";
      this.entries.push({ id: stored.resolutionEntryId, kind: "hold_expire", hold, lines, reversed: false });
    }
    return due.length > 0 ? "ok" : "skip";
  }

  private async reverse(index: number): Promise<Outcome> {
    const target = this.entries[index % Math.max(1, this.entries.length)];
    if (!target) return "skip";
    const lines = target.lines.map(([ref, amount]): Line => [ref, -amount]);
    const input = { idempotencyKey: this.nextKey(), entryId: target.id, memo: "simulated reorg" };
    const expected =
      target.kind === "reversal" || target.kind === "hold" || target.reversed
        ? "invalid_state"
        : this.predict(lines);
    const outcome = await attempt(() => this.ledger.reverse(input));
    this.expectOutcome(`reverse ${target.kind}`, outcome.code, expected);
    if (outcome.value) {
      this.expectLines(outcome.value, lines);
      this.apply(lines);
      target.reversed = true;
      if (target.hold) target.hold.status = "pending";
      this.entries.push({
        id: outcome.value.id,
        kind: "reversal",
        hold: target.hold,
        lines,
        reversed: false,
      });
      this.requests.push({ method: "reverse", input, result: outcome.value });
    }
    return outcome.code;
  }

  private async replay(index: number): Promise<Outcome> {
    const request = this.requests[index % Math.max(1, this.requests.length)];
    if (!request) return "skip";
    const again = await this.call(request.method, request.input);
    if (request.method === "hold") {
      const hold = again as Hold;
      if (
        hold.id !== request.result.id ||
        hold.entryId !== request.result.entryId ||
        hold.amount !== request.result.amount
      ) {
        throw new SimulationError(`replayed hold ${request.input.idempotencyKey} returned another hold`);
      }
    } else if (!sameEntry(again as JournalEntry, request.result)) {
      throw new SimulationError(
        `replayed ${request.method} ${request.input.idempotencyKey} returned a different entry`,
      );
    }
    return "ok";
  }

  private async conflict(index: number): Promise<Outcome> {
    const request = this.requests[index % Math.max(1, this.requests.length)];
    if (!request) return "skip";
    const outcome = await attempt(() =>
      this.call(request.method, { ...request.input, memo: `conflict ${this.sequence}` }),
    );
    this.expectOutcome(`conflicting ${request.method}`, outcome.code, "idempotency_conflict");
    return outcome.code;
  }

  private call(method: Request["method"], input: Request["input"]): Promise<JournalEntry | Hold> {
    switch (method) {
      case "post":
        return this.ledger.post(input as Parameters<Ledger["post"]>[0]);
      case "hold":
        return this.ledger.hold(input as Parameters<Ledger["hold"]>[0]);
      case "postHold":
        return this.ledger.postHold(input as Parameters<Ledger["postHold"]>[0]);
      case "voidHold":
        return this.ledger.voidHold(input as Parameters<Ledger["voidHold"]>[0]);
      case "reverse":
        return this.ledger.reverse(input as Parameters<Ledger["reverse"]>[0]);
    }
  }

  // ------------------------------------------------------------------ model

  private releaseLines(hold: ModelHold): Line[] {
    return [
      [this.pocket(hold.account, HOLD_RESERVES[hold.source]), -hold.amount],
      [this.pocket(hold.account, hold.source), hold.amount],
    ];
  }

  /** `ok`, or `insufficient_funds` when a pocket's net change would take it below zero. */
  private predict(lines: readonly Line[]): Outcome {
    const net = new Map<string, bigint>();
    for (const [ref, amount] of lines) net.set(key(ref), (net.get(key(ref)) ?? 0n) + amount);
    for (const [ref, delta] of net) {
      const isPocket = !ref.startsWith("system|");
      if (isPocket && (this.balances.get(ref) ?? 0n) + delta < 0n) return "insufficient_funds";
    }
    return "ok";
  }

  private apply(lines: readonly Line[]): void {
    for (const [ref, amount] of lines) {
      this.track(ref);
      this.balances.set(key(ref), (this.balances.get(key(ref)) ?? 0n) + amount);
    }
  }

  private expectOutcome(what: string, actual: Outcome, expected: Outcome): void {
    if (actual !== expected)
      throw new SimulationError(`${what}: ledger said ${actual}, the model expected ${expected}`);
  }

  private expectLines(entry: JournalEntry, lines: readonly Line[]): void {
    const actual = entry.lines.map((line) => `${key(line)} ${line.amount}`);
    const expected = lines.map(([ref, amount]) => `${key(ref)} ${amount}`);
    if (actual.join("\n") !== expected.join("\n")) {
      throw new SimulationError(
        `entry ${entry.id} (${entry.kind}) wrote\n${actual.join("\n")}\nexpected\n${expected.join("\n")}`,
      );
    }
  }

  // ------------------------------------------------------------------ checks

  /** Compare every balance with the model and require a clean invariant report. */
  async check(): Promise<void> {
    let total = 0n;
    for (const [id, expected] of this.balances) {
      const actual = await this.ledger.balance(this.refs.get(id) as LedgerAccountRef);
      if (actual !== expected)
        throw new SimulationError(`${id}: ledger balance ${actual}, model ${expected}`);
      if (!id.startsWith("system|") && actual < 0n) throw new SimulationError(`${id} is negative`);
      total += actual;
    }
    if (total !== 0n) throw new SimulationError(`balances sum to ${total}, not zero`);
    for (const [index, accountId] of this.accounts.entries()) {
      for (const source of ["operating", "spend"] as const) {
        const pending = this.holds
          .filter((hold) => hold.account === index && hold.source === source && hold.status === "pending")
          .reduce((sum, hold) => sum + hold.amount, 0n);
        const reserved = this.balances.get(key(pocketRef(accountId, HOLD_RESERVES[source], ASSET)));
        if (reserved !== pending)
          throw new SimulationError(`${accountId} reserves ${reserved}, pending holds ${pending}`);
      }
    }
    const report = await this.ledger.verifyInvariants();
    if (!report.ok) throw new SimulationError(`invariant violations: ${JSON.stringify(report.violations)}`);
  }

  /** Slower checks for the end of a run: full pagination per account and balanceAt(now). */
  async deepCheck(pageSize = 7): Promise<void> {
    await this.check();
    for (const accountId of this.accounts) {
      const expected = new Set(
        this.entries
          .filter((entry) => entry.lines.some(([ref]) => ref.ownerRef === accountId))
          .map((entry) => entry.id),
      );
      const seen: JournalEntry[] = [];
      let cursor: string | null = null;
      do {
        const page = await this.ledger.listEntries({ ownerRef: accountId }, { cursor, limit: pageSize });
        seen.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor !== null);
      const ids = seen.map((entry) => entry.id);
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== expected.size ||
        ids.some((id) => !expected.has(id))
      ) {
        throw new SimulationError(
          `listEntries for ${accountId} returned ${ids.length} entries, expected ${expected.size}`,
        );
      }
      for (let i = 1; i < seen.length; i += 1) {
        const [newer, older] = [seen[i - 1] as JournalEntry, seen[i] as JournalEntry];
        const ordered =
          newer.createdAt.getTime() > older.createdAt.getTime() ||
          (newer.createdAt.getTime() === older.createdAt.getTime() && newer.id > older.id);
        if (!ordered) throw new SimulationError(`listEntries is not newest first at ${older.id}`);
      }
    }
    const now = this.clock.now();
    for (const [id, expected] of this.balances) {
      const at = await this.ledger.balanceAt(this.refs.get(id) as LedgerAccountRef, now);
      if (at !== expected) throw new SimulationError(`${id}: balanceAt(now) ${at}, model ${expected}`);
    }
  }

  /** Model balances, comparable across ledgers that share account and vault ids. */
  snapshot(): Record<string, bigint> {
    return Object.fromEntries([...this.balances].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /** Outcome counts per command kind, for reports. */
  summary(): Record<string, Record<string, number>> {
    return Object.fromEntries(
      [...this.outcomes].map(([kind, outcomes]) => [kind, Object.fromEntries([...outcomes].sort())]),
    );
  }
}

async function attempt<T>(run: () => Promise<T>): Promise<{ code: Outcome; value?: T }> {
  try {
    return { code: "ok", value: await run() };
  } catch (error) {
    if (error instanceof AgentBankError) return { code: error.code };
    throw error;
  }
}

/** Net lines per account in first-appearance order, dropping zeros (as postHold does). */
function merge(lines: readonly Line[]): Line[] {
  const merged = new Map<string, Line>();
  for (const [ref, amount] of lines) {
    const seen = merged.get(key(ref));
    merged.set(key(ref), [ref, (seen?.[1] ?? 0n) + amount]);
  }
  return [...merged.values()].filter(([, amount]) => amount !== 0n);
}

/** Deep equality that ignores key order (Postgres returns jsonb keys in its own order). */
function sameEntry(a: JournalEntry, b: JournalEntry): boolean {
  return isDeepStrictEqual(a, b);
}
