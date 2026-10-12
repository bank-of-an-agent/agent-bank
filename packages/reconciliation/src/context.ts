import type { SqlClient } from "@agentbank/db";
import { addressesOf, KnownIndex, loadAccounts, type ContractKind } from "./known";
import { authorizationsOf, lower, uintOf, userOpHashesOf, type TxGroup } from "./parse";
import {
  all,
  type AccountRow,
  type ChainEventRow,
  type ChainTxRow,
  type EscrowRow,
  type PaymentRow,
  type StreamRow,
  type VaultRow,
} from "./rows";

/** Configuration with addresses normalized (lowercase keys, checksummed forms for output). */
export interface ResolvedConfig {
  chainId: number;
  asset: "USDC";
  usdc: string;
  usdcChecksum: string;
  revenue: string;
  revenueChecksum: string;
  /** Lowercase contract addresses (null when not deployed). */
  contracts: Record<ContractKind, string | null>;
  contractsChecksum: Record<ContractKind, string | null>;
  windowBlocks: bigint;
  finalityThreshold: bigint;
  x402FeeBps: bigint;
  reversalRetryLimit: number;
}

export interface OwnerOperationRow {
  id: string;
  account_id: string;
  purpose: string;
  subject_id: string;
  status: string;
  user_op_hash: string;
}

/**
 * Everything one reconciler transaction needs, loaded in a handful of queries for all of a
 * request's transactions and kept current in memory as groups are processed.
 */
export class RunContext {
  readonly payments = new Map<string, PaymentRow>();
  readonly ownerOps = new Map<string, OwnerOperationRow[]>();
  readonly decisions = new Map<string, Set<string>>();
  readonly approvals = new Map<string, Set<string>>();
  readonly escrows = new Map<string, EscrowRow>();
  readonly streams = new Map<string, StreamRow>();
  readonly vaults = new Map<string, VaultRow>();
  readonly x402Payees = new Set<string>();
  /**
   * EIP-3009 authorizations the facilitator settled (0004_x402), `${authorizer}|${nonce}` (lowercase)
   * → the Agent Bank seller it paid; `null` when the table does not exist (then `x402Payees` decides).
   */
  x402Sales: Map<string, string | null> | null = null;
  /** chain_tx rows of the request's groups and of other blocks with the same transactions. */
  readonly chainTx = new Map<string, ChainTxRow>();
  readonly chainEvents = new Map<string, ChainEventRow[]>();
  readonly accountsById = new Map<string, AccountRow>();
  /** Existing `fee_charge` rows by `${kind}|${source_ref}` (payments and deposits of this request). */
  readonly feeCharges = new Map<string, { ledger_entry_id: string | null; amount: bigint }>();

  constructor(
    readonly cfg: ResolvedConfig,
    readonly known: KnownIndex,
  ) {}

  addAccount(account: AccountRow): void {
    this.known.add(account);
    this.accountsById.set(account.id, account);
  }

  // ---------------------------------------------------------------- payments

  /** Payments whose user operation (or owner operation) has this hash. */
  paymentsForUserOp(hash: string): PaymentRow[] {
    const ownerOpIds = new Set((this.ownerOps.get(hash) ?? []).map((op) => op.id));
    return [...this.payments.values()].filter(
      (p) =>
        (p.user_op_hash !== null && lower(p.user_op_hash) === hash) ||
        (p.owner_operation_id !== null && ownerOpIds.has(p.owner_operation_id)),
    );
  }

  paymentsForTx(txHash: string): PaymentRow[] {
    return [...this.payments.values()].filter((p) => p.tx_hash !== null && lower(p.tx_hash) === txHash);
  }

  paymentForNonce(nonce: string): PaymentRow | undefined {
    for (const p of this.payments.values())
      if (p.x402_nonce !== null && lower(p.x402_nonce) === nonce) return p;
    return undefined;
  }

  /** The owner operation with this hash for this payment, if any. */
  ownerOperationOf(payment: PaymentRow, hash: string): OwnerOperationRow | undefined {
    return (this.ownerOps.get(hash) ?? []).find((op) => op.id === payment.owner_operation_id);
  }

