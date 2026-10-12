import { AgentBankError, applyBps, money, type WebhookEventType } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import {
  chainRef,
  pocketRef,
  revenueRef,
  suspenseRef,
  vaultRef,
  type Hold,
  type HoldDestination,
  type Ledger,
  type LedgerAccountRef,
  type LineInput,
} from "@agentbank/ledger";
import type { RunContext } from "./context";
import { isoOrNull, type Effect } from "./effects";
import type { Party } from "./known";
import { escrowResource, paymentResource, streamResource, type PendingEvent } from "./notify";
import {
  addressOf,
  authorizationsOf,
  lower,
  transfersOf,
  uintOf,
  userOpHashesOf,
  type AuthorizationLog,
  type ChainEvent,
  type TransferLog,
  type TxGroup,
} from "./parse";
import { one, type AccountRow, type EscrowRow, type PaymentRow, type StreamRow } from "./rows";

/**
 * Matching: turns one transaction's events into the ledger postings and row changes they
 * evidence. Every transfer from or to an Agent Bank address is accounted for exactly once:
 *
 * 1. payments by user operation (session or owner path): the transfers of that operation out of
 *    the payer must be exactly the expected set (payee amount, fee to the revenue address, an
 *    optional sweep of accrued fees) → the payment's hold is posted;
 * 2. payments by transaction hash (operations without a user operation hash);
 * 3. x402 payments by EIP-3009 authorization nonce from the payer's spend key;
 * 4. escrow, stream, vault and top-up contract events of known escrows/streams/vaults/rules;
 * 5. what is left: inflows are deposits, outflows are unexplained (suspense after the window).
 */

export const ASSET = "USDC";

/** Statuses in which a payment may still settle from chain evidence. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["requires_signature", "submitted"]);

const FEE_KINDS: Partial<Record<PaymentRow["kind"], string>> = {
  transfer: "outbound_payment",
  payout: "outbound_payment",
  escrow: "escrow",
  stream: "stream",
};

export interface PostingContext {
  refType?: string;
  refId?: string | null;
  memo?: string | null;
  agentId?: string | null;
  paymentId?: string | null;
  chainEventId: string;
  metadata: Record<string, string>;
}

export type PostingSpec =
  | { kind: "hold"; holdId: string; amount: bigint; destinations: HoldDestination[] }
  | { kind: "direct"; lines: LineInput[] };

export interface PlannedPosting {
  /** Unique within the transaction; part of the ledger idempotency key. */
  name: string;
  spec: PostingSpec;
  context: PostingContext;
  /** The event this entry is the evidence of (`chain_event.matched_entry_id`). */
  evidence: string;
  /** Other events the entry accounts for. */
  covers: string[];
  result: "matched" | "deposit" | "suspense";
  ref: string | null;
  /** Size of the movement, for the finality rule. */
  amount: bigint;
  /** Vault pocket to create (locked vaults live in the vault contract) before posting. */
  ensureVault?: { accountId: string; vaultId: string };
}

export interface ActionContext {
  tx: SqlClient;
  now: Date;
  /** Entry id of a posting by name (null when it was skipped). */
  entryOf(name: string): string | null;
  effect(effect: Effect): void;
  emit(event: PendingEvent): void;
  freeze(agentId: string): void;
  /** Whether an alert for this transaction was already raised (early alert while awaiting finality). */
  alerted: boolean;
  /** Mark a payment settled (null when it is no longer open); records the undo effect. */
  settlePayment(payment: PaymentRow, txHash: string, settledAt: Date): PaymentRow | null;
  /** Insert or update a `fee_charge` row; records the undo effect. */
  feeCharge(input: {
    accountId: string;
    orgId: string;
    kind: string;
    sourceRef: string;
    amount: bigint;
    entryId: string | null;
  }): void;
}

export type Action = (x: ActionContext) => Promise<void>;

/** A credit a contract payout made to a party. */
interface Credited {
  party: Party | null;
  amount: bigint;
  evidence: string;
}

/** An outflow from an Agent Bank address that no expected movement explains. */
export interface Unexplained {
  transfer: TransferLog;
  party: Extract<Party, { kind: "account" | "spend_key" | "revenue" }>;
  /** Raise the alert (mismatch event + pause) without posting. */
  alert: Action;
}

export interface Plan {
  postings: PlannedPosting[];
  actions: Action[];
  /** Events accounted for without an entry of their own (e.g. `Disputed`). */
  extra: Map<string, { result: "matched"; ref: string | null }>;
  unexplained: Unexplained[];
  /** Payment ids that evidence matched (reported as `ref` while deferred). */
  refs: string[];
  /**
   * Contract events about known escrows/streams whose own creation is not posted yet: the
   * transaction waits (window) rather than misreading their transfers as deposits.
   */
  blocked: string[];
  notes: string[];
}

/** Ledger balances as the plan will leave them (cached reads plus planned deltas). */
export class BalanceView {
  private readonly balances = new Map<string, bigint>();

  constructor(private readonly ledger: Ledger) {}

  private key(ref: LedgerAccountRef): string {
    return `${ref.ownerRef}|${ref.code}|${ref.asset}`;
  }

  async get(ref: LedgerAccountRef): Promise<bigint> {
    const key = this.key(ref);
    const known = this.balances.get(key);
    if (known !== undefined) return known;
    let balance = 0n;
    try {
      balance = await this.ledger.balance(ref);
    } catch (error) {
      if (!(error instanceof AgentBankError && error.code === "not_found")) throw error;
    }
    this.balances.set(key, balance);
    return balance;
  }

  async apply(ref: LedgerAccountRef, delta: bigint): Promise<void> {
    this.balances.set(this.key(ref), (await this.get(ref)) + delta);
  }

  async applyLines(lines: readonly LineInput[]): Promise<void> {
    for (const line of lines) await this.apply(line.account, line.amount);
  }
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && lower(a) === lower(b);
}

/** The pocket a credit to `party` lands in. */
export function creditRefFor(party: Party | null, chainId: number): LedgerAccountRef {
  if (party?.kind === "account") return pocketRef(party.account.id, "operating", ASSET);
  if (party?.kind === "spend_key") return pocketRef(party.account.id, "spend", ASSET);
  if (party?.kind === "revenue") return revenueRef(ASSET);
  return chainRef(chainId, ASSET);
}

