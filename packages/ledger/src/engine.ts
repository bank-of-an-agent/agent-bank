import {
  AgentBankError,
  ASSET_CODES,
  assertTestnet,
  canonicalSha256,
  MAX_MINOR_UNITS,
  newId,
  systemClock,
  type Clock,
} from "@agentbank/core";
import {
  allowedLocations,
  assertAccountId,
  assertAsset,
  HOLD_RESERVES,
  pocketOf,
  pocketRef,
  refKey,
  resolveRef,
  type ResolvedRef,
} from "./accounts";
import type { LedgerStore, StoreTx } from "./store";
import {
  STANDARD_POCKETS,
  type EnsureAccountInput,
  type EntryContext,
  type EntryFilter,
  type EntryKind,
  type EntryPage,
  type ExpireHoldsOptions,
  type FundsLocation,
  type Hold,
  type HoldInput,
  type InvariantReport,
  type JournalEntry,
  type Ledger,
  type LedgerAccount,
  type LedgerAccountRef,
  type LedgerOptions,
  type LocationBalances,
  type PageOptions,
  type PocketBalances,
  type PostEntryInput,
  type PostHoldInput,
  type ReverseInput,
  type VoidHoldInput,
} from "./types";
import {
  assertDestinationsSum,
  encodeCursor,
  normalizeDate,
  normalizeHold,
  normalizeLimit,
  normalizeOwner,
  normalizePost,
  normalizePostHold,
  normalizeQuery,
  normalizeReverse,
  normalizeVoid,
  RESERVED_KEY_PREFIX,
} from "./validation";

/** A line about to be written. */
interface PlannedLine {
  account: Pick<LedgerAccount, "id" | "ownerRef" | "code" | "asset">;
  amount: bigint;
}

interface EntryDraft {
  kind: EntryKind;
  /** The idempotency key, or a function of the new entry's id for ledger-generated keys. */
  key: string | ((entryId: string) => string);
  hash: string;
  context: EntryContext;
  lines: readonly PlannedLine[];
  holdId: string | null;
  reversesEntryId: string | null;
  now: Date;
}

const MIN_BALANCE = -MAX_MINOR_UNITS - 1n;

function accountNotFound(ref: LedgerAccountRef): AgentBankError {
  return new AgentBankError(
    "not_found",
    `Ledger account ${ref.code} (${ref.asset}) of ${ref.ownerRef} does not exist`,
    { owner_ref: ref.ownerRef, code: ref.code, asset: ref.asset },
  );
}

function invalidState(detail: string, extensions: Record<string, unknown> = {}): AgentBankError {
  return new AgentBankError("invalid_state", detail, extensions);
}

function holdContext(hold: Hold): EntryContext {
  return {
    refType: hold.refType,
    refId: hold.refId,
    memo: hold.memo,
    agentId: hold.agentId,
    paymentId: hold.paymentId,
    mandateId: hold.mandateId,
    decisionId: hold.decisionId,
    chainEventId: null,
    metadata: {},
  };
}

function inheritedContext(entry: JournalEntry): EntryContext {
  return {
    refType: entry.refType,
    refId: entry.refId,
    memo: entry.memo,
    agentId: entry.agentId,
    paymentId: entry.paymentId,
    mandateId: entry.mandateId,
    decisionId: entry.decisionId,
    chainEventId: null,
    metadata: {},
  };
}

/** Sum lines per ledger account, keeping first-appearance order and dropping zero nets. */
function mergeLines(lines: readonly PlannedLine[]): PlannedLine[] {
  const merged = new Map<string, PlannedLine>();
  for (const line of lines) {
    const seen = merged.get(line.account.id);
    merged.set(line.account.id, { account: line.account, amount: (seen?.amount ?? 0n) + line.amount });
  }
  return [...merged.values()].filter((line) => line.amount !== 0n);
}