  /**
   * Proof that a human-governed authority allowed the payment: an `allow` policy decision, an
   * approved approval, or (for `require_owner`) the owner's own signature on the very operation
   * that moved the money. Payments without it never settle (data-model invariant).
   */
  isAuthorized(payment: PaymentRow, userOpHash: string | null): boolean {
    if (this.decisions.get(payment.id)?.has("allow")) return true;
    if (this.approvals.get(payment.id)?.has("approved")) return true;
    return userOpHash !== null && this.ownerOperationOf(payment, userOpHash) !== undefined;
  }

  // ---------------------------------------------------------------- escrows, streams, vaults

  escrowByPayment(paymentId: string): EscrowRow | undefined {
    for (const e of this.escrows.values()) if (e.payment_id === paymentId) return e;
    return undefined;
  }

  escrowByOnchain(contract: string, onchainId: string): EscrowRow | undefined {
    for (const e of this.escrows.values()) {
      if (e.onchain_id === onchainId && lower(e.contract_address) === contract) return e;
    }
    return undefined;
  }

  streamByPayment(paymentId: string): StreamRow | undefined {
    for (const s of this.streams.values()) if (s.payment_id === paymentId) return s;
    return undefined;
  }

  streamByOnchain(contract: string, onchainId: string): StreamRow | undefined {
    for (const s of this.streams.values()) {
      if (s.onchain_id === onchainId && lower(s.contract_address) === contract) return s;
    }
    return undefined;
  }