/** Pockets an account's free funds at an address can be taken from, in order. */
function freePockets(party: Party): LedgerAccountRef[] {
  if (party.kind === "account") {
    return (["operating", "savings", "fees"] as const).map((p) => pocketRef(party.account.id, p, ASSET));
  }
  if (party.kind === "spend_key") return [pocketRef(party.account.id, "spend", ASSET)];
  return [revenueRef(ASSET)];
}

export class GroupPlanner {
  private readonly plan: Plan = {
    postings: [],
    actions: [],
    extra: new Map(),
    unexplained: [],
    refs: [],
    blocked: [],
    notes: [],
  };
  private readonly consumed = new Set<string>();
  private readonly claimedEvents = new Set<string>();
  /** Payments this transaction settles (so a payment is never matched twice). */
  private readonly planned = new Set<string>();
  /** Escrow statuses as this transaction leaves them (planning order). */
  private readonly escrowStatus = new Map<string, string>();
  private readonly transfers: TransferLog[];
  private readonly auths: AuthorizationLog[];
  private readonly opHashes: string[];
  private readonly metadata: Record<string, string>;

  constructor(
    private readonly group: TxGroup,
    private readonly ctx: RunContext,
    private readonly ledger: Ledger,
    private readonly balances: BalanceView,
    /** Idempotency key of a posting of this transaction (generation included). */
    private readonly keyOf: (name: string) => string,
  ) {
    this.transfers = transfersOf(group, ctx.cfg.usdc);
    this.auths = authorizationsOf(group, ctx.cfg.usdc);
    this.opHashes = userOpHashesOf(group);
    this.metadata = { tx_hash: group.txHash, block: group.blockNumber.toString() };
  }

  async build(): Promise<Plan> {
    for (const hash of this.opHashes) await this.matchPayments(this.ctx.paymentsForUserOp(hash), hash);
    await this.matchPayments(this.ctx.paymentsForTx(this.group.txHash), null);
    await this.matchX402();
    await this.contractEvents();
    await this.leftovers();
    return this.plan;
  }

  // ---------------------------------------------------------------- helpers

  private partyOf(address: string): Party | null {
    return this.ctx.known.partyOf(address);
  }

  private userOpOf(event: ChainEvent): string | null {
    if (event.userOpHash) return event.userOpHash;
    return this.opHashes.length === 1 ? (this.opHashes[0] as string) : null;
  }

  private open(): TransferLog[] {
    return this.transfers.filter((t) => !this.consumed.has(t.event.id));
  }

  private eventsNamed(name: string, contract: string | null): ChainEvent[] {
    return this.group.events.filter((e) => e.name === name && (contract === null || e.contract === contract));
  }

  private claim(event: ChainEvent | undefined): ChainEvent | undefined {
    if (event) this.claimedEvents.add(event.id);
    return event;
  }

  /** Entry context: the evidence's ledger id (`cev_…`) and the transaction's metadata. */
  private context(evidence: ChainEvent, extra: Partial<PostingContext> = {}): PostingContext {
    return { chainEventId: evidence.ledgerRef, metadata: this.metadata, ...extra };
  }

  /**
   * Debit `amount` from the free pockets of `party` (or from `pockets` when given). Returns the
   * lines and what no pocket could cover.
   */
  private async debit(
    party: Party,
    amount: bigint,
    pockets: LedgerAccountRef[] = freePockets(party),
  ): Promise<{ lines: LineInput[]; shortfall: bigint }> {
    const lines: LineInput[] = [];
    let left = amount;
    for (const ref of pockets) {
      if (left === 0n) break;
      if (ref.ownerRef === "system") {
        lines.push({ account: ref, amount: -left });
        left = 0n;
        break;
      }
      const available = await this.balances.get(ref);
      const take = available >= left ? left : available > 0n ? available : 0n;
      if (take > 0n) {
        lines.push({ account: ref, amount: -take });
        left -= take;
      }
    }
    return { lines, shortfall: left };
  }

  private async addPosting(posting: PlannedPosting, lines: readonly LineInput[]): Promise<void> {
    this.plan.postings.push(posting);
    await this.balances.applyLines(lines);
  }

  private holdLines(hold: Hold, payment: PaymentRow, destinations: HoldDestination[]): LineInput[] {
    const reserve = pocketRef(
      payment.account_id,
      hold.from === "spend" ? "spend_reserved" : "reserved",
      ASSET,
    );
    const source = pocketRef(payment.account_id, hold.from, ASSET);
    const posted = destinations.reduce((sum, d) => sum + d.amount, 0n);
    const lines: LineInput[] = [{ account: reserve, amount: -hold.amount }];
    for (const d of destinations) lines.push({ account: d.to, amount: d.amount });
    if (hold.amount > posted) lines.push({ account: source, amount: hold.amount - posted });
    return lines;
  }

  /**
   * The payment's hold, if it can be posted by this transaction: pending, or already posted by
   * this very posting (a retried transaction against a ledger that is not transactional with the
   * database, e.g. `InMemoryLedger`; the post then replays).
   */
  private async pendingHold(payment: PaymentRow, from: "operating" | "spend"): Promise<Hold | null> {
    if (!payment.hold_id) return null;
    let hold: Hold;
    try {
      hold = await this.ledger.getHold(payment.hold_id);
    } catch (error) {
      if (error instanceof AgentBankError && error.code === "not_found") return null;
      throw error;
    }
    if (hold.accountId !== payment.account_id || hold.from !== from) return null;
    if (hold.amount < payment.amount + payment.fee) return null;
    if (hold.status === "pending") return hold;
    if (hold.status === "posted" && hold.resolutionEntryId) {
      const entry = await this.ledger.getEntry(hold.resolutionEntryId);
      if (entry.idempotencyKey === this.keyOf(`hold:${payment.id}`)) return hold;
    }
    return null;
  }

  // ---------------------------------------------------------------- 1-2. payments by operation

