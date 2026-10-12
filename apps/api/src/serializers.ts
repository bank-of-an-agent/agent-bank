import { formatAmount, type PaymentKind } from "@agentbank/core";
import type * as R from "@agentbank/core/api";
import type { z } from "zod";
import type {
  AccountRow,
  AgentRow,
  ApiKeyRow,
  ApprovalDecisionRow,
  ApprovalRow,
  AutoTopUpRuleRow,
  EscrowRow,
  EventRow,
  FundRow,
  MandateRow,
  MemberRow,
  OrgRow,
  OwnerOperationRow,
  PaymentRequestRow,
  PaymentRow,
  PlanRow,
  PolicyDecisionRow,
  PolicyRow,
  ProofIdentityRow,
  ProofReservationRow,
  ProofReservationStatus,
  ProofRootRow,
  ProofRootStatusRow,
  ProofSettingsRow,
  SessionRow,
  StreamRow,
  SubscriptionRow,
  SweepRuleRow,
  VaultRow,
  WebhookEndpointRow,
  X402PayeeRow,
} from "./db/rows";
import { eventData } from "./domain/events";

/**
 * Row → wire mappers. Every public response is built here so the mapping to the contract in
 * `@agentbank/core/api` (snake_case, decimal-string money, ISO timestamps) lives in one place.
 */

export type Wire<T extends z.ZodType> = z.output<T>;

const USDC_DECIMALS = 6;

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
/** Decimal string in major units (USDC), e.g. `25000000n` → `"25.00"`. */
export const decimal = (minor: bigint): string => formatAmount(minor, USDC_DECIMALS);
export const usdc = (minor: bigint): { amount: string; asset: "USDC" } => ({
  amount: decimal(minor),
  asset: "USDC",
});

export function serializeOrg(row: OrgRow): Wire<typeof R.Org> {
  return {
    id: row.id,
    object: "org",
    legal_name: row.legal_name,
    kind: row.kind,
    country: row.country.trim(),
    kyc_status: row.kyc_status,
    tier: row.tier,
    status: row.status,
    frozen_reason: row.frozen_reason,
    pending_unfreeze_at: isoOrNull(row.pending_unfreeze_at),
    owner_address: row.owner_address,
    treasury_account_id: row.treasury_account_id,
    created_at: iso(row.created_at),
  };
}

export function serializeMember(row: MemberRow): Wire<typeof R.Member> {
  return {
    id: row.id,
    object: "member",
    org_id: row.org_id,
    email: row.email,
    role: row.role,
    passkey_count: row.passkey_ids.length,
    created_at: iso(row.created_at),
  };
}

export function serializeApiKey(row: ApiKeyRow): Wire<typeof R.ApiKey> {
  return {
    id: row.id,
    object: "api_key",
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    created_at: iso(row.created_at),
    revoked_at: isoOrNull(row.revoked_at),
  };
}

export function serializeAgent(row: AgentRow): Wire<typeof R.Agent> {
  return {
    id: row.id,
    object: "agent",
    org_id: row.org_id,
    name: row.name,
    description: row.description,
    did: row.did,
    erc8004_id: row.erc8004_id,
    agent_card_url: row.agent_card_url,
    status: row.status,
    frozen_reason: row.frozen_reason,
    pending_unfreeze_at: isoOrNull(row.pending_unfreeze_at),
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
  };
}

export function serializeAccount(
  row: AccountRow,
  chainName: Wire<typeof R.Account>["chain"],
): Wire<typeof R.Account> {
  return {
    id: row.id,
    object: "account",
    agent_id: row.agent_id,
    org_id: row.org_id,
    role: row.role,
    chain: chainName,
    chain_id: row.chain_id,
    address: row.address,
    deployed: row.deployed,
    owner_address: row.owner_address,
    spend_key_address: row.spend_key_address,
    spend_key_permit: row.spend_key_permit_status,
    module_versions: row.module_versions ?? {},
    created_at: iso(row.created_at),
  };
}