/**
 * The ledger's business rules, written once against {@link LedgerStore} so that
 * {@link InMemoryLedger} and {@link PostgresLedger} cannot drift apart. See {@link Ledger} for
 * the contract of every method.
 */
export abstract class LedgerEngine implements Ledger {
  protected readonly clock: Clock;
  protected readonly assets: ReadonlySet<string>;

  protected constructor(
    private readonly store: LedgerStore,
    options: LedgerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.assets = new Set(options.assets ?? ASSET_CODES);
  }

  // ------------------------------------------------------------------ accounts

  async ensureAccount(input: EnsureAccountInput): Promise<LedgerAccount> {
    const resolved = resolveRef(input, this.assets);
    const chainId = this.requestedChain(resolved, input.chainId);
    const allowed = allowedLocations(resolved.parsed);
    const location = input.location;
    if (location !== undefined && !allowed.includes(location)) {
      throw new AgentBankError(
        "invalid_request",
        `${resolved.ref.code} cannot be located in ${String(location)}`,
      );
    }
    return this.store.write(async (tx) => {
      const [existing] = await tx.accountsByRefs([resolved.ref]);
      if (existing) {
        if (
          (chainId !== undefined && existing.chainId !== chainId) ||
          (location !== undefined && existing.location !== location)
        ) {
          throw new AgentBankError(
            "conflict",
            `Ledger account ${existing.code} of ${existing.ownerRef} already exists on chain ${existing.chainId} in ${existing.location}`,
            { ledger_account_id: existing.id },
          );
        }
        return existing;
      }
      const chain = chainId === undefined ? await this.inheritedChain(tx, resolved.ref.ownerRef) : chainId;
      await tx.insertAccounts([this.newAccount(resolved, chain, location ?? (allowed[0] as FundsLocation))]);
      return this.mustAccount(tx, resolved.ref);
    });
  }

  async openPockets(accountId: string, asset: string, chainId: number): Promise<LedgerAccount[]> {
    assertAccountId(accountId);
    assertAsset(asset, this.assets);
    this.assertChainId(chainId);
    const resolved = STANDARD_POCKETS.map((pocket) =>
      resolveRef(pocketRef(accountId, pocket, asset), this.assets),
    );
    const refs = resolved.map((r) => r.ref);
    return this.store.write(async (tx) => {
      const existing = this.sortPockets(await tx.accountsByRefs(refs));
      const elsewhere = existing.find((account) => account.chainId !== chainId);
      if (elsewhere) {
        throw new AgentBankError(
          "conflict",
          `${elsewhere.code} of ${accountId} already exists on chain ${elsewhere.chainId}`,
          { ledger_account_id: elsewhere.id },
        );
      }
      const have = new Set(existing.map(refKey));
      const missing = resolved.filter((r) => !have.has(r.key));
      if (missing.length > 0) {
        await tx.insertAccounts(
          missing.map((r) => this.newAccount(r, chainId, allowedLocations(r.parsed)[0] as FundsLocation)),
        );
      }
      return this.sortPockets(await tx.accountsByRefs(refs));
    });
  }

  async getAccount(ref: LedgerAccountRef): Promise<LedgerAccount> {
    const resolved = resolveRef(ref, this.assets);
    return this.store.read((tx) => this.mustAccount(tx, resolved.ref));
  }

  async listAccounts(ownerRef: string, asset?: string): Promise<LedgerAccount[]> {
    normalizeOwner(ownerRef);
    if (asset !== undefined) assertAsset(asset, this.assets);
    return this.store.read((tx) => tx.accountsByOwner(ownerRef, asset ?? null));
  }

  // ------------------------------------------------------------------ writes

