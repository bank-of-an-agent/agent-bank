import { isAgentBankError } from "@agentbank/core";
import type { AccountRow, PaymentRow, X402PayeeRow } from "../db/rows";
import { all, one } from "../db/sql";
import { accountByAddress } from "../domain/access";
import { applyIncomeSplit, applyRoundUp } from "../domain/auto-save";
import { recordFeeCharge, x402ReceiveFee } from "../domain/billing";
import { pocket } from "../domain/ledger-refs";
import { reportSettled } from "../domain/payments";
import type { AppDeps } from "../deps";

/**
 * Follow-up after the reconciler settles a payment (it posts the hold and sets `settled` from
 * chain evidence). The API then does what belongs to the API, idempotently:
 *
 * - the `fee_charge` row for the fee the settlement posted to `sys:revenue` (outbound 0.20%
 *   capped at $5, escrow 1% min $1, streams 0.5%), keyed `(kind, payment id)`;
 * - the x402 receive fee (0.5%) accrued to a registered seller's `fees` pocket;
 * - the payment request marked paid;
 * - owner-signed auto-save rules: income split for an Agent Bank payee, round-up for the payer;
 * - a settlement report to the co-signer for x402 payments.
 */

const FEE_KINDS: Partial<Record<PaymentRow["kind"], "outbound_payment" | "escrow" | "stream">> = {
  transfer: "outbound_payment",
  payout: "outbound_payment",
  escrow: "escrow",
  stream: "stream",
};

async function chargeX402ReceiveFee(
  deps: AppDeps,
  payment: PaymentRow,
  payee: AccountRow,
  now: Date,
): Promise<void> {
  const registered = await one<X402PayeeRow>(deps.db, "SELECT * FROM x402_payee WHERE account_id = $1", [
    payee.id,
  ]);
  if (!registered) return;
  const fee = x402ReceiveFee(payment.amount);
  if (fee <= 0n) return;
  const entry = await deps.ledger.post({
    idempotencyKey: `x402fee:${payment.id}`,
    lines: [
      { account: pocket(payee.id, "operating"), amount: -fee },
      { account: pocket(payee.id, "fees"), amount: fee },
    ],
    refType: "fee",
    refId: payment.id,
    paymentId: payment.id,
    memo: "x402 receive fee (0.50%)",
  });
  await recordFeeCharge(deps.db, now, {
    accountId: payee.id,
    orgId: payee.org_id,
    kind: "x402_receive",
    sourceRef: payment.id,
    amount: fee,
    ledgerEntryId: entry.id,
  });
}

/**
 * Worker job `payments-post-settlement`. Its effects (income split, round-up, the payment
 * request marked paid, the seller's x402 fee) are not undone by the reconciler's reorg
 * reversals, so a payment is processed only once the block that settled it is final (its
 * `chain_tx` row is `processed` at or below the gateway's `finalized` block). Every effect is
 * idempotent per payment (deterministic ledger keys, conditional updates, policy evaluated as of
 * the settlement time), so a crash midway is simply retried.
 */
export async function processSettled(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  let finalized: bigint;
  try {
    finalized = (await deps.chain.getBlock("finalized")).number;
  } catch (error) {
    deps.logger.warn({ err: error }, "no finalized block: post-settlement work waits");
    return 0;
  }
  const settled = await all<PaymentRow>(
    deps.db,
    `SELECT p.* FROM payment p
      WHERE p.status = 'settled' AND p.post_settled_at IS NULL AND p.tx_hash IS NOT NULL
        AND EXISTS (SELECT 1 FROM chain_tx c
                     WHERE c.chain_id = $1 AND c.tx_hash = lower(p.tx_hash)
                       AND c.status = 'processed' AND c.block_number <= $2)
      ORDER BY p.settled_at LIMIT 200`,
    [deps.config.chain.id, finalized],
  );
  let done = 0;
  for (const payment of settled) {
    // Policy-dependent effects use the rules in force when the payment settled, so a retry
    // computes the same amounts under the same ledger keys.
    const at = payment.settled_at ?? now;
    try {
      const feeKind = FEE_KINDS[payment.kind];
      if (feeKind && payment.fee > 0n) {
        let entryId: string | null = null;
        if (payment.hold_id) {
          const hold = await deps.ledger.getHold(payment.hold_id).catch(() => undefined);
          entryId = hold?.resolutionEntryId ?? null;
        }
        await recordFeeCharge(deps.db, at, {
          accountId: payment.account_id,
          orgId: payment.org_id,
          kind: feeKind,
          sourceRef: payment.id,
          amount: payment.fee,
          ledgerEntryId: entryId,
        });
      }
      if (payment.payment_request_id) {
        await deps.db.query(
          "UPDATE payment_request SET status = 'paid', paid_by_payment_id = $2 WHERE id = $1 AND status IN ('open', 'expired')",
          [payment.payment_request_id, payment.id],
        );
      }
      const payee =
        payment.kind === "transfer" || payment.kind === "payout" || payment.kind === "x402"
          ? await accountByAddress(deps.db, deps.config.chain.id, payment.counterparty_address)
          : undefined;
      if (payment.kind === "x402") {
        if (payee) await chargeX402ReceiveFee(deps, payment, payee, at);
        await reportSettled(deps, payment, now);
      }
      if (payee && payee.id !== payment.account_id)
        await applyIncomeSplit(deps, payee, payment.amount, payment.id, at);
      if (payment.kind === "transfer" || payment.kind === "payout") await applyRoundUp(deps, payment, at);
      await deps.db.query(
        "UPDATE payment SET post_settled_at = $2 WHERE id = $1 AND post_settled_at IS NULL",
        [payment.id, now],
      );
      done++;
    } catch (error) {
      if (isAgentBankError(error) && error.code === "insufficient_funds") continue; // retried next run
      deps.logger.error({ err: error, paymentId: payment.id }, "post-settlement processing failed");
    }
  }
  return done;
}
