import {
  AgentBankError,
  canonicalSha256,
  DomainSchema,
  MAX_MINOR_UNITS,
  newId,
  unixSeconds,
  type DecisionInternal,
} from "@agentbank/core";
import { getAddress, keccak256, stringToHex } from "viem";
import type { PaymentRow, X402PayeeRow } from "../db/rows";
import { one } from "../db/sql";
import { accountByAddress, loadAccount } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { X402_RECEIVE_FEE_BPS } from "../domain/billing";
import { usdcAddress, usdcDomain } from "../domain/chain";
import { deliverCosignerOutbox, enqueueCosigner } from "../domain/cosigner-outbox";
import { advancePayment, createPaymentRecord, paymentView } from "../domain/payments";
import type { AppDeps } from "../deps";
import { requireAgent, requirePrincipal } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeX402Payee } from "../serializers";
import { assertMandateUsable, screenCounterparty } from "./payments";

/**
 * x402 pay (buyer agent), ADR 0001: the API checks the 402 challenge, asks the co-signer to
 * authorize it (domain allowlist, caps, velocity, mandate), holds `spend → spend_reserved` and
 * returns the EIP-3009 `TransferWithAuthorization` for the agent's spend key to sign
 * (value = requirements.amount, nonce = keccak256(payment id), validAfter = created − 600 s,
 * validBefore = created + maxTimeoutSeconds). The seller's
 * facilitator settles; the reconciler posts the hold when `AuthorizationUsed` shows up.
 * Refusals are `policy_denied` errors with the decision: payments that would need a human
 * (approval or owner key) are refused too, because an HTTP 402 retry cannot wait for them.
 */

/** Tell the co-signer an authorization it reserved spend for will never be used. */
async function releaseCosignerSpend(deps: AppDeps, paymentId: string, now: Date): Promise<void> {
  const id = await enqueueCosigner(deps.db, now, {
    kind: "report_settlement",
    payload: { payment_id: paymentId, status: "failed" },
  });
  await deliverCosignerOutbox(deps, [id]).catch(() => 0);
}

/** EIP-3009 `validAfter` sits this far before the payment's creation (clock skew). */
export const X402_VALID_AFTER_SKEW_SECONDS = 600;

/** EIP-3009 nonce of an x402 payment: keccak256 of the payment id (32 bytes). */
export function x402Nonce(paymentId: string): `0x${string}` {
  return keccak256(stringToHex(paymentId));
}

async function payResponse(deps: AppDeps, payment: PaymentRow) {
  const view = await paymentView(deps, payment);
  const live = payment.status === "requires_signature" && payment.x402_nonce && payment.signature_deadline;
  const account = await one<{ spend_key_address: string | null }>(
    deps.db,
    "SELECT spend_key_address FROM account WHERE id = $1",
    [payment.account_id],
  );
  return {
    object: "x402_authorization" as const,
    payment: view,
    authorization:
      live && account?.spend_key_address
        ? {
            from: getAddress(account.spend_key_address),
            to: getAddress(payment.counterparty_address),
            value: payment.amount.toString(),
            // The facilitator accepts validAfter <= now and now + 6 <= validBefore <= now +
            // maxTimeoutSeconds + 60; both are fixed at creation so replays return the same values.
            validAfter: String(Math.max(0, unixSeconds(payment.created_at) - X402_VALID_AFTER_SKEW_SECONDS)),
            validBefore: String(unixSeconds(payment.signature_deadline as Date)),
            nonce: payment.x402_nonce as string,
          }
        : null,
    eip712_domain: live ? usdcDomain(deps) : null,
  };
}