  async post(input: PostEntryInput): Promise<JournalEntry> {
    const req = normalizePost(input, this.assets);
    return this.store.write(async (tx) => {
      const replay = await this.replay(tx, req.key, req.hash);
      if (replay) return this.mustEntry(tx, replay.id);
      const accounts = await this.resolveAccounts(
        tx,
        req.lines.map((line) => line.resolved),
      );
      const lines = req.lines.map((line) => ({
        account: accounts.get(line.resolved.key)!,
        amount: line.amount,
      }));
      await this.checkBalances(tx, lines);
      const entry = this.draftEntry({
        kind: "direct",
        key: req.key,
        hash: req.hash,
        context: req.context,
        lines,
        holdId: null,
        reversesEntryId: null,
        now: this.clock.now(),
      });
      await tx.insertEntry(entry);
      return entry;
    });
  }

  async hold(input: HoldInput): Promise<Hold> {
    const req = normalizeHold(input, this.assets);
    return this.store.write(async (tx) => {
      const replay = await this.replay(tx, req.key, req.hash);
      if (replay) return this.mustHold(tx, replay.holdId!);
      const now = this.clock.now();
      if (req.expiresAt.getTime() <= now.getTime()) {
        throw new AgentBankError("invalid_request", "expiresAt must be in the future");
      }
      const from = resolveRef(pocketRef(req.accountId, req.from, req.asset), this.assets);
      const reserve = resolveRef(pocketRef(req.accountId, HOLD_RESERVES[req.from], req.asset), this.assets);
      const accounts = await this.resolveAccounts(tx, [from, reserve]);
      const fromAccount = accounts.get(from.key)!;
      const reserveAccount = accounts.get(reserve.key)!;
      const lines = [
        { account: fromAccount, amount: -req.amount },
        { account: reserveAccount, amount: req.amount },
      ];
      await this.checkBalances(tx, lines);
      const holdId = newId("hold", now.getTime());
      const entry = this.draftEntry({
        kind: "hold",
        key: req.key,
        hash: req.hash,
        context: req.context,
        lines,
        holdId,
        reversesEntryId: null,
        now,
      });
      const hold: Hold = {
        id: holdId,
        idempotencyKey: req.key,
        requestHash: req.hash,
        accountId: req.accountId,
        asset: req.asset,
        from: req.from,
        fromAccountId: fromAccount.id,
        reserveAccountId: reserveAccount.id,
        amount: req.amount,
        postedAmount: null,
        status: "pending",
        expiresAt: req.expiresAt,
        entryId: entry.id,
        resolutionEntryId: null,
        refType: req.context.refType,
        refId: req.context.refId,
        memo: req.context.memo,
        agentId: req.context.agentId,
        paymentId: req.context.paymentId,
        mandateId: req.context.mandateId,
        decisionId: req.context.decisionId,
        metadata: req.context.metadata,
        voidReason: null,
        createdAt: now,
        resolvedAt: null,
      };
      await tx.insertEntry(entry);
      await tx.insertHold(hold);
      return hold;
    });
  }

  async postHold(input: PostHoldInput): Promise<JournalEntry> {
    const req = normalizePostHold(input, this.assets);
    return this.store.write(async (tx) => {
      const replay = await this.replay(tx, req.key, req.hash);
      if (replay) return this.mustEntry(tx, replay.id);
      const hold = await this.pendingHold(tx, req.holdId);
      const amount = req.amount ?? hold.amount;
      if (amount > hold.amount) {
        throw new AgentBankError(
          "invalid_amount",
          `Cannot post ${amount}: hold ${hold.id} reserves ${hold.amount}`,
        );
      }
      assertDestinationsSum(req.destinations, amount);
      const foreign = req.destinations.find((d) => d.resolved.ref.asset !== hold.asset);
      if (foreign) {
        throw new AgentBankError(
          "invalid_request",
          `Destination ${foreign.resolved.ref.code} holds ${foreign.resolved.ref.asset}, hold ${hold.id} is in ${hold.asset}`,
        );
      }
      const { from, reserve } = this.holdRefs(hold);
      const accounts = await this.resolveAccounts(tx, [
        reserve,
        ...req.destinations.map((d) => d.resolved),
        from,
      ]);
      const lines = mergeLines([
        { account: accounts.get(reserve.key)!, amount: -hold.amount },
        ...req.destinations.map((d) => ({ account: accounts.get(d.resolved.key)!, amount: d.amount })),
        { account: accounts.get(from.key)!, amount: hold.amount - amount },
      ]);
      return this.resolveHold(tx, hold, {
        kind: "hold_post",
        key: req.key,
        hash: req.hash,
        context: { ...holdContext(hold), ...req.overrides },
        lines,
        status: "posted",
        postedAmount: amount,
        voidReason: null,
      });
    });
  }