  /** Where a payment's principal goes on-chain, and which pocket it lands in. */
  private destinationOf(
    payment: PaymentRow,
  ): { recipient: string; ref: LedgerAccountRef; vault?: string } | null {
    const cfg = this.ctx.cfg;
    switch (payment.kind) {
      case "escrow": {
        const escrow = this.ctx.escrowByPayment(payment.id);
        const contract = escrow ? lower(escrow.contract_address) : cfg.contracts.escrow;
        return contract ? { recipient: contract, ref: pocketRef(payment.account_id, "escrow", ASSET) } : null;
      }
      case "stream": {
        const stream = this.ctx.streamByPayment(payment.id);
        const contract = stream ? lower(stream.contract_address) : cfg.contracts.streams;
        return contract ? { recipient: contract, ref: pocketRef(payment.account_id, "stream", ASSET) } : null;
      }
      case "vault": {
        const vault = payment.vault_id ? this.ctx.vaults.get(payment.vault_id) : undefined;
        const contract = vault?.contract_address ? lower(vault.contract_address) : cfg.contracts.vaults;
        if (!vault || !contract) return null;
        return { recipient: contract, ref: vaultRef(payment.account_id, vault.id, ASSET), vault: vault.id };
      }
      default: {
        const party = this.partyOf(payment.counterparty_address);
        if (party?.kind === "contract") return null; // plain transfers never pay a bank contract
        return { recipient: lower(payment.counterparty_address), ref: creditRefFor(party, cfg.chainId) };
      }
    }
  }

  private async matchPayments(found: PaymentRow[], userOpHash: string | null): Promise<void> {
    const candidates = found.filter(
      (p) => p.kind !== "x402" && OPEN_STATUSES.has(p.status) && !this.planned.has(p.id),
    );
    const byPayer = new Map<string, PaymentRow[]>();
    for (const p of candidates) byPayer.set(p.account_id, [...(byPayer.get(p.account_id) ?? []), p]);
    for (const [accountId, payments] of byPayer) {
      const payer = this.ctx.accountsById.get(accountId);
      if (!payer) continue;
      this.plan.refs.push(...payments.map((p) => p.id));
      const unauthorized = payments.filter((p) => !this.ctx.isAuthorized(p, userOpHash));
      if (unauthorized.length > 0) {
        this.plan.notes.push(
          `payments ${unauthorized.map((p) => p.id).join(", ")} have no allow decision, approval or owner signature`,
        );
        continue;
      }
      const outflows = this.open().filter(
        (t) => same(t.from, payer.address) && (userOpHash === null || this.userOpOf(t.event) === userOpHash),
      );
      await this.settle(payments, payer, outflows, userOpHash);
    }
  }

  private async settle(
    payments: PaymentRow[],
    payer: AccountRow,
    outflows: TransferLog[],
    userOpHash: string | null,
  ): Promise<void> {
    const cfg = this.ctx.cfg;
    const expected = new Map<string, bigint>();
    const destinations = new Map<string, { recipient: string; ref: LedgerAccountRef; vault?: string }>();
    let fees = 0n;
    for (const p of payments) {
      const destination = this.destinationOf(p);
      if (!destination) {
        this.plan.notes.push(`payment ${p.id} has no on-chain destination`);
        return;
      }
      destinations.set(p.id, destination);
      expected.set(destination.recipient, (expected.get(destination.recipient) ?? 0n) + p.amount);
      fees += p.fee;
    }
    const observed = new Map<string, bigint>();
    for (const t of outflows) observed.set(lower(t.to), (observed.get(lower(t.to)) ?? 0n) + t.value);
    const toRevenue = observed.get(cfg.revenue) ?? 0n;
    const principalToRevenue = expected.get(cfg.revenue) ?? 0n;
    for (const [recipient, amount] of expected) {
      if (recipient === cfg.revenue) continue;
      if (observed.get(recipient) !== amount) {
        this.plan.notes.push(
          `payments ${payments.map((p) => p.id).join(", ")}: expected ${amount} to ${recipient}`,
        );
        return;
      }
    }
    for (const recipient of observed.keys()) {
      if (recipient !== cfg.revenue && !expected.has(recipient)) {
        this.plan.notes.push(
          `payments ${payments.map((p) => p.id).join(", ")}: unexpected transfer to ${recipient}`,
        );
        return;
      }
    }
    const sweep = toRevenue - principalToRevenue - fees;
    if (sweep < 0n) {
      this.plan.notes.push(
        `payments ${payments.map((p) => p.id).join(", ")}: fee transfers short by ${-sweep}`,
      );
      return;
    }
    const feesPocket = pocketRef(payer.id, "fees", ASSET);
    if (sweep > 0n && (principalToRevenue > 0n || (await this.balances.get(feesPocket)) < sweep)) {
      this.plan.notes.push(
        `payments ${payments.map((p) => p.id).join(", ")}: unexplained ${sweep} to the revenue address`,
      );
      return;
    }
    const holds = new Map<string, Hold>();
    for (const p of payments) {
      const hold = await this.pendingHold(p, "operating");
      if (!hold) {
        this.plan.notes.push(`payment ${p.id} has no pending hold covering amount and fee`);
        return;
      }
      holds.set(p.id, hold);
    }

    // Matched: every outflow of this operation is accounted for.
    for (const t of outflows) this.consumed.add(t.event.id);
    const revenueTransfers = outflows.filter((t) => lower(t.to) === cfg.revenue);
    const unusedEvidence = [...outflows];
    const uoe = this.group.events.filter(
      (e) =>
        e.name === "UserOperationEvent" &&
        userOpHash !== null &&
        lower(e.args.userOpHash ?? "") === userOpHash,
    );
    for (const p of payments) {
      const destination = destinations.get(p.id) as {
        recipient: string;
        ref: LedgerAccountRef;
        vault?: string;
      };
      const hold = holds.get(p.id) as Hold;
      const exact = unusedEvidence.findIndex(
        (t) => lower(t.to) === destination.recipient && t.value === p.amount,
      );
      const evidenceIndex =
        exact >= 0 ? exact : unusedEvidence.findIndex((t) => lower(t.to) === destination.recipient);
      const evidence = unusedEvidence.splice(evidenceIndex, 1)[0] as TransferLog;
      this.planned.add(p.id);
      const dests: HoldDestination[] = [{ to: destination.ref, amount: p.amount }];
      if (p.fee > 0n) dests.push({ to: revenueRef(ASSET), amount: p.fee });
      const contractEvents = this.contractEventsFor(p, payer);
      const name = `hold:${p.id}`;
      await this.addPosting(
        {
          name,
          spec: { kind: "hold", holdId: hold.id, amount: p.amount + p.fee, destinations: dests },
          context: this.context(evidence.event),
          evidence: evidence.event.id,
          covers: [
            ...revenueTransfers.map((t) => t.event.id),
            ...uoe.map((e) => e.id),
            ...contractEvents.map((e) => e.id),
          ],
          result: "matched",
          ref: p.id,
          amount: p.amount,
          ...(destination.vault ? { ensureVault: { accountId: payer.id, vaultId: destination.vault } } : {}),
        },
        this.holdLines(hold, p, dests),
      );
      this.plan.actions.push((x) => this.settledActions(x, p, payer, name, contractEvents));
    }
    if (sweep > 0n) {
      const evidence = revenueTransfers[revenueTransfers.length - 1] as TransferLog;
      const lines: LineInput[] = [
        { account: feesPocket, amount: -sweep },
        { account: revenueRef(ASSET), amount: sweep },
      ];
      await this.addPosting(
        {
          name: `sweep:${evidence.event.logIndex}`,
          spec: { kind: "direct", lines },
          context: this.context(evidence.event, {
            refType: "fee_sweep",
            refId: (payments[0] as PaymentRow).id,
            agentId: payer.agent_id,
            memo: "accrued fees swept with an outgoing operation",
          }),
          evidence: evidence.event.id,
          covers: [],
          result: "matched",
          ref: (payments[0] as PaymentRow).id,
          amount: sweep,
        },
        lines,
      );
    }
  }