export const x402Handlers: Pick<Handlers, "x402Pay" | "registerX402Payee"> = {
  async x402Pay({ body }, { deps, auth, now, idempotencyKey }) {
    const agent = requireAgent(auth);
    const account = await loadAccount(deps.db, agent, body.account_id);
    if (!account.spend_key_address) {
      throw new AgentBankError(
        "invalid_request",
        "The account has no x402 spend key (set spend_key_address when creating it)",
      );
    }
    const key = idempotencyKey as string;
    const existing = await one<PaymentRow>(
      deps.db,
      "SELECT * FROM payment WHERE account_id = $1 AND idempotency_key = $2",
      [account.id, key],
    );
    if (existing) return payResponse(deps, await advancePayment(deps, existing, now));

    const req = body.requirements;
    const chain = deps.config.chain;
    if (req.scheme !== "exact")
      throw new AgentBankError("invalid_request", 'Only the x402 "exact" scheme is supported');
    if (req.network !== chain.caip2 && req.network !== chain.x402Network) {
      throw new AgentBankError(
        "unsupported_chain",
        `This deployment pays on ${chain.caip2}, not ${req.network}`,
      );
    }
    if (req.asset.toLowerCase() !== usdcAddress(deps).toLowerCase()) {
      throw new AgentBankError("unsupported_asset", "Only USDC is supported");
    }
    const domainInfo = usdcDomain(deps);
    const extra = req.extra as { name?: unknown; version?: unknown };
    if (
      (extra.name !== undefined && extra.name !== domainInfo.name) ||
      (extra.version !== undefined && extra.version !== domainInfo.version)
    ) {
      throw new AgentBankError(
        "invalid_request",
        "requirements.extra does not match the USDC EIP-712 domain",
      );
    }
    const amount = BigInt(req.amount);
    if (amount <= 0n || amount > MAX_MINOR_UNITS)
      throw new AgentBankError("invalid_amount", "requirements.amount must be positive");
    if (req.maxTimeoutSeconds < 6 || req.maxTimeoutSeconds > deps.config.x402MaxTimeoutSeconds) {
      throw new AgentBankError(
        "invalid_request",
        `maxTimeoutSeconds must be between 6 and ${deps.config.x402MaxTimeoutSeconds}`,
      );
    }
    const domain = new URL(body.resource.url).hostname.toLowerCase().replace(/\.$/, "");
    if (!DomainSchema.safeParse(domain).success) {
      throw new AgentBankError("invalid_request", "The resource URL must use a DNS host name");
    }
    const payTo = getAddress(req.payTo);
    if (
      payTo.toLowerCase() === account.spend_key_address.toLowerCase() ||
      payTo.toLowerCase() === account.address.toLowerCase()
    ) {
      throw new AgentBankError("invalid_request", "An agent cannot pay itself");
    }
    if (body.mandate_id) await assertMandateUsable(deps.db, agent.agentId, body.mandate_id, now);
    const payee = await accountByAddress(deps.db, account.chain_id, payTo);

    const paymentId = newId("payment", now.getTime());
    let decision: DecisionInternal | null = await screenCounterparty(deps, payTo, now);
    let source: "api" | "cosigner" = "api";
    if (!decision) {
      const result = await deps.cosigner.authorizeX402({
        payment_id: paymentId,
        org_id: account.org_id,
        agent_id: agent.agentId,
        account_id: account.id,
        account_address: getAddress(account.address),
        chain_id: chain.id,
        spend_key_address: getAddress(account.spend_key_address),
        x402_domain: domain,
        pay_to: payTo,
        amount: amount.toString(),
        asset: "USDC",
        ...(body.mandate_id ? { mandate_id: body.mandate_id } : {}),
      });
      decision = result.decision;
      source = "cosigner";
      if (decision.outcome === "require_approval" || decision.outcome === "require_owner") {
        decision = {
          ...decision,
          outcome: "deny",
          rule_hits: [
            ...decision.rule_hits,
            {
              rule: "x402.human_required",
              effect: "deny",
              detail:
                "x402 payments cannot wait for an approval or the owner key; pay with a transfer instead",
            },
          ],
        };
      }
    }
    const reserved = source === "cosigner" && decision.outcome === "allow";
    const created = await createPaymentRecord(
      deps,
      {
        id: paymentId,
        account,
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        kind: "x402",
        amount,
        fee: 0n,
        counterparty: {
          counterparty_type: "x402",
          counterparty_address: payTo,
          counterparty_agent_id: payee?.agent_id ?? null,
          counterparty_x402_domain: domain,
        },
        memo: body.resource.description?.slice(0, 500) ?? null,
        mandateId: body.mandate_id ?? null,
        paymentRequestId: null,
        metadata: { resource: body.resource.url.slice(0, 500) },
        idempotencyKey: key,
        requestHash: canonicalSha256(body),
        decision,
        decisionSource: source,
      },
      now,
    ).catch(async (error: unknown) => {
      // No payment exists (e.g. the float cannot cover it): release what the co-signer reserved.
      if (reserved) await releaseCosignerSpend(deps, paymentId, now);
      throw error;
    });
    if (created.status === "denied") {
      // An x402 retry cannot wait for anyone: every refusal (including "needs approval" or
      // "needs the owner key") is a policy_denied error carrying the decision.
      throw new AgentBankError("policy_denied", created.failure_reason ?? "Denied by policy", {
        decision,
        payment_id: created.id,
      });
    }
    let payment = created;
    if (created.status === "requires_signature") {
      payment = (await one<PaymentRow>(
        deps.db,
        "UPDATE payment SET x402_nonce = $2, signature_deadline = $3, updated_at = $4 WHERE id = $1 RETURNING *",
        [created.id, x402Nonce(created.id), new Date((unixSeconds(now) + req.maxTimeoutSeconds) * 1000), now],
      )) as PaymentRow;
    }
    return payResponse(deps, payment);
  },

  async registerX402Payee({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const account = await loadAccount(deps.db, principal, body.account_id);
    const domains = [...new Set(body.domains.map((d) => d.toLowerCase()))];
    const row = await deps.db.transaction(async (tx) => {
      const upserted = (await one<X402PayeeRow>(
        tx,
        `INSERT INTO x402_payee (account_id, domains, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET domains = EXCLUDED.domains RETURNING *`,
        [account.id, domains, now],
      )) as X402PayeeRow;
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "x402_payee.register",
        subject: account.id,
        payload: { domains },
      });
      return upserted;
    });
    return new Envelope(
      serializeX402Payee(row, getAddress(account.address), deps.config.facilitatorUrl, X402_RECEIVE_FEE_BPS),
      201,
    );
  },
};