  vaultByOnchain(contract: string, onchainId: string): VaultRow | undefined {
    for (const v of this.vaults.values()) {
      if (v.onchain_id === onchainId && v.contract_address !== null && lower(v.contract_address) === contract)
        return v;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- chain evidence

  /** Other inclusions of `txHash` that still own postings (live, or orphaned with a blocked reversal). */
  otherInclusions(group: TxGroup): ChainTxRow[] {
    return [...this.chainTx.values()]
      .filter(
        (row) =>
          row.tx_hash === group.txHash &&
          row.id !== group.id &&
          (row.status !== "reorged" || row.reversal === "pending"),
      )
      .sort((a, b) => (a.block_number === b.block_number ? 0 : a.block_number > b.block_number ? -1 : 1));
  }
}

const tables = new Map<string, Promise<boolean>>();

/** Whether an optional table of another domain exists (cached per process and table). */
function hasTable(tx: SqlClient, table: string): Promise<boolean> {
  let known = tables.get(table);
  if (!known) {
    known = all<{ present: boolean }>(tx, "SELECT to_regclass($1) IS NOT NULL AS present", [table]).then(
      (rows) => rows[0]?.present === true,
    );
    tables.set(table, known);
  }
  return known;
}

/** Load the context for a request's groups. */
export async function loadContext(
  tx: SqlClient,
  cfg: ResolvedConfig,
  groups: readonly TxGroup[],
): Promise<RunContext> {
  const contracts = new Map<string, ContractKind>();
  for (const [kind, address] of Object.entries(cfg.contracts) as [ContractKind, string | null][]) {
    if (address) contracts.set(address, kind);
  }
  const accounts = await loadAccounts(tx, cfg.chainId, addressesOf(groups));
  const ctx = new RunContext(cfg, new KnownIndex({ revenue: cfg.revenue, contracts }, []));
  for (const account of accounts) ctx.addAccount(account);

  const userOps = new Set<string>();
  const txHashes = new Set<string>();
  const nonces = new Set<string>();
  const onchain = { escrow: new Set<string>(), streams: new Set<string>(), vaults: new Set<string>() };
  for (const group of groups) {
    txHashes.add(group.txHash);
    for (const hash of userOpHashesOf(group)) userOps.add(hash);
    for (const auth of authorizationsOf(group, cfg.usdc)) nonces.add(auth.nonce);
    for (const event of group.events) {
      const id = uintOf(event.args.id);
      if (id === null) continue;
      if (event.contract === cfg.contracts.escrow) onchain.escrow.add(id.toString());
      if (event.contract === cfg.contracts.streams) onchain.streams.add(id.toString());
      if (event.contract === cfg.contracts.vaults) onchain.vaults.add(id.toString());
    }
  }

  // Chain evidence already recorded for these transactions (this block or others).
  const groupIds = groups.map((g) => g.id);
  const txRows = await all<ChainTxRow>(
    tx,
    `SELECT * FROM chain_tx WHERE id = ANY($1::text[])
        OR (chain_id = $2 AND tx_hash = ANY($3::text[]) AND (status <> 'reorged' OR reversal = 'pending'))`,
    [groupIds, cfg.chainId, [...txHashes]],
  );
  for (const row of txRows) ctx.chainTx.set(row.id, row);
  if (txRows.length > 0) {
    const eventRows = await all<ChainEventRow>(
      tx,
      `SELECT id, chain_tx_id, log_index, event_name, status, result, ref, entry_id, matched_entry_id
         FROM chain_event WHERE chain_tx_id = ANY($1::text[]) ORDER BY log_index`,
      [txRows.map((r) => r.id)],
    );
    for (const row of eventRows)
      ctx.chainEvents.set(row.chain_tx_id, [...(ctx.chainEvents.get(row.chain_tx_id) ?? []), row]);
  }

  // Payments the evidence could settle.
  const ownerOps =
    userOps.size === 0
      ? []
      : await all<OwnerOperationRow>(
          tx,
          "SELECT id, account_id, purpose, subject_id, status, user_op_hash FROM owner_operation WHERE user_op_hash = ANY($1::text[])",
          [[...userOps]],
        );
  for (const op of ownerOps) {
    const key = lower(op.user_op_hash);
    ctx.ownerOps.set(key, [...(ctx.ownerOps.get(key) ?? []), op]);
  }
  // One branch per lookup so each uses its own index (user_op_hash, tx_hash, x402_nonce).
  const branches: [string, string[]][] = [
    ["user_op_hash", [...userOps]],
    ["tx_hash", [...txHashes]],
    ["x402_nonce", [...nonces]],
    ["owner_operation_id", ownerOps.map((op) => op.id)],
  ];
  const used = branches.filter(([, values]) => values.length > 0);
  const found =
    used.length === 0
      ? []
      : await all<PaymentRow>(
          tx,
          used
            .map(([column], i) => `SELECT * FROM payment WHERE ${column} = ANY($${i + 1}::text[])`)
            .join(" UNION ALL "),
          used.map(([, values]) => values),
        );
  for (const p of found) ctx.payments.set(p.id, p);
  const payments = [...ctx.payments.values()];
  const paymentIds = payments.map((p) => p.id);
  if (paymentIds.length > 0) {
    const decisions = await all<{ payment_id: string; outcome: string }>(
      tx,
      "SELECT payment_id, outcome FROM policy_decision WHERE payment_id = ANY($1::text[])",
      [paymentIds],
    );
    for (const d of decisions)
      ctx.decisions.set(d.payment_id, (ctx.decisions.get(d.payment_id) ?? new Set()).add(d.outcome));
    // Approvals only matter for payments without an `allow` decision.
    const undecided = paymentIds.filter((id) => !ctx.decisions.get(id)?.has("allow"));
    if (undecided.length > 0) {
      const approvals = await all<{ payment_id: string; status: string }>(
        tx,
        "SELECT payment_id, status FROM approval WHERE payment_id = ANY($1::text[])",
        [undecided],
      );
      for (const a of approvals)
        ctx.approvals.set(a.payment_id, (ctx.approvals.get(a.payment_id) ?? new Set()).add(a.status));
    }
  }

  // Escrows, streams and vaults: by the payments that fund them and by on-chain id.
  const escrowPayments = payments.filter((p) => p.kind === "escrow").map((p) => p.id);
  if (escrowPayments.length > 0 || (cfg.contracts.escrow && onchain.escrow.size > 0)) {
    const rows = await all<EscrowRow>(
      tx,
      "SELECT * FROM escrow WHERE payment_id = ANY($1::text[]) OR (lower(contract_address) = $2 AND onchain_id = ANY($3::text[]))",
      [escrowPayments, cfg.contracts.escrow ?? "", [...onchain.escrow]],
    );
    for (const row of rows) ctx.escrows.set(row.id, row);
  }
  const streamPayments = payments.filter((p) => p.kind === "stream").map((p) => p.id);
  if (streamPayments.length > 0 || (cfg.contracts.streams && onchain.streams.size > 0)) {
    const rows = await all<StreamRow>(
      tx,
      "SELECT * FROM stream WHERE payment_id = ANY($1::text[]) OR (lower(contract_address) = $2 AND onchain_id = ANY($3::text[]))",
      [streamPayments, cfg.contracts.streams ?? "", [...onchain.streams]],
    );
    for (const row of rows) ctx.streams.set(row.id, row);
  }
  const vaultIds = payments.map((p) => p.vault_id).filter((v): v is string => typeof v === "string");
  if (vaultIds.length > 0 || (cfg.contracts.vaults && onchain.vaults.size > 0)) {
    const rows = await all<VaultRow>(
      tx,
      `SELECT id, account_id, kind, contract_address, onchain_id FROM vault
        WHERE id = ANY($1::text[]) OR (lower(contract_address) = $2 AND onchain_id = ANY($3::text[]))`,
      [vaultIds, cfg.contracts.vaults ?? "", [...onchain.vaults]],
    );
    for (const row of rows) ctx.vaults.set(row.id, row);
  }

  // Accounts referenced only by id (escrow payers named by no event, payment payers).
  const missing = new Set<string>();
  for (const p of payments) if (!ctx.accountsById.has(p.account_id)) missing.add(p.account_id);
  for (const e of ctx.escrows.values())
    if (!ctx.accountsById.has(e.payer_account_id)) missing.add(e.payer_account_id);
  for (const s of ctx.streams.values())
    if (!ctx.accountsById.has(s.payer_account_id)) missing.add(s.payer_account_id);
  for (const v of ctx.vaults.values()) if (!ctx.accountsById.has(v.account_id)) missing.add(v.account_id);
  if (missing.size > 0) {
    const rows = await all<AccountRow>(
      tx,
      "SELECT id, org_id, agent_id, role, chain_id, address, spend_key_address FROM account WHERE id = ANY($1::text[])",
      [[...missing]],
    );
    for (const row of rows) ctx.addAccount(row);
  }
  // Fee charges the request may write (payments with a fee, x402 receive fees) and registered
  // x402 sellers: only when there is something to charge.
  const authorized = groups.filter((g) => authorizationsOf(g, cfg.usdc).length > 0);
  const sourceRefs = [
    ...payments.filter((p) => p.fee > 0n).map((p) => p.id),
    ...authorized.flatMap((g) => g.events.filter((e) => e.name === "Transfer").map((e) => e.id)),
  ];
  if (sourceRefs.length > 0) {
    const fees = await all<{
      kind: string;
      source_ref: string;
      ledger_entry_id: string | null;
      amount: bigint;
    }>(
      tx,
      `SELECT kind, source_ref, ledger_entry_id, amount FROM fee_charge
        WHERE kind = ANY($1::text[]) AND source_ref = ANY($2::text[])`,
      [["outbound_payment", "escrow", "stream", "x402_receive"], sourceRefs],
    );
    for (const f of fees) {
      ctx.feeCharges.set(`${f.kind}|${f.source_ref}`, {
        ledger_entry_id: f.ledger_entry_id,
        amount: f.amount,
      });
    }
  }
  const accountIds = [...ctx.accountsById.keys()];
  if (authorized.length > 0 && accountIds.length > 0) {
    const payees = await all<{ account_id: string }>(
      tx,
      "SELECT account_id FROM x402_payee WHERE account_id = ANY($1::text[])",
      [accountIds],
    );
    for (const p of payees) ctx.x402Payees.add(p.account_id);
    if (await hasTable(tx, "x402_authorization")) {
      const auths = authorized.flatMap((g) => authorizationsOf(g, cfg.usdc));
      const sales = await all<{ authorizer: string; nonce: string; payee_account_id: string | null }>(
        tx,
        `SELECT authorizer, nonce, payee_account_id FROM x402_authorization
          WHERE chain_id = $1 AND asset = $2 AND authorizer = ANY($3::text[]) AND nonce = ANY($4::text[])`,
        [
          cfg.chainId,
          cfg.usdcChecksum,
          [...new Set(auths.map((a) => a.authorizer))],
          [...new Set(auths.map((a) => a.nonce))],
        ],
      );
      ctx.x402Sales = new Map(
        sales.map((s) => [`${lower(s.authorizer)}|${lower(s.nonce)}`, s.payee_account_id]),
      );
    }
  }
  return ctx;
}