  /** The contract events a payment's operation emitted (escrow lock, stream create/top-up, vault deposit). */
  private contractEventsFor(payment: PaymentRow, payer: AccountRow): ChainEvent[] {
    const cfg = this.ctx.cfg;
    const unclaimed = (e: ChainEvent) => !this.claimedEvents.has(e.id);
    const amountIs = (value: string | undefined) => uintOf(value) === payment.amount;
    const out: ChainEvent[] = [];
    if (payment.kind === "escrow") {
      const escrow = this.ctx.escrowByPayment(payment.id);
      const contract = escrow ? lower(escrow.contract_address) : cfg.contracts.escrow;
      const locked = this.eventsNamed("Locked", contract).find(
        (e) => unclaimed(e) && same(e.args.payer, payer.address) && amountIs(e.args.amount),
      );
      const claimed = this.claim(locked);
      if (claimed)
        out.push(
          claimed,
          ...this.eventsNamed("ValidationConfigured", contract).filter((e) => e.args.id === claimed.args.id),
        );
    } else if (payment.kind === "stream") {
      const stream = this.ctx.streamByPayment(payment.id);
      const contract = stream ? lower(stream.contract_address) : cfg.contracts.streams;
      const created = this.eventsNamed("StreamCreated", contract).find(
        (e) => unclaimed(e) && same(e.args.payer, payer.address) && amountIs(e.args.deposit),
      );
      const toppedUp = created
        ? undefined
        : this.eventsNamed("StreamToppedUp", contract).find(
            (e) => unclaimed(e) && same(e.args.payer, payer.address) && amountIs(e.args.amount),
          );
      const claimed = this.claim(created ?? toppedUp);
      if (claimed) out.push(claimed);
    } else if (payment.kind === "vault") {
      const vault = payment.vault_id ? this.ctx.vaults.get(payment.vault_id) : undefined;
      const deposited = this.eventsNamed(
        "Deposited",
        vault?.contract_address ? lower(vault.contract_address) : null,
      ).find(
        (e) =>
          unclaimed(e) &&
          same(e.args.from, payer.address) &&
          amountIs(e.args.amount) &&
          e.args.id === vault?.onchain_id,
      );
      const claimed = this.claim(deposited);
      if (claimed) out.push(claimed);
    }
    return out;
  }

  /** Row changes and events once a payment's hold is posted. */
  private async settledActions(
    x: ActionContext,
    p: PaymentRow,
    payer: AccountRow,
    posting: string,
    contractEvents: ChainEvent[],
  ): Promise<void> {
    const entryId = x.entryOf(posting);
    const row = x.settlePayment(p, this.group.txHash, this.group.blockTimestamp);
    if (!row) return;
    if (p.fee > 0n) {
      x.feeCharge({
        accountId: p.account_id,
        orgId: p.org_id,
        kind: FEE_KINDS[p.kind] ?? "outbound_payment",
        sourceRef: p.id,
        amount: p.fee,
        entryId,
      });
    }
    for (const event of contractEvents) await this.contractEffect(x, p, event);
    x.emit({ orgId: p.org_id, type: "payment.settled", data: paymentResource(row) });
    const payee =
      p.kind === "transfer" || p.kind === "payout" || p.kind === "x402"
        ? this.partyOf(p.counterparty_address)
        : null;
    if (payee?.kind === "account" && payee.account.id !== payer.id) {
      x.emit({
        orgId: payee.account.org_id,
        type: "deposit.received",
        data: this.depositData(payee.account.id, p.amount, payer.address, this.evidenceOf(posting), p.id),
      });
    }
  }

  private evidenceOf(posting: string): string | null {
    return this.plan.postings.find((p) => p.name === posting)?.evidence ?? null;
  }

  private depositData(
    accountId: string,
    amount: bigint,
    from: string,
    chainEventId: string | null,
    paymentId: string | null,
  ): Record<string, unknown> {
    return {
      object: "deposit",
      account_id: accountId,
      amount: money(amount),
      from_address: from,
      payment_id: paymentId,
      tx_hash: this.group.txHash,
      block_number: this.group.blockNumber.toString(),
      chain_event_id: chainEventId,
    };
  }

