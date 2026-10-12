import {
  encodeSessionSignature,
  escrowLockCalls,
  recoverOperationSigner,
  streamCreateCalls,
  transferCall,
  vaultDepositCalls,
  type Call,
  type OperationReceipt,
  type PreparedOperation,
} from "@agentbank/chain";
import {
  AgentBankError,
  APPROVAL_TTL_SECONDS,
  isAgentBankError,
  newId,
  unixSeconds,
  type DecisionInternal,
  type IntentInternal,
  type PaymentKind,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { HoldInput } from "@agentbank/ledger";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import type {
  AccountRow,
  ApprovalDecisionRow,
  ApprovalRow,
  EscrowRow,
  OwnerOperationRow,
  PaymentRow,
  PolicyDecisionRow,
  SessionRow,
  StreamRow,
  VaultRow,
} from "../db/rows";
import { all, one } from "../db/sql";
import type { AppDeps } from "../deps";
import { serializeApproval, serializePayment, type Wire } from "../serializers";
import type * as R from "@agentbank/core/api";
import { addSeconds } from "../util/time";
import { asPrepared, contractAddress, onChain, usdcAddress } from "./chain";
import { enqueueCosigner, deliverCosignerOutbox } from "./cosigner-outbox";
import { denialReason, recordDecision } from "./decisions";
import { emitEvent } from "./events";
import { ASSET } from "./ledger-refs";
import { ledgerIn } from "./ledger-tx";
import { insertOwnerOperation, prepareOwnerOperation } from "./owner-ops";

/**
 * The payment pipeline (docs/architecture.md, "Payment flows"). One `payment` row tracks every
 * agent-initiated outflow: transfers and payouts, spend-key refills, escrow locks, stream
 * deposits and locked-vault deposits.
 *
 *   evaluate (co-signer dry run) ─ deny ──────────────────────────► denied (no hold)
 *        │ allow / require_approval / require_owner
 *        ▼
 *   hold (operating → reserved, amount + fee)
 *        ├─ require_approval → approval (15 min) ─ approved ─┐   denied/expired → hold voided
 *        ├─ require_owner → owner operation (owner signs)    │
 *        └─ allow ───────────────────────────────────────────┴─► requires_signature (session op, 10 min)
 *   session signature → co-signer re-checks and co-signs → submitted
 *        ├─ chain evidence (indexer → reconciler) → hold posted (payee + fee to sys:revenue) → settled
 *        └─ receipt reverted / dropped (worker) → hold voided, co-signer told → failed
 *
 * Every step is idempotent and resumable: ledger writes use keys derived from the payment id,
 * and `advancePayment` completes whatever a crash left undone.
 */

/** Hold lifetime: a backstop for orphaned holds; the worker voids holds of expired payments. */
const HOLD_TTL_SECONDS = 24 * 3600;
/** Dropped (not found) operations are failed only after this grace period. */
export const NOT_FOUND_GRACE_SECONDS = 600;

export type PaymentCounterparty = Pick<
  PaymentRow,
  "counterparty_type" | "counterparty_address" | "counterparty_agent_id" | "counterparty_x402_domain"
>;

export interface NewPayment {
  /** Payment id, when it had to be chosen before the record exists (x402: the co-signer saw it). */
  id?: string;
  account: AccountRow;
  agentId: string;
  sessionId: string | null;
  kind: PaymentRow["kind"];
  amount: bigint;
  fee: bigint;
  counterparty: PaymentCounterparty;
  memo: string | null;
  mandateId: string | null;
  paymentRequestId: string | null;
  metadata: Record<string, string>;
  idempotencyKey: string;
  requestHash: string;
  vaultId?: string | null;
  /** The escrow or stream this payment funds (its row is inserted in the same transaction). */
  escrowId?: string | null;
  streamId?: string | null;
  /** Decision of the co-signer dry run (or an API-level refusal). */
  decision: DecisionInternal;
  decisionSource: PolicyDecisionRow["source"];
}

export function holdKey(paymentId: string): string {
  return `payment:${paymentId}:hold`;
}

// ---------------------------------------------------------------- loading and views

export async function paymentById(db: SqlClient, id: string): Promise<PaymentRow | undefined> {
  return one<PaymentRow>(db, "SELECT * FROM payment WHERE id = $1", [id]);
}

export async function paymentView(deps: AppDeps, payment: PaymentRow): Promise<Wire<typeof R.Payment>> {
  const decision = payment.decision_id
    ? ((await one<PolicyDecisionRow>(deps.db, "SELECT * FROM policy_decision WHERE id = $1", [
        payment.decision_id,
      ])) ?? null)
    : null;
  let ownerOp: OwnerOperationRow | undefined;
  if (payment.owner_operation_id) {
    ownerOp = await one<OwnerOperationRow>(deps.db, "SELECT * FROM owner_operation WHERE id = $1", [
      payment.owner_operation_id,
    ]);
  }
  return serializePayment(payment, deps.config.chain.id, {
    decision,
    ownerOperationHash: ownerOp?.user_op_hash ?? null,
    ownerOperationExpiresAt: ownerOp?.expires_at ?? null,
  });
}

/** Wire payment kind for the co-signer (internal kinds map to transfers). */
export function intentKind(kind: PaymentRow["kind"]): PaymentKind {
  return (["transfer", "x402", "escrow", "stream", "payout", "refill"] as const).includes(kind as PaymentKind)
    ? (kind as PaymentKind)
    : "transfer";
}

/** What the payment does, as the co-signer evaluates it (payee, not the contract, for escrow/streams). */
export async function intentOf(deps: AppDeps, payment: PaymentRow): Promise<IntentInternal> {
  let counterparty: IntentInternal["counterparty"] = {
    address: payment.counterparty_address,
    ...(payment.counterparty_agent_id ? { agent_id: payment.counterparty_agent_id } : {}),
    ...(payment.counterparty_x402_domain ? { x402_domain: payment.counterparty_x402_domain } : {}),
  };
  if (payment.kind === "escrow") {
    const escrow = await one<EscrowRow>(deps.db, "SELECT * FROM escrow WHERE payment_id = $1", [payment.id]);
    if (escrow) {
      counterparty = {
        address: escrow.payee_address,
        contract: escrow.contract_address,
        ...(escrow.payee_agent_id ? { agent_id: escrow.payee_agent_id } : {}),
      };
    }
  } else if (payment.kind === "stream") {
    const stream = await one<StreamRow>(deps.db, "SELECT * FROM stream WHERE payment_id = $1", [payment.id]);
    if (stream) {
      counterparty = {
        address: stream.payee_address,
        contract: stream.contract_address,
        ...(stream.payee_agent_id ? { agent_id: stream.payee_agent_id } : {}),
      };
    }
  } else if (payment.kind === "vault") {
    counterparty = { address: payment.counterparty_address, contract: payment.counterparty_address };
  }
  return { kind: intentKind(payment.kind), amount: payment.amount.toString(), asset: "USDC", counterparty };
}

// ---------------------------------------------------------------- operation calls

async function operationCalls(deps: AppDeps, payment: PaymentRow, now: Date): Promise<Call[]> {
  const token = usdcAddress(deps);
  const calls: Call[] = [];
  switch (payment.kind) {
    case "escrow": {
      const escrow = await one<EscrowRow>(deps.db, "SELECT * FROM escrow WHERE payment_id = $1", [
        payment.id,
      ]);
      if (!escrow) throw new AgentBankError("internal", "Escrow of payment not found");
      calls.push(
        ...escrowLockCalls({
          escrow: getAddress(escrow.contract_address),
          token,
          payee: getAddress(escrow.payee_address),
          amount: escrow.amount,
          expiresAt: BigInt(unixSeconds(escrow.expires_at)),
          ...(escrow.arbiter ? { arbiter: getAddress(escrow.arbiter) } : {}),
          ...(escrow.validator_json
            ? {
                validator: getAddress(escrow.validator_json.registry),
                validationRequestHash: escrow.validator_json.request_hash as Hex,
                validationThreshold: escrow.validator_json.min_response,
              }
            : {}),
          termsHash: (escrow.terms_hash ?? keccak256(stringToHex(`agentbank:escrow:${escrow.id}`))) as Hex,
        }),
      );
      break;
    }
    case "stream": {
      const stream = await one<StreamRow>(deps.db, "SELECT * FROM stream WHERE payment_id = $1", [
        payment.id,
      ]);
      if (!stream) throw new AgentBankError("internal", "Stream of payment not found");
      calls.push(
        ...streamCreateCalls({
          streams: getAddress(stream.contract_address),
          token,
          payee: getAddress(stream.payee_address),
          deposit: stream.deposit,
          amountPerInterval: stream.amount_per_interval,
          interval: BigInt(stream.interval_seconds),
          // A start that is not in the future means "now" (the contract uses the block time).
          start: stream.start_at.getTime() > now.getTime() ? BigInt(unixSeconds(stream.start_at)) : 0n,
          stop: stream.stop_at ? BigInt(unixSeconds(stream.stop_at)) : 0n,
        }),
      );
      break;
    }
    case "vault": {
      const vault = payment.vault_id
        ? await one<VaultRow>(deps.db, "SELECT * FROM vault WHERE id = $1", [payment.vault_id])
        : undefined;
      if (!vault?.onchain_id || !vault.contract_address) {
        throw new AgentBankError("invalid_state", "The vault is not created on-chain yet");
      }
      calls.push(
        ...vaultDepositCalls({
          vaults: getAddress(vault.contract_address),
          token,
          vaultId: BigInt(vault.onchain_id),
          amount: payment.amount,
        }),
      );
      break;
    }
    default:
      calls.push(
        transferCall({ token, to: getAddress(payment.counterparty_address), amount: payment.amount }),
      );
  }
  if (payment.fee > 0n)
    calls.push(transferCall({ token, to: getAddress(deps.config.revenueAddress), amount: payment.fee }));
  return calls;
}

// ---------------------------------------------------------------- creation

/**
 * Create a payment from a dry-run decision. Denied payments are recorded without a hold.
 * Everything after the insert is done by `advancePayment` (so a crash can be resumed).
 */
export async function createPaymentRecord(
  deps: AppDeps,
  input: NewPayment,
  now: Date,
  extra?: (tx: SqlClient, payment: PaymentRow) => Promise<void>,
): Promise<PaymentRow> {
  const id = input.id ?? newId("payment", now.getTime());
  const outcome = input.decision.outcome;
  const status: PaymentRow["status"] =
    outcome === "deny"
      ? "denied"
      : outcome === "require_approval"
        ? "requires_approval"
        : "requires_signature";
  const payment = await deps.db.transaction(async (tx) => {
    const decision = await recordDecision(tx, {
      decision: input.decision,
      agentId: input.agentId,
      paymentId: id,
      source: input.decisionSource,
      now,
    });
    const deadline =
      status === "requires_approval"
        ? addSeconds(now, APPROVAL_TTL_SECONDS)
        : status === "requires_signature"
          ? addSeconds(now, deps.config.paymentSignatureTtlSeconds)
          : null;
    const row = (await one<PaymentRow>(
      tx,
      `INSERT INTO payment (id, account_id, org_id, agent_id, kind, counterparty_type, counterparty_address,
                            counterparty_agent_id, counterparty_x402_domain, amount, fee, asset, status, memo,
                            mandate_id, payment_request_id, decision_id, session_id, failure_reason, metadata,
                            idempotency_key, request_hash, signature_deadline, vault_id, escrow_id, stream_id,
                            created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'USDC', $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25, $26, $26)
       RETURNING *`,
      [
        id,
        input.account.id,
        input.account.org_id,
        input.agentId,
        input.kind,
        input.counterparty.counterparty_type,
        input.counterparty.counterparty_address,
        input.counterparty.counterparty_agent_id,
        input.counterparty.counterparty_x402_domain,
        input.amount,
        input.fee,
        status,
        input.memo,
        input.mandateId,
        input.paymentRequestId,
        decision.id,
        input.sessionId,
        status === "denied" ? denialReason(input.decision) : null,
        input.metadata,
        input.idempotencyKey,
        input.requestHash,
        deadline,
        input.vaultId ?? null,
        input.escrowId ?? null,
        input.streamId ?? null,
        now,
      ],
    )) as PaymentRow;
    if (status === "requires_approval") {
      const approvalId = newId("approval", now.getTime());
      await tx.query(
        `INSERT INTO approval (id, payment_id, org_id, agent_id, required_approvers, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [
          approvalId,
          id,
          input.account.org_id,
          input.agentId,
          Math.min(5, Math.max(1, input.decision.approvers_required)),
          addSeconds(now, APPROVAL_TTL_SECONDS),
          now,
        ],
      );
      await tx.query("UPDATE payment SET approval_id = $2 WHERE id = $1", [id, approvalId]);
      row.approval_id = approvalId;
    }
    if (extra) await extra(tx, row);
    if (status !== "denied") {
      // Same transaction as the payment row (Postgres ledger): no orphaned holds, and an
      // insufficient balance leaves no payment behind.
      try {
        const hold = await ledgerIn(deps, tx).hold(holdInput(row));
        await tx.query("UPDATE payment SET hold_id = $2 WHERE id = $1", [id, hold.id]);
        row.hold_id = hold.id;
      } catch (error) {
        if (isAgentBankError(error) && error.code === "insufficient_funds") throw insufficient(row);
        throw error;
      }
    }
    const view = serializePayment(row, deps.config.chain.id, { decision });
    await emitEvent(tx, now, { orgId: row.org_id, type: "payment.created", data: view });
    if (status === "denied")
      await emitEvent(tx, now, { orgId: row.org_id, type: "payment.denied", data: view });
    if (status === "requires_approval") {
      await emitEvent(tx, now, { orgId: row.org_id, type: "payment.requires_approval", data: view });
      const approval = (await one<ApprovalRow>(tx, "SELECT * FROM approval WHERE id = $1", [
        row.approval_id,
      ])) as ApprovalRow;
      await emitEvent(tx, now, {
        orgId: row.org_id,
        type: "approval.requested",
        data: serializeApproval(approval, row, [], decision, now),
      });
    }
    return row;
  });
  if (payment.status === "denied") return payment;
  return advancePayment(deps, payment, now);
}

/**
 * Complete whatever is missing for a live payment: the hold, then the operation to sign (session
 * path for `allow` and approved payments, owner path for `require_owner`).
 */
export async function advancePayment(deps: AppDeps, payment: PaymentRow, now: Date): Promise<PaymentRow> {
  let current = payment;
  if (
    (current.status === "requires_signature" || current.status === "requires_approval") &&
    !current.hold_id
  ) {
    current = await placeHold(deps, current, now);
  }
  if (
    current.kind !== "x402" &&
    current.status === "requires_signature" &&
    !current.user_op &&
    !current.owner_operation_id
  ) {
    const decision = current.decision_id
      ? await one<PolicyDecisionRow>(deps.db, "SELECT * FROM policy_decision WHERE id = $1", [
          current.decision_id,
        ])
      : undefined;
    try {
      current =
        decision?.outcome === "require_owner"
          ? await prepareOwnerPath(deps, current, now)
          : await prepareSessionPath(deps, current, now);
    } catch (error) {
      // Fail closed: the operation cannot be built (session not installed, simulation reverts,
      // bundler down). The hold is released and the payment reports why. A refusal by the
      // session's on-chain policies is a denial.
      if (isAgentBankError(error) && (error.code === "cosigner_unavailable" || error.code === "internal"))
        throw error;
      const reason = isAgentBankError(error) ? error.message : ((error as Error)?.message ?? "unknown error");
      if (isAgentBankError(error) && (error.code === "policy_denied" || error.code === "session_revoked")) {
        const detail = `On-chain session policy: ${reason}`.slice(0, 500);
        return closePayment(deps, current, "denied", detail, now, "payment.denied");
      }
      return failPayment(deps, current, `Could not prepare the operation: ${reason}`.slice(0, 500), now);
    }
  }
  if (current.kind === "escrow" || current.kind === "stream") await syncCompanion(deps, current);
  return current;
}

/**
 * Mirror the signing request of an escrow lock / stream creation (carried by its payment) onto
 * the escrow or stream row, so `GET /v1/escrows/{id}` shows what to sign.
 */
async function syncCompanion(deps: AppDeps, payment: PaymentRow): Promise<void> {
  if (payment.status !== "requires_signature" || !payment.user_op_hash) return;
  let hash = payment.user_op_hash;
  let sessionId: string | null = payment.session_id;
  let deadline = payment.signature_deadline;
  if (payment.owner_operation_id) {
    const op = await one<OwnerOperationRow>(deps.db, "SELECT * FROM owner_operation WHERE id = $1", [
      payment.owner_operation_id,
    ]);
    if (!op) return;
    hash = op.user_op_hash;
    sessionId = null;
    deadline = op.expires_at;
  }
  const table = payment.kind === "escrow" ? "escrow" : "stream";
  const action = payment.kind === "escrow" ? "lock" : "create";
  await deps.db.query(
    `UPDATE ${table} SET user_op_hash = $2, op_session_id = $3, op_deadline = $4
      WHERE payment_id = $1 AND pending_action = '${action}' AND status = 'requires_signature'`,
    [payment.id, hash, sessionId, deadline],
  );
}

/** Hold request for a payment: a pure function of persisted fields, so retries replay exactly. */
function holdInput(payment: PaymentRow): HoldInput {
  return {
    idempotencyKey: holdKey(payment.id),
    accountId: payment.account_id,
    asset: ASSET,
    amount: payment.amount + payment.fee,
    from: payment.kind === "x402" ? "spend" : "operating",
    expiresAt: addSeconds(payment.created_at, HOLD_TTL_SECONDS),
    refType: "payment",
    refId: payment.id,
    paymentId: payment.id,
    agentId: payment.agent_id,
    mandateId: payment.mandate_id,
    memo: payment.memo,
  };
}

function insufficient(payment: PaymentRow): AgentBankError {
  return new AgentBankError(
    "insufficient_funds",
    payment.kind === "x402"
      ? "The spend key float cannot cover this payment; refill it from the account"
      : "Available balance cannot cover the amount plus fee",
  );
}

/** Resume path: place a missing hold for a payment whose creation was interrupted. */
async function placeHold(deps: AppDeps, payment: PaymentRow, now: Date): Promise<PaymentRow> {
  try {
    const hold = await deps.ledger.hold(holdInput(payment));
    return (await one<PaymentRow>(
      deps.db,
      "UPDATE payment SET hold_id = $2, updated_at = $3 WHERE id = $1 RETURNING *",
      [payment.id, hold.id, now],
    )) as PaymentRow;
  } catch (error) {
    if (isAgentBankError(error) && error.code === "insufficient_funds") {
      await closePayment(deps, payment, "failed", "insufficient_funds", now, "payment.failed");
      throw insufficient(payment);
    }
    throw error;
  }
}

async function sessionOf(deps: AppDeps, payment: PaymentRow): Promise<SessionRow> {
  const session = payment.session_id
    ? await one<SessionRow>(deps.db, "SELECT * FROM session_key WHERE id = $1", [payment.session_id])
    : undefined;
  if (!session) throw new AgentBankError("invalid_state", "The payment has no session to sign with");
  if (session.revoked_at || session.status === "revoked")
    throw new AgentBankError("session_revoked", "Session revoked");
  if (!session.permission_id)
    throw new AgentBankError("invalid_state", "The session has no on-chain permission");
  return session;
}

async function prepareSessionPath(deps: AppDeps, payment: PaymentRow, now: Date): Promise<PaymentRow> {
  const account = (await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [
    payment.account_id,
  ])) as AccountRow;
  const session = await sessionOf(deps, payment);
  if (session.status !== "active") {
    throw new AgentBankError(
      "invalid_state",
      "Install the session on-chain (POST /v1/sessions/{id}/install) before paying",
    );
  }
  const calls = await operationCalls(deps, payment, now);
  const deadline = addSeconds(now, deps.config.paymentSignatureTtlSeconds);
  const prepared = await onChain("prepareOperation", () =>
    deps.chain.prepareOperation({
      account: getAddress(account.address),
      session: { permissionId: session.permission_id as Hex },
      calls,
      validUntil: unixSeconds(deadline),
    }),
  );
  return (await one<PaymentRow>(
    deps.db,
    `UPDATE payment SET user_op = $2, user_op_hash = $3, signature_deadline = $4, status = 'requires_signature',
            updated_at = $5
      WHERE id = $1 RETURNING *`,
    [
      payment.id,
      prepared as unknown as object,
      prepared.userOpHash,
      new Date(prepared.validUntil * 1000),
      now,
    ],
  )) as PaymentRow;
}

async function prepareOwnerPath(deps: AppDeps, payment: PaymentRow, now: Date): Promise<PaymentRow> {
  const account = (await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [
    payment.account_id,
  ])) as AccountRow;
  const calls = await operationCalls(deps, payment, now);
  const prepared = await prepareOwnerOperation(deps, account, calls, now);
  return deps.db.transaction(async (tx) => {
    const op = await insertOwnerOperation(tx, {
      account,
      purpose: "payment",
      subjectId: payment.id,
      prepared,
      now,
    });
    return (await one<PaymentRow>(
      tx,
      `UPDATE payment SET owner_operation_id = $2, user_op_hash = $3, signature_deadline = $4, updated_at = $5
        WHERE id = $1 RETURNING *`,
      [payment.id, op.id, op.user_op_hash, op.expires_at, now],
    )) as PaymentRow;
  });
}

// ---------------------------------------------------------------- signing and submission

/**
 * The agent's session signature over `signing_request.user_op_hash`: the co-signer
 * re-derives the operation, re-evaluates policy against its own history and co-signs; then the
 * operation is submitted.
 */
export async function submitSessionSignature(
  deps: AppDeps,
  payment: PaymentRow,
  input: { sessionId: string; signature: string },
  now: Date,
): Promise<PaymentRow> {
  if (payment.status === "submitted" || payment.status === "settled") return payment;
  if (payment.status !== "requires_signature" || !payment.user_op || payment.owner_operation_id) {
    throw new AgentBankError(
      "invalid_state",
      `Payment is ${payment.status}; no session signature is expected`,
    );
  }
  if (payment.signature_deadline && payment.signature_deadline.getTime() <= now.getTime()) {
    await expirePayment(deps, payment, now);
    throw new AgentBankError("invalid_state", "The signing deadline passed; the payment expired");
  }
  if (payment.session_id !== input.sessionId) {
    throw new AgentBankError("invalid_request", "Sign with the session named in signing_request.session_id");
  }
  const session = await sessionOf(deps, payment);
  if (session.expires_at.getTime() <= now.getTime())
    throw new AgentBankError("session_expired", "Session expired");
  const prepared = asPrepared(payment.user_op);
  const hash = deps.chain.hashOperation(prepared);
  let signer: string;
  try {
    signer = await recoverOperationSigner(hash, input.signature as Hex);
  } catch {
    throw new AgentBankError("signature_invalid", "Session signature could not be recovered");
  }
  if (signer.toLowerCase() !== session.public_key.toLowerCase()) {
    throw new AgentBankError("signature_invalid", "The signature was not produced by the session key");
  }
  const account = (await one<AccountRow>(deps.db, "SELECT * FROM account WHERE id = $1", [
    payment.account_id,
  ])) as AccountRow;
  const approvedBy = payment.approval_id
    ? (
        await all<ApprovalDecisionRow>(
          deps.db,
          "SELECT * FROM approval_decision WHERE approval_id = $1 AND decision = 'approve' ORDER BY signed_at",
          [payment.approval_id],
        )
      ).map((d) => d.member_id)
    : [];
  const result = await deps.cosigner.cosign({
    payment_id: payment.id,
    org_id: payment.org_id,
    agent_id: payment.agent_id as string,
    account_id: payment.account_id,
    account_address: getAddress(account.address),
    chain_id: deps.config.chain.id,
    session_id: session.id,
    operation: prepared as unknown as Record<string, unknown>,
    user_op_hash: hash,
    session_signature: input.signature,
    intent: await intentOf(deps, payment),
    fee: payment.fee.toString(),
    ...(payment.mandate_id ? { mandate_id: payment.mandate_id } : {}),
    ...(payment.approval_id && approvedBy.length > 0
      ? { approval: { approval_id: payment.approval_id, approved_by: approvedBy } }
      : {}),
  });
  if (result.decision.outcome !== "allow" || !result.signature) {
    const decision = await recordDecision(deps.db, {
      decision: result.decision,
      agentId: payment.agent_id as string,
      paymentId: payment.id,
      source: "cosigner",
      now,
    });
    await deps.db.query("UPDATE payment SET decision_id = $2 WHERE id = $1", [payment.id, decision.id]);
    return closePayment(
      deps,
      { ...payment, decision_id: decision.id },
      "denied",
      denialReason(result.decision),
      now,
      "payment.denied",
    );
  }
  const signature = encodeSessionSignature({
    permissionId: session.permission_id as Hex,
    sessionSignature: input.signature as Hex,
    cosignerSignature: result.signature as Hex,
  });
  let userOpHash: Hex;
  try {
    ({ userOpHash } = await onChain("submitOperation", () =>
      deps.chain.submitOperation({ op: prepared, signature }),
    ));
  } catch (error) {
    if (isAgentBankError(error) && error.code === "invalid_state") {
      // Nonces are sequential per account: another operation landed first (or the deadline
      // passed). The co-signer signs each payment once, so this payment ends here (its spend is
      // released) and the agent pays again with a fresh operation.
      await failPayment(deps, payment, `Operation went stale: ${error.message}`.slice(0, 500), now, null, {
        cosigned: true,
      });
      throw new AgentBankError(
        "invalid_state",
        "The operation went stale (another operation of the account landed first, or the deadline passed); create the payment again",
      );
    }
    // Co-signed but not on-chain: the co-signer recorded the spend, so it is told to release it.
    await failPayment(
      deps,
      payment,
      `Submission failed: ${(error as Error).message}`.slice(0, 500),
      now,
      null,
      { cosigned: true },
    );
    throw error;
  }
  const submitted = await markSubmitted(deps, payment, userOpHash, now);
  return (await processPaymentReceipt(deps, submitted, now)) ?? submitted;
}

export async function markSubmitted(
  deps: AppDeps,
  payment: PaymentRow,
  userOpHash: string,
  now: Date,
): Promise<PaymentRow> {
  return deps.db.transaction(async (tx) => {
    const row =
      (await one<PaymentRow>(
        tx,
        `UPDATE payment SET status = 'submitted', user_op_hash = $2, updated_at = $3
        WHERE id = $1 AND status = 'requires_signature' RETURNING *`,
        [payment.id, userOpHash, now],
      )) ?? (await paymentById(tx, payment.id));
    const view = serializePayment(row as PaymentRow, deps.config.chain.id, { decision: null });
    await emitEvent(tx, now, { orgId: payment.org_id, type: "payment.submitted", data: view });
    if (payment.kind === "escrow") {
      await tx.query(
        `UPDATE escrow SET status = 'locking', user_op_hash = NULL, op_session_id = NULL, op_deadline = NULL, updated_at = $2
          WHERE payment_id = $1 AND status = 'requires_signature'`,
        [payment.id, now],
      );
    }
    if (payment.kind === "stream") {
      await tx.query(
        `UPDATE stream SET user_op_hash = NULL, op_session_id = NULL, op_deadline = NULL, updated_at = $2
          WHERE payment_id = $1 AND status = 'requires_signature'`,
        [payment.id, now],
      );
    }
    return row as PaymentRow;
  });
}

// ---------------------------------------------------------------- receipts and settlement

/**
 * Check the chain for a submitted payment's operation. Settlement (posting the hold, `settled`,
 * escrow `locked`, stream `active`) is done by the reconciler from chain evidence the indexer
 * pushes; here only failures are handled: a reverted operation, or one the bundler dropped
 * (`not_found` after a grace period), voids the hold and fails the payment. Returns the
 * updated payment when it changed.
 */
export async function processPaymentReceipt(
  deps: AppDeps,
  payment: PaymentRow,
  now: Date,
): Promise<PaymentRow | undefined> {
  if (payment.status !== "submitted" || !payment.user_op_hash) return undefined;
  let receipt: OperationReceipt;
  try {
    receipt = await deps.chain.getOperationReceipt(payment.user_op_hash as Hex);
  } catch (error) {
    deps.logger.warn({ err: error, paymentId: payment.id }, "receipt lookup failed");
    return undefined;
  }
  if (receipt.status === "pending" || receipt.status === "succeeded") {
    if (receipt.txHash && !payment.tx_hash) {
      return (await one<PaymentRow>(deps.db, "UPDATE payment SET tx_hash = $2 WHERE id = $1 RETURNING *", [
        payment.id,
        receipt.txHash,
      ])) as PaymentRow;
    }
    return undefined;
  }
  if (
    receipt.status === "not_found" &&
    now.getTime() - payment.updated_at.getTime() < NOT_FOUND_GRACE_SECONDS * 1000
  ) {
    return undefined;
  }
  return failPayment(
    deps,
    payment,
    receipt.status === "reverted"
      ? `Operation reverted: ${receipt.revertReason ?? "unknown reason"}`
      : "Operation was dropped",
    now,
    receipt.txHash,
  );
}

/** Void the hold and close the payment in a terminal state, telling the co-signer to release the spend. */
export async function closePayment(
  deps: AppDeps,
  payment: PaymentRow,
  status: "failed" | "denied" | "canceled" | "expired",
  reason: string,
  now: Date,
  event: "payment.failed" | "payment.denied" | null,
  txHash: string | null = null,
  options: { cosigned?: boolean } = {},
): Promise<PaymentRow> {
  if (payment.hold_id) {
    try {
      // Key and reason depend only on the terminal status, so a retry replays exactly and a
      // racing close with another status finds the hold no longer pending.
      await deps.ledger.voidHold({
        idempotencyKey: `payment:${payment.id}:void:${status}`,
        holdId: payment.hold_id,
        reason: status,
      });
    } catch (error) {
      if (!(
        isAgentBankError(error) &&
        (error.code === "invalid_state" || error.code === "idempotency_conflict")
      ))
        throw error;
    }
  }
  const { row, outboxId } = await deps.db.transaction(async (tx) => {
    const updated = await one<PaymentRow>(
      tx,
      `UPDATE payment SET status = $2, failure_reason = $3, tx_hash = COALESCE($5, tx_hash), updated_at = $4
        WHERE id = $1 AND status NOT IN ('settled', 'failed', 'denied', 'canceled', 'expired') RETURNING *`,
      [payment.id, status, reason, now, txHash],
    );
    if (!updated) return { row: (await paymentById(tx, payment.id)) as PaymentRow, outboxId: null };
    if (updated.approval_id) {
      await tx.query("UPDATE approval SET status = 'expired' WHERE id = $1 AND status = 'pending'", [
        updated.approval_id,
      ]);
    }
    if (updated.owner_operation_id) {
      await tx.query(
        "UPDATE owner_operation SET status = 'expired', updated_at = $2 WHERE id = $1 AND status = 'requires_signature'",
        [updated.owner_operation_id, now],
      );
    }
    if (updated.kind === "escrow") {
      await tx.query(
        `UPDATE escrow SET status = CASE WHEN $2 = 'canceled' THEN 'canceled' ELSE 'failed' END, pending_action = NULL, updated_at = $3
          WHERE payment_id = $1 AND status IN ('requires_signature', 'locking')`,
        [updated.id, status, now],
      );
    }
    if (updated.kind === "stream") {
      await tx.query(
        `UPDATE stream SET status = CASE WHEN $2 = 'canceled' THEN 'canceled' ELSE 'failed' END, pending_action = NULL, updated_at = $3
          WHERE payment_id = $1 AND status = 'requires_signature'`,
        [updated.id, status, now],
      );
    }
    if (event) {
      const view = serializePayment(updated, deps.config.chain.id, { decision: null });
      await emitEvent(tx, now, { orgId: updated.org_id, type: event, data: view });
    }
    // The co-signer may have recorded the spend (co-signed or x402-authorized): release it.
    const cosigned = options.cosigned === true || payment.status === "submitted" || payment.kind === "x402";
    const id = cosigned
      ? await enqueueCosigner(tx, now, {
          kind: "report_settlement",
          payload: { payment_id: updated.id, status: "failed" },
        })
      : null;
    return { row: updated, outboxId: id };
  });
  if (outboxId) await deliverCosignerOutbox(deps, [outboxId]).catch(() => 0);
  return row;
}

export function failPayment(
  deps: AppDeps,
  payment: PaymentRow,
  reason: string,
  now: Date,
  txHash: string | null = null,
  options: { cosigned?: boolean } = {},
) {
  return closePayment(deps, payment, "failed", reason, now, "payment.failed", txHash, options);
}

export function expirePayment(deps: AppDeps, payment: PaymentRow, now: Date) {
  return closePayment(
    deps,
    payment,
    "expired",
    "expired before it was signed or approved",
    now,
    "payment.failed",
  );
}

/** Report a settled x402 (or other co-signed) payment to the co-signer, once per payment. */
export async function reportSettled(deps: AppDeps, payment: PaymentRow, now: Date): Promise<void> {
  const existing = await one<{ id: string; status: string }>(
    deps.db,
    `SELECT id, status FROM cosigner_outbox
      WHERE kind = 'report_settlement' AND payload->>'payment_id' = $1 AND payload->>'status' = 'settled'
      LIMIT 1`,
    [payment.id],
  );
  if (existing?.status === "done") return;
  const id =
    existing?.id ??
    (await enqueueCosigner(deps.db, now, {
      kind: "report_settlement",
      payload: { payment_id: payment.id, status: "settled", amount: payment.amount.toString() },
    }));
  await deliverCosignerOutbox(deps, [id]).catch(() => 0);
}

/** Contract address for escrow/stream/vault payments (throws when not deployed). */
export function contractFor(deps: AppDeps, kind: "escrow" | "streams" | "vaults"): Address {
  return contractAddress(deps, kind);
}

export type { PreparedOperation };
