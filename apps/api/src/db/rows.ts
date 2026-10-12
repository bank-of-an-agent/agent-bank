/**
 * Row shapes of the tables the API reads (0002_core + 0005_api). Both database drivers map
 * `int8` to bigint, `timestamptz` to Date, arrays to arrays and `jsonb` to parsed JSON.
 */

export type KycStatus = "pending" | "in_review" | "approved" | "rejected";
export type Tier = "free" | "pro" | "business" | "enterprise";
export type MemberRole = "admin" | "approver" | "viewer";

export interface OrgRow {
  id: string;
  legal_name: string;
  kind: "individual" | "company";
  country: string;
  contact_email: string;
  kyc_status: KycStatus;
  kyc_provider: string | null;
  kyc_reference: string | null;
  tier: Tier;
  status: "active" | "frozen";
  frozen_reason: string | null;
  pending_unfreeze_at: Date | null;
  owner_address: string;
  treasury_account_id: string | null;
  created_at: Date;
}

export interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  email: string;
  role: MemberRole;
  passkey_ids: string[];
  created_at: Date;
}

export interface ApiKeyRow {
  id: string;
  org_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: string[];
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  member_id: string | null;
}

export interface AgentRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  did: string | null;
  erc8004_id: string | null;
  status: "active" | "frozen";
  frozen_reason: string | null;
  pending_unfreeze_at: Date | null;
  agent_card_url: string | null;
  metadata: Record<string, string>;
  created_at: Date;
}

export interface SpendKeyPermit {
  /** Allowance in USDC minor units (decimal string). */
  value: string;
  /** Unix seconds (decimal string). */
  deadline: string;
  /** USDC `nonces(spend key)` the permit was signed with (decimal string). */
  nonce: string;
  signature: string;
}

export interface AccountRow {
  id: string;
  org_id: string;
  agent_id: string | null;
  role: "agent" | "treasury";
  chain_id: number;
  address: string;
  deployed: boolean;
  owner_address: string;
  spend_key_address: string | null;
  /** EIP-2612 permit from the spend key to the account (ADR 0001), executed at setup. */
  spend_key_permit: SpendKeyPermit | null;
  spend_key_permit_status: "none" | "pending" | "executed";
  /** The owner operation carrying the permit while it is in flight. */
  spend_key_permit_op_id: string | null;
  salt: string;
  module_versions: Record<string, string>;
  created_at: Date;
}

export type SessionStatus = "pending_install" | "active" | "expired" | "revoked";

export interface SessionRow {
  id: string;
  account_id: string;
  public_key: string;
  scope_json: Record<string, unknown>;
  owner_authorization: Record<string, unknown>;
  status: SessionStatus;
  expires_at: Date;
  revoked_at: Date | null;
  onchain_tx: string | null;
  install_operation_id: string | null;
  revoke_operation_id: string | null;
  permission_id: string | null;
  created_at: Date;
}

export type OwnerOperationPurpose =
  | "session.install"
  | "session.revoke"
  | "topup.configure"
  | "sweep.configure"
  | "vault.withdraw"
  | "payment"
  | "account.deploy"
  | "owner.swap";

export type OwnerOperationStatus = "requires_signature" | "submitted" | "succeeded" | "failed" | "expired";