  /** Escrow lock / stream create / stream top-up row changes for a settled payment. */
  private async contractEffect(x: ActionContext, p: PaymentRow, event: ChainEvent): Promise<void> {
    if (event.name === "Locked") {
      const escrow = this.ctx.escrowByPayment(p.id);
      if (!escrow) return;
      const next = {
        status: "locked",
        onchain_id: event.args.id ?? escrow.onchain_id,
        tx_hash: this.group.txHash,
        pending_action: escrow.pending_action === "lock" ? null : escrow.pending_action,
      };
      const row = await updateEscrow(x, escrow, next);
      if (row) {
        this.ctx.escrows.set(row.id, row);
        x.emit({ orgId: p.org_id, type: "escrow.locked", data: escrowResource(row) });
      }
    } else if (event.name === "StreamCreated") {
      const stream = this.ctx.streamByPayment(p.id);
      if (!stream) return;
      const next: Record<string, string | null> = {
        status: "active",
        onchain_id: event.args.id ?? stream.onchain_id,
        tx_hash: this.group.txHash,
        pending_action: stream.pending_action === "create" ? null : stream.pending_action,
        last_settled_at: isoOrNull(stream.last_settled_at ?? stream.start_at),
      };
      const row = await updateStream(x, stream, next, 0n);
      if (row) {
        this.ctx.streams.set(row.id, row);
        x.emit({ orgId: p.org_id, type: "stream.created", data: streamResource(row) });
      }
    } else if (event.name === "StreamToppedUp") {
      const stream = this.ctx.streamByOnchain(event.contract, event.args.id ?? "");
      if (!stream) return;
      const next: Record<string, string | null> = {
        deposit: event.args.newDeposit ?? (stream.deposit + p.amount).toString(),
        pending_action: stream.pending_action === "top_up" ? null : stream.pending_action,
      };
      const row = await updateStream(x, stream, next, 0n);
      if (row) this.ctx.streams.set(row.id, row);
    }
  }

  // ---------------------------------------------------------------- 3. x402 (EIP-3009 from spend keys)

  private async matchX402(): Promise<void> {
    for (const auth of this.auths) {
      const party = this.partyOf(auth.authorizer);
      if (party?.kind !== "spend_key") continue;
      const p = this.ctx.paymentForNonce(auth.nonce);
      if (!p || p.kind !== "x402" || p.account_id !== party.account.id || !OPEN_STATUSES.has(p.status))
        continue;
      if (this.planned.has(p.id)) continue;
      this.plan.refs.push(p.id);
      if (!this.ctx.isAuthorized(p, null)) {
        this.plan.notes.push(`x402 payment ${p.id} has no allow decision`);
        continue;
      }
      const transfer = this.open().find(
        (t) => same(t.from, auth.authorizer) && same(t.to, p.counterparty_address) && t.value === p.amount,
      );
      const hold = p.fee === 0n ? await this.pendingHold(p, "spend") : null;
      if (!transfer || !hold) {
        this.plan.notes.push(`x402 payment ${p.id}: no matching transfer or pending hold`);
        continue;
      }
      this.consumed.add(transfer.event.id);
      this.claim(auth.event);
      this.planned.add(p.id);
      const payee = this.partyOf(p.counterparty_address);
      const dests: HoldDestination[] = [
        {
          to:
            payee?.kind === "contract"
              ? chainRef(this.ctx.cfg.chainId, ASSET)
              : creditRefFor(payee, this.ctx.cfg.chainId),
          amount: p.amount,
        },
      ];
      const name = `hold:${p.id}`;
      await this.addPosting(
        {
          name,
          spec: { kind: "hold", holdId: hold.id, amount: p.amount, destinations: dests },
          context: this.context(transfer.event),
          evidence: transfer.event.id,
          covers: [auth.event.id],
          result: "matched",
          ref: p.id,
          amount: p.amount,
        },
        this.holdLines(hold, p, dests),
      );
      this.plan.actions.push((x) => this.settledActions(x, p, party.account, name, []));
    }
  }

  // ---------------------------------------------------------------- 4. contract events

  private async contractEvents(): Promise<void> {
    const c = this.ctx.cfg.contracts;
    for (const event of this.group.events) {
      if (this.claimedEvents.has(event.id)) continue;
      if (c.escrow && event.contract === c.escrow) await this.escrowEvent(event);
      else if (c.streams && event.contract === c.streams) await this.streamEvent(event);
      else if (c.vaults && event.contract === c.vaults) await this.vaultEvent(event);
      else if (c.topup && event.contract === c.topup) await this.topUpEvent(event);
    }
  }

  /** The open transfer `from → to` of `amount` (the token movement a contract event announces). */
  private takeTransfer(from: string, to: string, amount: bigint): TransferLog | undefined {
    const transfer = this.open().find((t) => same(t.from, from) && same(t.to, to) && t.value === amount);
    if (transfer) this.consumed.add(transfer.event.id);
    return transfer;
  }

  /**
   * Move `amount` out of a pocket held at a bank contract to `to` (payee or the payer back):
   * the contract event and its transfer are one posting.
   */
  private async contractPayout(input: {
    event: ChainEvent;
    name: string;
    from: LedgerAccountRef;
    fromParty: Party;
    legs: { to: string; amount: bigint }[];
    refType: string;
    refId: string;
    agentId: string | null;
  }): Promise<{ posted: boolean; credited: Credited[] }> {
    const contract = input.event.contract;
    const transfers: TransferLog[] = [];
    for (const leg of input.legs) {
      if (leg.amount === 0n) continue;
      const transfer = this.takeTransfer(contract, leg.to, leg.amount);
      if (!transfer) {
        // Put back what was taken: the event does not match the token movements.
        for (const t of transfers) this.consumed.delete(t.event.id);
        this.plan.notes.push(`${input.event.name} ${input.refId}: no transfer of ${leg.amount} to ${leg.to}`);
        return { posted: false, credited: [] };
      }
      transfers.push(transfer);
    }
    const total = input.legs.reduce((sum, leg) => sum + leg.amount, 0n);
    if (total === 0n) return { posted: false, credited: [] };
    const { lines, shortfall } = await this.debit(input.fromParty, total, [input.from]);
    if (shortfall > 0n) lines.push({ account: suspenseRef(ASSET), amount: -shortfall });
    const credited: Credited[] = [];
    for (const leg of input.legs) {
      if (leg.amount === 0n) continue;
      const party = this.partyOf(leg.to);
      lines.push({ account: creditRefFor(party, this.ctx.cfg.chainId), amount: leg.amount });
      credited.push({ party, amount: leg.amount, evidence: input.event.id });
    }
    const [first, ...rest] = transfers as [TransferLog, ...TransferLog[]];
    await this.addPosting(
      {
        name: input.name,
        spec: { kind: "direct", lines },
        context: this.context(first.event, {
          refType: input.refType,
          refId: input.refId,
          agentId: input.agentId,
          memo: `${input.event.name} #${input.event.args.id ?? ""}${shortfall > 0n ? ` (shortfall ${shortfall})` : ""}`,
        }),
        evidence: first.event.id,
        covers: [input.event.id, ...rest.map((t) => t.event.id)],
        result: "matched",
        ref: input.refId,
        amount: total,
      },
      lines,
    );
    if (shortfall > 0n) {
      this.plan.notes.push(`${input.event.name} ${input.refId}: ${shortfall} more than the pocket held`);
    }
    return { posted: true, credited };
  }