export function serializeSession(row: SessionRow, now: Date): Wire<typeof R.Session> {
  let status = row.status;
  if ((status === "active" || status === "pending_install") && row.expires_at.getTime() <= now.getTime()) {
    status = "expired";
  }
  return {
    id: row.id,
    object: "session",
    account_id: row.account_id,
    public_key: row.public_key,
    scope: row.scope_json as Wire<typeof R.Session>["scope"],
    status,
    expires_at: iso(row.expires_at),
    revoked_at: isoOrNull(row.revoked_at),
    onchain_tx: row.onchain_tx,
    install_operation_id: row.install_operation_id,
    revoke_operation_id: row.revoke_operation_id,
    created_at: iso(row.created_at),
  };
}

export function serializeOwnerOperation(row: OwnerOperationRow, now: Date): Wire<typeof R.OwnerOperation> {
  const status =
    row.status === "requires_signature" && row.expires_at.getTime() <= now.getTime() ? "expired" : row.status;
  return {
    id: row.id,
    object: "owner_operation",
    account_id: row.account_id,
    purpose: row.purpose,
    subject_id: row.subject_id,
    status,
    user_op_hash: row.user_op_hash,
    chain_id: row.chain_id,
    tx_hash: row.tx_hash,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at),
  };
}

export function mandateStatus(row: MandateRow, now: Date): "active" | "expired" | "revoked" {
  if (row.revoked_at) return "revoked";
  if (row.expires_at.getTime() <= now.getTime()) return "expired";
  return "active";
}

export function serializeMandate(row: MandateRow, now: Date): Wire<typeof R.Mandate> {
  return {
    id: row.id,
    object: "mandate",
    agent_id: row.agent_id,
    signer: row.signer,
    mandate: row.signed_payload as Wire<typeof R.Mandate>["mandate"],
    status: mandateStatus(row, now),
    expires_at: iso(row.expires_at),
    spent: decimal(row.spent),
    created_at: iso(row.created_at),
  };
}

export function serializePolicyVersion(row: PolicyRow): Wire<typeof R.PolicyVersion> {
  return {
    id: row.id,
    object: "policy",
    agent_id: row.agent_id,
    version: row.version,
    rules: row.rules_json as Wire<typeof R.PolicyVersion>["rules"],
    change_kind: row.change_kind,
    effective_at: iso(row.effective_at),
    signed_by: row.signed_by,
    created_at: iso(row.created_at),
  };
}

export function serializeDecision(row: PolicyDecisionRow): Wire<typeof R.Payment>["decision"] {
  return {
    id: row.id,
    outcome: row.outcome,
    rule_hits: row.rule_hits_json.map((h) => ({
      rule: h.rule,
      effect: h.effect as "allow" | "deny" | "require_approval" | "require_owner" | "info",
      detail: h.detail,
    })),
    approvers_required: row.approvers_required,
    policy_version: row.policy_version,
    evaluated_at: iso(row.evaluated_at),
  };
}

const WIRE_PAYMENT_KINDS: readonly PaymentKind[] = [
  "transfer",
  "x402",
  "escrow",
  "stream",
  "payout",
  "refill",
];

/** Payment kinds that exist only internally (vault deposits) are shown as transfers. */
export function wirePaymentKind(kind: PaymentRow["kind"]): PaymentKind {
  return (WIRE_PAYMENT_KINDS as readonly string[]).includes(kind) ? (kind as PaymentKind) : "transfer";
}

export interface PaymentExtras {
  decision: PolicyDecisionRow | null;
  /** user_op_hash of the payment's owner operation, when policy required the owner key. */
  ownerOperationHash?: string | null;
  ownerOperationExpiresAt?: Date | null;
}