export interface OwnerOperationRow {
  id: string;
  account_id: string;
  purpose: OwnerOperationPurpose;
  subject_id: string;
  status: OwnerOperationStatus;
  chain_id: number;
  user_op: Record<string, unknown>;
  user_op_hash: string;
  tx_hash: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MandateRow {
  id: string;
  agent_id: string;
  signed_payload: Record<string, unknown>;
  signer: string;
  signature: string;
  mandate_hash: string;
  constraints_json: unknown[];
  expires_at: Date;
  revoked_at: Date | null;
  spent: bigint;
  occurrences: number;
  created_at: Date;
}

export type ChangeKind = "initial" | "tighten" | "loosen" | "mixed" | "unchanged";

export interface PolicyRow {
  id: string;
  agent_id: string;
  version: number;
  rules_json: Record<string, unknown>;
  policy_hash: string;
  change_kind: ChangeKind;
  effective_at: Date;
  signed_by: string | null;
  owner_authorization: Record<string, unknown> | null;
  created_at: Date;
}

export type PaymentStatus =
  | "requires_approval"
  | "requires_signature"
  | "submitted"
  | "settled"
  | "denied"
  | "failed"
  | "canceled"
  | "expired";

export type PaymentKindRow =
  "transfer" | "x402" | "escrow" | "stream" | "payout" | "refill" | "topup" | "fee" | "vault";

export interface PaymentRow {
  id: string;
  account_id: string;
  org_id: string;
  agent_id: string | null;
  kind: PaymentKindRow;
  counterparty_type: "address" | "agent" | "x402" | "escrow" | "stream";
  counterparty_address: string;
  counterparty_agent_id: string | null;
  counterparty_x402_domain: string | null;
  amount: bigint;
  fee: bigint;
  asset: string;
  status: PaymentStatus;
  memo: string | null;
  mandate_id: string | null;
  payment_request_id: string | null;
  decision_id: string | null;
  approval_id: string | null;
  owner_operation_id: string | null;
  escrow_id: string | null;
  stream_id: string | null;
  hold_id: string | null;
  session_id: string | null;
  user_op: Record<string, unknown> | null;
  user_op_hash: string | null;
  tx_hash: string | null;
  x402_nonce: string | null;
  failure_reason: string | null;
  metadata: Record<string, string>;
  idempotency_key: string;
  request_hash: string;
  signature_deadline: Date | null;
  vault_id: string | null;
  post_settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
}

export interface PolicyDecisionRow {
  id: string;
  payment_id: string | null;
  agent_id: string;
  policy_id: string | null;
  policy_version: number;
  outcome: "allow" | "deny" | "require_approval" | "require_owner";
  rule_hits_json: { rule: string; effect: string; detail: string }[];
  approvers_required: number;
  source: "api" | "cosigner" | "dry_run";
  evaluated_at: Date;
}

export interface ApprovalRow {
  id: string;
  payment_id: string;
  org_id: string;
  agent_id: string;
  required_approvers: number;
  status: "pending" | "approved" | "denied" | "expired";
  expires_at: Date;
  created_at: Date;
}

export interface ApprovalDecisionRow {
  approval_id: string;
  member_id: string;
  decision: "approve" | "deny";
  assertion: unknown;
  signed_at: Date;
}

export type EscrowStatus =
  | "requires_signature"
  | "locking"
  | "locked"
  | "released"
  | "refunded"
  | "disputed"
  | "resolved"
  | "failed"
  | "canceled";

export interface EscrowRow {
  id: string;
  payer_account_id: string;
  payee_address: string;
  payee_agent_id: string | null;
  amount: bigint;
  fee: bigint;
  asset: string;
  status: EscrowStatus;
  release_mode: "payer" | "arbiter" | "validator";
  arbiter: string | null;
  validator_json: { registry: string; request_hash: string; min_response: number } | null;
  terms_hash: string | null;
  contract_address: string;
  onchain_id: string | null;
  expires_at: Date;
  pending_action: "lock" | "release" | "refund" | "dispute" | null;
  payment_id: string | null;
  user_op: Record<string, unknown> | null;
  user_op_hash: string | null;
  tx_hash: string | null;
  memo: string | null;
  mandate_id: string | null;
  op_session_id: string | null;
  op_deadline: Date | null;
  op_submitted_at: Date | null;
  dispute_reason: string | null;
  org_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type StreamStatus = "requires_signature" | "active" | "paused" | "completed" | "canceled" | "failed";

export interface StreamRow {
  id: string;
  payer_account_id: string;
  payee_address: string;
  payee_agent_id: string | null;
  kind: "streaming" | "recurring";
  amount_per_interval: bigint;
  interval_seconds: number;
  deposit: bigint;
  settled: bigint;
  settle_every_seconds: number;
  start_at: Date;
  stop_at: Date | null;
  status: StreamStatus;
  contract_address: string;
  onchain_id: string | null;
  pending_action: "create" | "cancel" | "top_up" | null;
  payment_id: string | null;
  user_op: Record<string, unknown> | null;
  user_op_hash: string | null;
  tx_hash: string | null;
  last_settled_at: Date | null;
  op_session_id: string | null;
  op_deadline: Date | null;
  op_submitted_at: Date | null;
  org_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VaultRow {
  id: string;
  account_id: string;
  kind: "goal" | "locked";
  name: string;
  target: bigint | null;
  unlock_at: Date | null;
  contract_address: string | null;
  onchain_id: string | null;
  pending_operation_id: string | null;
  early_nonce: bigint;
  created_at: Date;
}

export interface AutoTopUpRuleRow {
  id: string;
  agent_id: string;
  treasury_account_id: string;
  refill_to: bigint;
  when_below: bigint;
  max_per_day: bigint;
  status: "pending_install" | "active" | "disabled";
  install_operation_id: string | null;
  owner_authorization: Record<string, unknown>;
  last_triggered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FundRow {
  id: string;
  name: string;
  issuer: string;
  token_address: string;
  chain_id: number;
  settlement: "same_day" | "next_day";
  eligibility_json: {
    investor_types: string[];
    jurisdictions: string;
    minimum: { amount: string; asset: "USDC" };
  };
  disclosure: string;
  created_at: Date;
}

export interface SweepRuleRow {
  id: string;
  account_id: string;
  fund_id: string;
  floor: bigint;
  threshold: bigint;
  max_share_bps: number;
  status: "pending_install" | "active" | "disabled";
  install_operation_id: string | null;
  signed_by: string;
  owner_authorization: Record<string, unknown>;
  created_at: Date;
}

export interface PlanRow {
  code: Tier;
  name: string;
  monthly_price: bigint;
  max_agents: number | null;
  features: string[];
}

export interface SubscriptionRow {
  org_id: string;
  plan_code: Tier;
  status: "active" | "past_due" | "canceled";
  current_period_start: Date;
  current_period_end: Date;
  created_at: Date;
}

export type FeeKind =
  "outbound_payment" | "x402_receive" | "escrow" | "stream" | "treasury_sweep" | "subscription" | "gas";

export interface FeeChargeRow {
  id: string;
  account_id: string;
  org_id: string;
  kind: FeeKind;
  source_ref: string;
  amount: bigint;
  ledger_entry_id: string | null;
  created_at: Date;
}

export interface PaymentRequestRow {
  id: string;
  account_id: string;
  pay_to: string;
  amount: bigint;
  asset: string;
  memo: string | null;
  reference: string | null;
  status: "open" | "paid" | "expired" | "canceled";
  paid_by_payment_id: string | null;
  expires_at: Date;
  created_at: Date;
}

export interface X402PayeeRow {
  account_id: string;
  domains: string[];
  created_at: Date;
}

export interface WebhookEndpointRow {
  id: string;
  org_id: string;
  url: string;
  events: string[];
  secret: string;
  status: "enabled" | "disabled";
  created_at: Date;
}

export interface EventRow {
  id: string;
  org_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  status: "pending" | "succeeded" | "failed" | "dead";
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConsoleSessionRow {
  id: string;
  token_hash: string;
  member_id: string;
  org_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
}

export interface PasskeyRow {
  id: string;
  member_id: string;
  public_key: Uint8Array;
  counter: bigint;
  transports: string[];
  created_at: Date;
}

export interface WebauthnChallengeRow {
  id: string;
  challenge: string;
  purpose: "register" | "login" | "approval";
  member_id: string | null;
  invite_id: string | null;
  subject: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface MemberInviteRow {
  id: string;
  member_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface CosignerOutboxRow {
  id: string;
  kind: "freeze" | "revoke_session" | "revoke_mandate" | "report_settlement";
  payload: Record<string, unknown>;
  status: "pending" | "done";
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