  private async escrowEvent(event: ChainEvent): Promise<void> {
    const id = uintOf(event.args.id);
    if (id === null) return;
    const escrow = this.ctx.escrowByOnchain(event.contract, id.toString());
    if (!escrow) return;
    const payer = this.ctx.accountsById.get(escrow.payer_account_id);
    if (!payer) return;
    const status = this.escrowStatus.get(escrow.id) ?? escrow.status;
    if (status === "requires_signature" || status === "locking") {
      this.plan.blocked.push(`escrow ${escrow.id} is not locked in the ledger yet`);
      return;
    }
    const payerParty: Party = { kind: "account", account: payer };
    const escrowPocket = pocketRef(payer.id, "escrow", ASSET);
    const name = `${event.name.toLowerCase()}:${event.logIndex}`;
    const base = {
      event,
      name,
      from: escrowPocket,
      fromParty: payerParty,
      refType: "escrow",
      refId: escrow.id,
      agentId: payer.agent_id,
    };
    let next: string;
    let type: WebhookEventType;
    let credited: Credited[] = [];
    let resolution: { payee: string; payer: string } | null = null;
    switch (event.name) {
      case "Released": {
        const amount = uintOf(event.args.amount);
        const payee = addressOf(event.args.payee);
        if (amount === null || payee === null || (status !== "locked" && status !== "disputed")) return;
        const r = await this.contractPayout({ ...base, legs: [{ to: payee, amount }] });
        if (!r.posted) return;
        credited = r.credited;
        next = "released";
        type = "escrow.released";
        break;
      }
      case "Refunded": {
        const amount = uintOf(event.args.amount);
        if (amount === null || (status !== "locked" && status !== "disputed")) return;
        const r = await this.contractPayout({ ...base, legs: [{ to: payer.address, amount }] });
        if (!r.posted) return;
        next = "refunded";
        type = "escrow.refunded";
        break;
      }
      case "Resolved": {
        const payeeAmount = uintOf(event.args.payeeAmount);
        const payerAmount = uintOf(event.args.payerAmount);
        if (payeeAmount === null || payerAmount === null || status !== "disputed") return;
        const r = await this.contractPayout({
          ...base,
          legs: [
            { to: escrow.payee_address, amount: payeeAmount },
            { to: payer.address, amount: payerAmount },
          ],
        });
        if (!r.posted) return;
        credited = r.credited.filter(
          (c) => !(c.party?.kind === "account" && c.party.account.id === payer.id),
        );
        next = "resolved";
        type = "escrow.released";
        // The split decides the `disputes_lost` attribute of private proofs (who got less than half).
        resolution = { payee: payeeAmount.toString(), payer: payerAmount.toString() };
        break;
      }
      case "Disputed": {
        if (status !== "locked") return;
        this.plan.extra.set(event.id, { result: "matched", ref: escrow.id });
        next = "disputed";
        type = "escrow.disputed";
        break;
      }
      default:
        return;
    }
    this.claim(event);
    this.escrowStatus.set(escrow.id, next);
    this.plan.actions.push(async (x) => {
      const current = this.ctx.escrows.get(escrow.id) ?? escrow;
      const row = await updateEscrow(x, current, {
        status: next,
        pending_action: null,
        tx_hash: this.group.txHash,
        ...(resolution
          ? { resolution_payee_amount: resolution.payee, resolution_payer_amount: resolution.payer }
          : {}),
      });
      if (!row) return;
      this.ctx.escrows.set(row.id, row);
      x.emit({ orgId: payer.org_id, type, data: escrowResource(row) });
      this.emitCredits(x, credited, event.contract);
    });
  }

  /** `deposit.received` for Agent Bank accounts a contract paid. */
  private emitCredits(x: ActionContext, credited: readonly Credited[], from: string): void {
    for (const c of credited) {
      if (c.party?.kind !== "account") continue;
      x.emit({
        orgId: c.party.account.org_id,
        type: "deposit.received",
        data: this.depositData(c.party.account.id, c.amount, from, c.evidence, null),
      });
    }
  }