export function serializePayment(
  row: PaymentRow,
  chainId: number,
  extras: PaymentExtras,
): Wire<typeof R.Payment> {
  let signingRequest: Wire<typeof R.Payment>["signing_request"] = null;
  if (row.status === "requires_signature") {
    if (row.owner_operation_id && extras.ownerOperationHash) {
      signingRequest = {
        session_id: null,
        user_op_hash: extras.ownerOperationHash,
        chain_id: chainId,
        expires_at: iso(extras.ownerOperationExpiresAt ?? row.signature_deadline ?? row.updated_at),
      };
    } else if (row.kind !== "x402" && row.user_op_hash && row.signature_deadline) {
      signingRequest = {
        session_id: row.session_id,
        user_op_hash: row.user_op_hash,
        chain_id: chainId,
        expires_at: iso(row.signature_deadline),
      };
    }
  }
  return {
    id: row.id,
    object: "payment",
    account_id: row.account_id,
    kind: wirePaymentKind(row.kind),
    status: row.status,
    amount: usdc(row.amount),
    fee: usdc(row.fee),
    counterparty: {
      type: row.counterparty_type,
      address: row.counterparty_address,
      agent_id: row.counterparty_agent_id,
      x402_domain: row.counterparty_x402_domain,
    },
    memo: row.memo,
    mandate_id: row.mandate_id,
    payment_request_id: row.payment_request_id,
    decision: extras.decision ? serializeDecision(extras.decision) : null,
    approval_id: row.approval_id,
    escrow_id: row.escrow_id,
    stream_id: row.stream_id,
    signing_request: signingRequest,
    owner_operation_id: row.owner_operation_id,
    user_op_hash: row.owner_operation_id ? null : row.kind === "x402" ? null : row.user_op_hash,
    tx_hash: row.tx_hash,
    failure_reason: row.failure_reason,
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    settled_at: isoOrNull(row.settled_at),
  };
}

export function serializePaymentRequest(
  row: PaymentRequestRow,
  payLinkBase: string,
  now: Date,
): Wire<typeof R.PaymentRequest> {
  const status = row.status === "open" && row.expires_at.getTime() <= now.getTime() ? "expired" : row.status;
  return {
    id: row.id,
    object: "payment_request",
    account_id: row.account_id,
    pay_to: row.pay_to,
    amount: usdc(row.amount),
    memo: row.memo,
    reference: row.reference,
    status,
    pay_link: `${payLinkBase}/pay/${row.id}`,
    paid_by_payment_id: row.paid_by_payment_id,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at),
  };
}

export function serializeX402Payee(
  row: X402PayeeRow,
  payTo: string,
  facilitatorUrl: string,
  feeBps: number,
): Wire<typeof R.X402Payee> {
  return {
    object: "x402_payee",
    account_id: row.account_id,
    pay_to: payTo,
    domains: row.domains,
    facilitator_url: facilitatorUrl,
    fee_bps: feeBps,
    created_at: iso(row.created_at),
  };
}

function counterpartyOf(address: string, agentId: string | null): Wire<typeof R.Counterparty> {
  return { type: agentId ? "agent" : "address", address, agent_id: agentId, x402_domain: null };
}