  async voidHold(input: VoidHoldInput): Promise<JournalEntry> {
    const req = normalizeVoid(input);
    return this.store.write(async (tx) => {
      const replay = await this.replay(tx, req.key, req.hash);
      if (replay) return this.mustEntry(tx, replay.id);
      const hold = await this.pendingHold(tx, req.holdId);
      return this.resolveHold(tx, hold, {
        kind: "hold_void",
        key: req.key,
        hash: req.hash,
        context: { ...holdContext(hold), memo: req.reason, ...req.overrides },
        lines: await this.releaseLines(tx, hold),
        status: "voided",
        postedAmount: null,
        voidReason: req.reason,
      });
    });
  }

  async expireHolds(now: Date, options: ExpireHoldsOptions = {}): Promise<number> {
    const at = normalizeDate(now, "now");
    const limit = normalizeLimit(options.limit, "limit", 100_000);
    const due = await this.store.read((tx) => tx.dueHoldIds(at, limit));
    let expired = 0;
    for (const holdId of due) {
      const done = await this.store.write(async (tx) => {
        const hold = await tx.hold(holdId, true);
        if (hold?.status !== "pending" || hold.expiresAt.getTime() > at.getTime()) return false;
        await this.resolveHold(tx, hold, {
          kind: "hold_expire",
          // Expiry is not caller-driven: the key only has to be unique, and a re-opened hold
          // can expire again, so it includes the new entry's id.
          key: (entryId) => `${RESERVED_KEY_PREFIX}expire:${hold.id}:${entryId}`,
          hash: canonicalSha256({ op: "expire_hold", holdId: hold.id, now: at }),
          context: { ...holdContext(hold), memo: "hold expired" },
          lines: await this.releaseLines(tx, hold),
          status: "expired",
          postedAmount: null,
          voidReason: null,
        });
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  async reverse(input: ReverseInput): Promise<JournalEntry> {
    const req = normalizeReverse(input);
    return this.store.write(async (tx) => {
      const replay = await this.replay(tx, req.key, req.hash);
      if (replay) return this.mustEntry(tx, replay.id);
      const original = await this.mustEntry(tx, req.entryId);
      if (original.kind === "reversal") {
        throw invalidState(
          `Entry ${original.id} is a reversal and cannot be reversed; post a new entry instead`,
        );
      }
      if (original.kind === "hold") {
        throw invalidState(`Entry ${original.id} reserves hold ${original.holdId}; void the hold instead`);
      }
      const reversedBy = await tx.reversalOf(original.id);
      if (reversedBy !== null) {
        throw invalidState(`Entry ${original.id} was already reversed by ${reversedBy}`, {
          reversal_entry_id: reversedBy,
        });
      }
      const hold = original.holdId === null ? null : await tx.hold(original.holdId, true);
      if (hold && hold.resolutionEntryId !== original.id) {
        throw invalidState(`Entry ${original.id} no longer resolves hold ${hold.id}`);
      }
      const lines = original.lines.map((line) => ({
        account: { id: line.ledgerAccountId, ownerRef: line.ownerRef, code: line.code, asset: line.asset },
        amount: -line.amount,
      }));
      await this.checkBalances(tx, lines);
      const entry = this.draftEntry({
        kind: "reversal",
        key: req.key,
        hash: req.hash,
        context: { ...inheritedContext(original), ...req.overrides },
        lines,
        holdId: original.holdId,
        reversesEntryId: original.id,
        now: this.clock.now(),
      });
      await tx.insertEntry(entry);
      if (hold) {
        await tx.updateHold({
          ...hold,
          status: "pending",
          postedAmount: null,
          resolutionEntryId: null,
          voidReason: null,
          resolvedAt: null,
        });
      }
      return entry;
    });
  }

  // ------------------------------------------------------------------ reads

  async balance(ref: LedgerAccountRef): Promise<bigint> {
    const resolved = resolveRef(ref, this.assets);
    return this.store.read(async (tx) => (await this.findAccount(tx, resolved))?.balance ?? 0n);
  }

  async balanceAt(ref: LedgerAccountRef, at: Date): Promise<bigint> {
    const resolved = resolveRef(ref, this.assets);
    const when = normalizeDate(at, "at");
    return this.store.read(async (tx) => {
      const account = await this.findAccount(tx, resolved);
      return account ? tx.balanceAt(account.id, when) : 0n;
    });
  }

  async pocketBalances(accountId: string, asset: string): Promise<PocketBalances> {
    const pockets = await this.bankAccountPockets(accountId, asset);
    const balances: Record<string, bigint> = Object.fromEntries(
      STANDARD_POCKETS.map((pocket) => [pocket, 0n]),
    );
    for (const account of pockets) balances[pocketOf(account.code)] = account.balance;
    return balances as PocketBalances;
  }

  async locationBalances(accountId: string, asset: string): Promise<LocationBalances> {
    const balances: LocationBalances = {};
    for (const account of await this.bankAccountPockets(accountId, asset)) {
      balances[account.location] = (balances[account.location] ?? 0n) + account.balance;
    }
    return balances;
  }

  async getEntry(id: string): Promise<JournalEntry> {
    return this.store.read((tx) => this.mustEntry(tx, id));
  }

  async getHold(id: string): Promise<Hold> {
    return this.store.read((tx) => this.mustHold(tx, id));
  }

  async listEntries(filter?: EntryFilter, page?: PageOptions): Promise<EntryPage> {
    const query = normalizeQuery(filter, page);
    const rows = await this.store.read((tx) => tx.listEntries({ ...query, limit: query.limit + 1 }));
    const entries = rows.slice(0, query.limit);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
  }

  async verifyInvariants(): Promise<InvariantReport> {
    return this.store.verify(this.clock.now());
  }

  // ------------------------------------------------------------------ helpers

  /** Look up an idempotency key: the earlier entry for a replay, a conflict for another request. */
  private async replay(tx: StoreTx, key: string, hash: string) {
    const existing = await tx.entryByKey(key);
    if (existing && existing.requestHash !== hash) {
      throw new AgentBankError(
        "idempotency_conflict",
        `Idempotency key "${key}" was already used for a different request`,
        { idempotency_key: key, entry_id: existing.id },
      );
    }
    return existing;
  }

  /**
   * Find the accounts for `refs`. Missing pockets are `not_found`; missing system accounts are
   * created, since they are singletons that exist implicitly.
   */
  private async resolveAccounts(
    tx: StoreTx,
    refs: readonly ResolvedRef[],
  ): Promise<Map<string, LedgerAccount>> {
    const unique = [...new Map(refs.map((r) => [r.key, r])).values()];
    const found = new Map((await tx.accountsByRefs(unique.map((r) => r.ref))).map((a) => [refKey(a), a]));
    const missing = unique.filter((r) => !found.has(r.key));
    const pocket = missing.find((r) => r.parsed.kind === "pocket");
    if (pocket) throw accountNotFound(pocket.ref);
    if (missing.length > 0) {
      await tx.insertAccounts(
        missing.map((r) =>
          this.newAccount(
            r,
            r.parsed.kind === "chain" ? r.parsed.chainId : null,
            allowedLocations(r.parsed)[0] as FundsLocation,
          ),
        ),
      );
      for (const account of await tx.accountsByRefs(missing.map((r) => r.ref)))
        found.set(refKey(account), account);
    }
    return found;
  }

  /**
   * Lock every account the lines touch (in id order, in one statement, so concurrent writers
   * cannot deadlock) and check the net change of each: pockets may not go negative, and no
   * balance may leave the bigint range.
   */
  private async checkBalances(tx: StoreTx, lines: readonly PlannedLine[]): Promise<void> {
    const net = new Map<string, bigint>();
    for (const line of lines) net.set(line.account.id, (net.get(line.account.id) ?? 0n) + line.amount);
    const locked = await tx.lockAccounts([...net.keys()]);
    for (const [id, delta] of net) {
      const account = locked.get(id)!;
      const next = account.balance + delta;
      if (next < 0n && !account.allowNegative) {
        throw new AgentBankError(
          "insufficient_funds",
          `${account.code} of ${account.ownerRef} holds ${account.balance} ${account.asset} minor units but ${-delta} are needed`,
          {
            ledger_account_id: account.id,
            owner_ref: account.ownerRef,
            code: account.code,
            asset: account.asset,
            available: account.balance.toString(),
            required: (-delta).toString(),
          },
        );
      }
      if (next > MAX_MINOR_UNITS || next < MIN_BALANCE) {
        throw new AgentBankError(
          "invalid_amount",
          `The balance of ${account.code} would leave the supported range`,
        );
      }
    }
  }

  private draftEntry(draft: EntryDraft): JournalEntry {
    const id = newId("entry", draft.now.getTime());
    return {
      id,
      kind: draft.kind,
      idempotencyKey: typeof draft.key === "string" ? draft.key : draft.key(id),
      requestHash: draft.hash,
      ...draft.context,
      holdId: draft.holdId,
      reversesEntryId: draft.reversesEntryId,
      lines: draft.lines.map((line) => ({
        ledgerAccountId: line.account.id,
        ownerRef: line.account.ownerRef,
        code: line.account.code,
        asset: line.account.asset,
        amount: line.amount,
      })),
      createdAt: draft.now,
    };
  }

  /** Write a hold's resolution entry and move the hold out of `pending`. */
  private async resolveHold(
    tx: StoreTx,
    hold: Hold,
    resolution: {
      kind: "hold_post" | "hold_void" | "hold_expire";
      key: EntryDraft["key"];
      hash: string;
      context: EntryContext;
      lines: readonly PlannedLine[];
      status: "posted" | "voided" | "expired";
      postedAmount: bigint | null;
      voidReason: string | null;
    },
  ): Promise<JournalEntry> {
    await this.checkBalances(tx, resolution.lines);
    const now = this.clock.now();
    const entry = this.draftEntry({ ...resolution, holdId: hold.id, reversesEntryId: null, now });
    await tx.insertEntry(entry);
    await tx.updateHold({
      ...hold,
      status: resolution.status,
      postedAmount: resolution.postedAmount,
      resolutionEntryId: entry.id,
      voidReason: resolution.voidReason,
      resolvedAt: now,
    });
    return entry;
  }

  /** Lines that return a hold's whole reserve to its source pocket. */
  private async releaseLines(tx: StoreTx, hold: Hold): Promise<PlannedLine[]> {
    const { from, reserve } = this.holdRefs(hold);
    const accounts = await this.resolveAccounts(tx, [reserve, from]);
    return [
      { account: accounts.get(reserve.key)!, amount: -hold.amount },
      { account: accounts.get(from.key)!, amount: hold.amount },
    ];
  }

  private holdRefs(hold: Hold): { from: ResolvedRef; reserve: ResolvedRef } {
    return {
      from: resolveRef(pocketRef(hold.accountId, hold.from, hold.asset), this.assets),
      reserve: resolveRef(pocketRef(hold.accountId, HOLD_RESERVES[hold.from], hold.asset), this.assets),
    };
  }

  private async pendingHold(tx: StoreTx, id: string): Promise<Hold> {
    const hold = await tx.hold(id, true);
    if (!hold) throw new AgentBankError("not_found", `Hold ${id} does not exist`, { hold_id: id });
    if (hold.status !== "pending") {
      throw invalidState(`Hold ${id} is ${hold.status}, not pending`, { hold_id: id, status: hold.status });
    }
    return hold;
  }

  private async mustEntry(tx: StoreTx, id: string): Promise<JournalEntry> {
    const [entry] = await tx.entries([id]);
    if (!entry) throw new AgentBankError("not_found", `Entry ${id} does not exist`, { entry_id: id });
    return entry;
  }

  private async mustHold(tx: StoreTx, id: string): Promise<Hold> {
    const hold = await tx.hold(id, false);
    if (!hold) throw new AgentBankError("not_found", `Hold ${id} does not exist`, { hold_id: id });
    return hold;
  }

  private async mustAccount(tx: StoreTx, ref: LedgerAccountRef): Promise<LedgerAccount> {
    const [account] = await tx.accountsByRefs([ref]);
    if (!account) throw accountNotFound(ref);
    return account;
  }

  /** An existing account, `undefined` for an unused system account, `not_found` for a pocket. */
  private async findAccount(tx: StoreTx, resolved: ResolvedRef): Promise<LedgerAccount | undefined> {
    const [account] = await tx.accountsByRefs([resolved.ref]);
    if (!account && resolved.parsed.kind === "pocket") throw accountNotFound(resolved.ref);
    return account;
  }

  private async bankAccountPockets(accountId: string, asset: string): Promise<LedgerAccount[]> {
    assertAccountId(accountId);
    assertAsset(asset, this.assets);
    const pockets = await this.store.read((tx) => tx.accountsByOwner(accountId, asset));
    if (pockets.length === 0) {
      throw new AgentBankError("not_found", `Account ${accountId} has no ${asset} pockets`, {
        account_id: accountId,
      });
    }
    return pockets;
  }

  private async inheritedChain(tx: StoreTx, ownerRef: string): Promise<number | null> {
    const accounts = await tx.accountsByOwner(ownerRef, null);
    return accounts.find((account) => account.chainId !== null)?.chainId ?? null;
  }

  /** The chain an {@link EnsureAccountInput} asks for: a number, `null`, or `undefined` to inherit. */
  private requestedChain(resolved: ResolvedRef, chainId: unknown): number | null | undefined {
    const parsed = resolved.parsed;
    if (parsed.kind === "chain") {
      if (chainId !== undefined && chainId !== parsed.chainId) {
        throw new AgentBankError("invalid_request", `${resolved.ref.code} is on chain ${parsed.chainId}`);
      }
      return parsed.chainId;
    }
    if (chainId === undefined || chainId === null) return parsed.kind === "pocket" ? chainId : null;
    if (parsed.kind !== "pocket") {
      throw new AgentBankError("invalid_request", `${resolved.ref.code} is not on a chain`);
    }
    this.assertChainId(chainId);
    return chainId;
  }

  private assertChainId(chainId: unknown): asserts chainId is number {
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) {
      throw new AgentBankError("invalid_request", "chainId must be an integer");
    }
    assertTestnet(chainId);
  }

  private newAccount(resolved: ResolvedRef, chainId: number | null, location: FundsLocation): LedgerAccount {
    const now = this.clock.now();
    return {
      id: newId("ledgerAccount", now.getTime()),
      ...resolved.ref,
      chainId,
      location,
      allowNegative: resolved.parsed.kind !== "pocket",
      balance: 0n,
      createdAt: now,
    };
  }

  private sortPockets(accounts: readonly LedgerAccount[]): LedgerAccount[] {
    const order = new Map<string, number>(
      STANDARD_POCKETS.map((pocket, index) => [`pocket:${pocket}`, index]),
    );
    return [...accounts].sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0));
  }
}