  private async streamEvent(event: ChainEvent): Promise<void> {
    const id = uintOf(event.args.id);
    if (id === null || (event.name !== "StreamSettled" && event.name !== "StreamCanceled")) return;
    const stream = this.ctx.streamByOnchain(event.contract, id.toString());
    if (!stream) return;
    const payer = this.ctx.accountsById.get(stream.payer_account_id);
    if (!payer) return;
    if (stream.status === "requires_signature") {
      this.plan.blocked.push(`stream ${stream.id} is not active in the ledger yet`);
      return;
    }
    const base = {
      event,
      name: `${event.name.toLowerCase()}:${event.logIndex}`,
      from: pocketRef(payer.id, "stream", ASSET),
      fromParty: { kind: "account", account: payer } as Party,
      refType: "stream",
      refId: stream.id,
      agentId: payer.agent_id,
    };
    if (event.name === "StreamSettled") {
      const amount = uintOf(event.args.amount);
      const payee = addressOf(event.args.payee);
      if (amount === null || payee === null) return;
      const r = await this.contractPayout({ ...base, legs: [{ to: payee, amount }] });
      if (!r.posted) return;
      this.claim(event);
      this.plan.actions.push(async (x) => {
        const current = this.ctx.streams.get(stream.id) ?? stream;
        const row = await updateStream(
          x,
          current,
          { last_settled_at: this.group.blockTimestamp.toISOString(), tx_hash: this.group.txHash },
          amount,
        );
        if (!row) return;
        this.ctx.streams.set(row.id, row);
        x.emit({ orgId: payer.org_id, type: "stream.settled", data: streamResource(row) });
        this.emitCredits(x, r.credited, event.contract);
      });
      return;
    }
    // StreamCanceled: the payee's share was paid (and announced) by the StreamSettled event before it.
    const refund = uintOf(event.args.refundAmount);
    if (refund === null) return;
    if (refund > 0n) {
      const r = await this.contractPayout({ ...base, legs: [{ to: payer.address, amount: refund }] });
      if (!r.posted) return;
    } else {
      this.plan.extra.set(event.id, { result: "matched", ref: stream.id });
    }
    this.claim(event);
    this.plan.actions.push(async (x) => {
      const current = this.ctx.streams.get(stream.id) ?? stream;
      const row = await updateStream(
        x,
        current,
        { status: "canceled", pending_action: null, tx_hash: this.group.txHash },
        0n,
      );
      if (!row) return;
      this.ctx.streams.set(row.id, row);
      x.emit({ orgId: payer.org_id, type: "stream.canceled", data: streamResource(row) });
    });
  }

  private async vaultEvent(event: ChainEvent): Promise<void> {
    if (event.name !== "Withdrawn") return;
    const id = uintOf(event.args.id);
    const amount = uintOf(event.args.amount);
    const account = addressOf(event.args.account);
    if (id === null || amount === null || account === null) return;
    const vault = this.ctx.vaultByOnchain(event.contract, id.toString());
    if (!vault) return;
    const owner = this.ctx.accountsById.get(vault.account_id);
    if (!owner || !same(owner.address, account)) return;
    const r = await this.contractPayout({
      event,
      name: `withdrawn:${event.logIndex}`,
      from: vaultRef(owner.id, vault.id, ASSET),
      fromParty: { kind: "account", account: owner },
      legs: [{ to: owner.address, amount }],
      refType: "vault",
      refId: vault.id,
      agentId: owner.agent_id,
    });
    if (r.posted) this.claim(event);
  }

  private async topUpEvent(event: ChainEvent): Promise<void> {
    if (event.name !== "ToppedUp") return;
    const treasuryAddress = addressOf(event.args.treasury);
    const agentAddress = addressOf(event.args.agent);
    const amount = uintOf(event.args.amount);
    if (treasuryAddress === null || agentAddress === null || amount === null || amount === 0n) return;
    const treasury = this.partyOf(treasuryAddress);
    const agent = this.partyOf(agentAddress);
    if (treasury?.kind !== "account" || agent?.kind !== "account") return;
    if (treasury.account.org_id !== agent.account.org_id) return; // executors only move funds within one org
    const transfer = this.takeTransfer(treasuryAddress, agentAddress, amount);
    if (!transfer) return;
    const { lines, shortfall } = await this.debit(treasury, amount);
    if (shortfall > 0n) lines.push({ account: suspenseRef(ASSET), amount: -shortfall });
    lines.push({ account: pocketRef(agent.account.id, "operating", ASSET), amount });
    this.claim(event);
    await this.addPosting(
      {
        name: `topup:${event.logIndex}`,
        spec: { kind: "direct", lines },
        context: this.context(transfer.event, {
          refType: "topup",
          refId: agent.account.id,
          agentId: agent.account.agent_id,
          memo: `auto top-up from treasury${shortfall > 0n ? ` (shortfall ${shortfall})` : ""}`,
        }),
        evidence: transfer.event.id,
        covers: [event.id],
        result: "matched",
        ref: agent.account.id,
        amount,
      },
      lines,
    );
    this.plan.actions.push(async (x) => {
      x.emit({
        orgId: agent.account.org_id,
        type: "deposit.received",
        data: this.depositData(agent.account.id, amount, treasuryAddress, transfer.event.id, null),
      });
    });
  }

  // ---------------------------------------------------------------- 5. deposits and unexplained outflows

  private async leftovers(): Promise<void> {
    const cfg = this.ctx.cfg;
    // Credits first (a transaction may receive and send), then x402 fees, then suspense.
    for (const t of this.open()) {
      const to = this.partyOf(t.to);
      if (!to || to.kind === "contract") continue;
      const lines: LineInput[] = [
        { account: chainRef(cfg.chainId, ASSET), amount: -t.value },
        { account: creditRefFor(to, cfg.chainId), amount: t.value },
      ];
      const account = to.kind === "revenue" ? null : to.account;
      const name = `deposit:${t.event.logIndex}`;
      await this.addPosting(
        {
          name,
          spec: { kind: "direct", lines },
          context: this.context(t.event, {
            refType: "deposit",
            refId: t.event.id,
            agentId: account?.agent_id ?? null,
            memo: `deposit from ${t.from}`,
          }),
          evidence: t.event.id,
          covers: [],
          result: "deposit",
          ref: account?.id ?? null,
          amount: t.value,
        },
        lines,
      );
      if (account) {
        this.plan.actions.push(async (x) => {
          x.emit({
            orgId: account.org_id,
            type: "deposit.received",
            data: this.depositData(account.id, t.value, t.from, t.event.id, null),
          });
        });
      }
      if (to.kind === "account") await this.x402ReceiveFee(t, to.account);
    }
    for (const t of this.open()) {
      const from = this.partyOf(t.from);
      if (!from || from.kind === "contract") continue;
      await this.unexplained(t, from);
    }
  }