export function serializeEscrow(row: EscrowRow, chainId: number): Wire<typeof R.Escrow> {
  const awaitingSignature =
    row.pending_action !== null &&
    row.user_op_hash !== null &&
    row.op_submitted_at === null &&
    row.op_deadline !== null &&
    (row.status === "requires_signature" || row.status === "locked" || row.status === "disputed");
  return {
    id: row.id,
    object: "escrow",
    payer_account_id: row.payer_account_id,
    payee: counterpartyOf(row.payee_address, row.payee_agent_id),
    amount: usdc(row.amount),
    fee: usdc(row.fee),
    status: row.status,
    release: row.release_mode,
    arbiter: row.arbiter,
    validator: row.validator_json,
    terms_hash: row.terms_hash,
    contract_address: row.contract_address,
    onchain_id: row.onchain_id,
    expires_at: iso(row.expires_at),
    pending_action: awaitingSignature ? row.pending_action : null,
    signing_request:
      awaitingSignature && row.user_op_hash && row.op_deadline
        ? {
            session_id: row.op_session_id,
            user_op_hash: row.user_op_hash,
            chain_id: chainId,
            expires_at: iso(row.op_deadline),
          }
        : null,
    memo: row.memo,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function serializeStream(row: StreamRow, chainId: number): Wire<typeof R.Stream> {
  const awaitingSignature =
    row.pending_action !== null &&
    row.user_op_hash !== null &&
    row.op_submitted_at === null &&
    row.op_deadline !== null &&
    (row.status === "requires_signature" || row.status === "active");
  return {
    id: row.id,
    object: "stream",
    payer_account_id: row.payer_account_id,
    payee: counterpartyOf(row.payee_address, row.payee_agent_id),
    kind: row.kind,
    amount_per_interval: usdc(row.amount_per_interval),
    interval_seconds: row.interval_seconds,
    deposit: usdc(row.deposit),
    settled: usdc(row.settled),
    settle_every_seconds: row.settle_every_seconds,
    start_at: iso(row.start_at),
    stop_at: isoOrNull(row.stop_at),
    status: row.status,
    contract_address: row.contract_address,
    onchain_id: row.onchain_id,
    pending_action: awaitingSignature ? row.pending_action : null,
    signing_request:
      awaitingSignature && row.user_op_hash && row.op_deadline
        ? {
            session_id: row.op_session_id,
            user_op_hash: row.user_op_hash,
            chain_id: chainId,
            expires_at: iso(row.op_deadline),
          }
        : null,
    created_at: iso(row.created_at),
  };
}

export function serializeApproval(
  row: ApprovalRow,
  payment: PaymentRow,
  decisions: ApprovalDecisionRow[],
  decision: PolicyDecisionRow | null,
  now: Date,
): Wire<typeof R.Approval> {
  const status =
    row.status === "pending" && row.expires_at.getTime() <= now.getTime() ? "expired" : row.status;
  return {
    id: row.id,
    object: "approval",
    payment_id: row.payment_id,
    org_id: row.org_id,
    agent_id: row.agent_id,
    amount: usdc(payment.amount),
    counterparty: {
      type: payment.counterparty_type,
      address: payment.counterparty_address,
      agent_id: payment.counterparty_agent_id,
      x402_domain: payment.counterparty_x402_domain,
    },
    required_approvers: row.required_approvers,
    decision: decision ? serializeDecision(decision) : null,
    decisions: decisions.map((d) => ({
      member_id: d.member_id,
      decision: d.decision,
      decided_at: iso(d.signed_at),
    })),
    status,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at),
  };
}

export function serializeVault(row: VaultRow, balance: bigint): Wire<typeof R.Vault> {
  return {
    id: row.id,
    object: "vault",
    account_id: row.account_id,
    kind: row.kind,
    name: row.name,
    target: row.target === null ? null : usdc(row.target),
    unlock_at: isoOrNull(row.unlock_at),
    balance: usdc(balance),
    contract_address: row.contract_address,
    onchain_id: row.onchain_id,
    pending_operation_id: row.pending_operation_id,
    created_at: iso(row.created_at),
  };
}

export function serializeAutoTopUp(row: AutoTopUpRuleRow): Wire<typeof R.AutoTopUpRule> {
  return {
    id: row.id,
    object: "auto_topup_rule",
    agent_id: row.agent_id,
    treasury_account_id: row.treasury_account_id,
    refill_to: usdc(row.refill_to),
    when_below: usdc(row.when_below),
    max_per_day: usdc(row.max_per_day),
    // pending_install until the owner operation that configures the executor succeeds.
    status: row.status,
    install_operation_id: row.install_operation_id,
    created_at: iso(row.created_at),
  };
}

export function serializeFund(row: FundRow): Wire<typeof R.Fund> {
  return {
    id: row.id,
    object: "fund",
    name: row.name,
    issuer: row.issuer,
    token_address: row.token_address,
    chain_id: row.chain_id,
    settlement: row.settlement,
    eligibility: {
      investor_types: row.eligibility_json.investor_types,
      jurisdictions: row.eligibility_json.jurisdictions,
      minimum: row.eligibility_json.minimum,
    },
    disclosure: row.disclosure,
  };
}

export function serializeSweepRule(row: SweepRuleRow): Wire<typeof R.SweepRule> {
  return {
    id: row.id,
    object: "sweep_rule",
    account_id: row.account_id,
    fund_id: row.fund_id,
    floor: usdc(row.floor),
    threshold: usdc(row.threshold),
    max_share_bps: row.max_share_bps,
    status: row.status,
    install_operation_id: row.install_operation_id,
    created_at: iso(row.created_at),
  };
}

export function serializeWebhookEndpoint(row: WebhookEndpointRow): Wire<typeof R.WebhookEndpoint> {
  return {
    id: row.id,
    object: "webhook_endpoint",
    url: row.url,
    events: row.events as Wire<typeof R.WebhookEndpoint>["events"],
    status: row.status,
    created_at: iso(row.created_at),
  };
}

export function serializeEvent(row: EventRow): Wire<typeof R.Event> {
  return {
    id: row.id,
    object: "event",
    type: row.type as Wire<typeof R.Event>["type"],
    org_id: row.org_id,
    data: eventData(row.payload),
    created_at: iso(row.created_at),
  };
}

export function serializePlan(row: PlanRow): Wire<typeof R.Plan> {
  return {
    code: row.code,
    name: row.name,
    monthly_price: usdc(row.monthly_price),
    max_agents: row.max_agents,
    features: row.features,
  };
}

export function serializeSubscription(row: SubscriptionRow, plan: PlanRow): Wire<typeof R.Subscription> {
  return {
    object: "subscription",
    org_id: row.org_id,
    plan: serializePlan(plan),
    status: row.status,
    current_period_start: iso(row.current_period_start),
    current_period_end: iso(row.current_period_end),
  };
}

// ---------------------------------------------------------------- private proofs

type DisclosureClassWire = Wire<typeof R.ProofSettings>["disclose"][number];

/** Settings of an agent that never configured proofs: not in the tree, nothing disclosed. */
export function serializeProofSettings(
  agentId: string,
  row: ProofSettingsRow | undefined,
): Wire<typeof R.ProofSettings> {
  return {
    object: "proof_settings",
    agent_id: agentId,
    enabled: row?.enabled ?? false,
    disclose: (row?.disclose ?? []) as DisclosureClassWire[],
    disclosure_mask: row?.disclosure_mask ?? 0,
    updated_at: row ? iso(row.updated_at) : null,
  };
}

export function serializeProofIdentity(row: ProofIdentityRow): Wire<typeof R.ProofIdentity> {
  return {
    object: "proof_identity",
    account_id: row.account_id,
    identity_commitment: row.identity_commitment,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** A pending or active reservation past its expiry reads as expired before the worker voids it. */
export function proofReservationStatus(row: ProofReservationRow, now: Date): ProofReservationStatus {
  if ((row.status === "pending" || row.status === "active") && row.expires_at.getTime() <= now.getTime()) {
    return "expired";
  }
  return row.status;
}

export function serializeProofReservation(
  row: ProofReservationRow,
  now: Date,
): Wire<typeof R.ProofReservation> {
  return {
    id: row.id,
    object: "proof_reservation",
    account_id: row.account_id,
    agent_id: row.agent_id,
    amount: usdc(row.amount),
    scope_tag: BigInt(row.scope_tag).toString(),
    expires_at: iso(row.expires_at),
    status: proofReservationStatus(row, now),
    hold_id: row.hold_id,
    created_at: iso(row.created_at),
    released_at: isoOrNull(row.released_at),
    included_in_epoch: row.included_in_epoch === null ? null : row.included_in_epoch.toString(),
  };
}

/** A published root reads as expired once `now` is past `valid_until`. */
export function proofRootStatus(row: ProofRootRow, now: Date): ProofRootStatusRow {
  if (row.status === "published" && now.getTime() > row.valid_until.getTime()) return "expired";
  return row.status;
}

export function serializeProofRoot(
  row: ProofRootRow,
  registry: string | null,
  now: Date,
): Wire<typeof R.ProofRoot> {
  return {
    object: "proof_root",
    root: row.root,
    epoch: row.epoch.toString(),
    snapshot_at: iso(row.snapshot_at),
    published_at: isoOrNull(row.published_at),
    valid_until: iso(row.valid_until),
    leaf_count: row.leaf_count,
    status: proofRootStatus(row, now),
    tx_hash: row.tx_hash,
    chain_id: row.chain_id,
    registry,
  };
}