  /** Seller fee (0.5%) on an x402 settlement received from outside Agent Bank. */
  private async x402ReceiveFee(t: TransferLog, account: AccountRow): Promise<void> {
    const auth = this.auths.find((a) => same(a.authorizer, t.from) && !this.claimedEvents.has(a.event.id));
    if (!auth) return;
    // With the facilitator's log (0004_x402): only its x402 sales to this seller; without it: any
    // EIP-3009 payment to a registered x402 payee.
    const sales = this.ctx.x402Sales;
    const sale = sales ? sales.get(`${lower(auth.authorizer)}|${auth.nonce}`) : undefined;
    if (sales ? sale !== account.id : !this.ctx.x402Payees.has(account.id)) return;
    const fee = applyBps(t.value, this.ctx.cfg.x402FeeBps);
    if (fee === 0n) return;
    this.claim(auth.event);
    const lines: LineInput[] = [
      { account: pocketRef(account.id, "operating", ASSET), amount: -fee },
      { account: pocketRef(account.id, "fees", ASSET), amount: fee },
    ];
    const name = `x402fee:${t.event.logIndex}`;
    await this.addPosting(
      {
        name,
        spec: { kind: "direct", lines },
        context: this.context(auth.event, {
          refType: "fee",
          refId: t.event.id,
          agentId: account.agent_id,
          memo: `x402 receive fee (${this.ctx.cfg.x402FeeBps} bps)`,
        }),
        evidence: auth.event.id,
        covers: [],
        result: "deposit",
        ref: account.id,
        amount: 0n,
      },
      lines,
    );
    this.plan.actions.push(async (x) => {
      x.feeCharge({
        accountId: account.id,
        orgId: account.org_id,
        kind: "x402_receive",
        sourceRef: t.event.id,
        amount: fee,
        entryId: x.entryOf(name),
      });
    });
  }

  private async unexplained(t: TransferLog, from: Party): Promise<void> {
    if (from.kind === "contract") return;
    const party = from;
    const account = party.kind === "revenue" ? null : party.account;
    const { lines, shortfall } = await this.debit(party, t.value);
    const covered = t.value - shortfall;
    const name = `suspense:${t.event.logIndex}`;
    if (covered > 0n) {
      lines.push({ account: suspenseRef(ASSET), amount: covered });
      await this.addPosting(
        {
          name,
          spec: { kind: "direct", lines },
          context: this.context(t.event, {
            refType: "suspense",
            refId: t.event.id,
            agentId: account?.agent_id ?? null,
            memo: `unmatched outflow to ${t.to}${shortfall > 0n ? ` (shortfall ${shortfall})` : ""}`,
          }),
          evidence: t.event.id,
          covers: [],
          result: "suspense",
          ref: account?.id ?? null,
          amount: t.value,
        },
        lines,
      );
    }
    const alert: Action = async (x) => {
      if (x.alerted) return;
      if (account?.agent_id) x.freeze(account.agent_id);
      if (account) {
        x.emit({
          orgId: account.org_id,
          type: "reconciliation.mismatch",
          data: {
            object: "reconciliation_mismatch",
            kind: "unmatched_outflow",
            account_id: account.id,
            agent_id: account.agent_id,
            address: party.kind === "spend_key" ? account.spend_key_address : account.address,
            to_address: t.to,
            amount: money(t.value),
            shortfall: money(shortfall),
            tx_hash: this.group.txHash,
            block_number: this.group.blockNumber.toString(),
            chain_event_id: t.event.id,
            suspense_entry_id: covered > 0n ? x.entryOf(name) : null,
            agent_paused: account.agent_id !== null,
          },
        });
      }
    };
    this.plan.unexplained.push({ transfer: t, party, alert });
    this.plan.actions.push(alert);
  }
}

// ---------------------------------------------------------------- row helpers

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function updateEscrow(
  x: ActionContext,
  escrow: EscrowRow,
  next: Record<string, string | null>,
): Promise<EscrowRow | undefined> {
  const prev: Record<string, string | null> = {};
  for (const column of Object.keys(next))
    prev[column] = textOf((escrow as unknown as Record<string, unknown>)[column]);
  const amount = (column: "resolution_payee_amount" | "resolution_payer_amount"): bigint | null => {
    if (!(column in next)) return escrow[column] ?? null;
    const value = next[column] ?? null;
    return value === null ? null : BigInt(value);
  };
  const row = await one<EscrowRow>(
    x.tx,
    `UPDATE escrow SET status = COALESCE($2, status), onchain_id = $3, tx_hash = $4, pending_action = $5, updated_at = $6,
            resolution_payee_amount = $7, resolution_payer_amount = $8
      WHERE id = $1 RETURNING *`,
    [
      escrow.id,
      next.status ?? null,
      "onchain_id" in next ? (next.onchain_id ?? null) : escrow.onchain_id,
      "tx_hash" in next ? (next.tx_hash ?? null) : escrow.tx_hash,
      "pending_action" in next ? (next.pending_action ?? null) : escrow.pending_action,
      x.now,
      amount("resolution_payee_amount"),
      amount("resolution_payer_amount"),
    ],
  );
  if (row) x.effect({ type: "escrow", escrow_id: escrow.id, prev, next });
  return row;
}

async function updateStream(
  x: ActionContext,
  stream: StreamRow,
  next: Record<string, string | null>,
  settledDelta: bigint,
): Promise<StreamRow | undefined> {
  const prev: Record<string, string | null> = {};
  for (const column of Object.keys(next))
    prev[column] = textOf((stream as unknown as Record<string, unknown>)[column]);
  const has = (column: string) => column in next;
  const row = await one<StreamRow>(
    x.tx,
    `UPDATE stream SET status = $2, onchain_id = $3, tx_hash = $4, pending_action = $5, deposit = $6,
            last_settled_at = $7, settled = LEAST(settled + $8, deposit), updated_at = $9
      WHERE id = $1 RETURNING *`,
    [
      stream.id,
      has("status") ? (next.status as string) : stream.status,
      has("onchain_id") ? (next.onchain_id ?? null) : stream.onchain_id,
      has("tx_hash") ? (next.tx_hash ?? null) : stream.tx_hash,
      has("pending_action") ? (next.pending_action ?? null) : stream.pending_action,
      has("deposit") ? BigInt(next.deposit as string) : stream.deposit,
      has("last_settled_at")
        ? next.last_settled_at
          ? new Date(next.last_settled_at)
          : null
        : stream.last_settled_at,
      settledDelta,
      x.now,
    ],
  );
  if (row)
    x.effect({ type: "stream", stream_id: stream.id, prev, next, settled_delta: settledDelta.toString() });
  return row;
}
