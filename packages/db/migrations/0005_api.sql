-- 0005_api: tables and columns used only by apps/api that 0002_core does not carry:
-- console sign-in (passkey sessions, WebAuthn challenges, member invites), the co-signer
-- outbox for tightening changes, auto-save and statement bookkeeping, extra lookup indexes,
-- and the sandbox fund list.
--
-- Conventions as in 0002_core: prefixed text ids, bigint minor units, timestamptz.

-- An API key acts for the member who created it (approvals are recorded per member).
ALTER TABLE api_key ADD COLUMN member_id text REFERENCES member (id);
CREATE INDEX api_key_org_idx ON api_key (org_id, created_at DESC);

-- EIP-2612 permit signed by the agent's x402 spend key granting the smart account an allowance
-- (ADR 0001: the owner can always sweep the float back). `{value, deadline, signature}`; it is
-- submitted in the account's setup owner operation.
ALTER TABLE account ADD COLUMN spend_key_permit jsonb;

-- Smart Sessions permission id of an installed session (bytes32 hex).
ALTER TABLE session_key ADD COLUMN permission_id text;
CREATE INDEX session_key_status_idx ON session_key (status, expires_at);

-- Locked-vault deposits run through the payment pipeline (kind 'vault').
ALTER TABLE payment ADD COLUMN vault_id text REFERENCES vault (id);
CREATE INDEX payment_org_idx ON payment (org_id, created_at DESC);
CREATE INDEX payment_mandate_idx ON payment (mandate_id) WHERE mandate_id IS NOT NULL;

-- Escrow and stream follow-up operations (release, refund, dispute, cancel) after creation.
ALTER TABLE escrow ADD COLUMN op_session_id text;
ALTER TABLE escrow ADD COLUMN op_deadline timestamptz;
ALTER TABLE escrow ADD COLUMN op_submitted_at timestamptz;
ALTER TABLE escrow ADD COLUMN dispute_reason text;
ALTER TABLE escrow ADD COLUMN org_id text REFERENCES org (id);
CREATE INDEX escrow_open_idx ON escrow (status) WHERE pending_action IS NOT NULL;

ALTER TABLE stream ADD COLUMN op_session_id text;
ALTER TABLE stream ADD COLUMN op_deadline timestamptz;
ALTER TABLE stream ADD COLUMN op_submitted_at timestamptz;
ALTER TABLE stream ADD COLUMN org_id text REFERENCES org (id);
CREATE INDEX stream_payer_idx ON stream (payer_account_id);
CREATE INDEX stream_active_idx ON stream (status) WHERE status = 'active';

CREATE INDEX vault_account_idx ON vault (account_id);
-- TimeLockVaults early-withdrawal nonce (EIP-712 `EarlyWithdrawal.nonce`) as seen by the API.
ALTER TABLE vault ADD COLUMN early_nonce bigint NOT NULL DEFAULT 0;

-- Keeper bookkeeping for auto top-up triggers.
ALTER TABLE auto_topup_rule ADD COLUMN last_triggered_at timestamptz;

-- API follow-up after the reconciler settles a payment (fee_charge, payment request, auto-save).
ALTER TABLE payment ADD COLUMN post_settled_at timestamptz;
CREATE INDEX payment_post_settle_idx ON payment (settled_at) WHERE status = 'settled' AND post_settled_at IS NULL;
CREATE INDEX owner_operation_open_idx ON owner_operation (status) WHERE status IN ('requires_signature', 'submitted');
CREATE INDEX approval_pending_idx ON approval (expires_at) WHERE status = 'pending';
CREATE INDEX payment_request_account_idx ON payment_request (account_id);
CREATE INDEX idempotency_record_created_idx ON idempotency_record (created_at);
CREATE INDEX request_nonce_expiry_idx ON request_nonce (expires_at);
CREATE INDEX policy_agent_idx ON policy (agent_id, version DESC);
CREATE INDEX webhook_endpoint_org_idx ON webhook_endpoint (org_id);

-- At most one treasury account per org and chain.
CREATE UNIQUE INDEX account_treasury_uq ON account (org_id, chain_id) WHERE role = 'treasury';

-- Console sessions for passkey users. Only the SHA-256 of the cookie value is stored.
CREATE TABLE console_session (
  id           text PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  member_id    text NOT NULL REFERENCES member (id),
  org_id       text NOT NULL REFERENCES org (id),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz
);
CREATE INDEX console_session_member_idx ON console_session (member_id);

-- Single-use WebAuthn challenges (registration, sign-in, approval decisions).
CREATE TABLE webauthn_challenge (
  id         text PRIMARY KEY,
  challenge  text NOT NULL UNIQUE,
  purpose    text NOT NULL CHECK (purpose IN ('register', 'login', 'approval')),
  member_id  text REFERENCES member (id),
  invite_id  text,
  subject    text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL
);

-- One-time invitations that let a new member register their first passkey.
CREATE TABLE member_invite (
  id         text PRIMARY KEY,
  member_id  text NOT NULL REFERENCES member (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL
);

-- Tightening changes (freezes, revocations) and settlement reports that must reach the
-- co-signer even if it is briefly unreachable. Written in the same transaction as the
-- local change; delivered immediately and retried by the worker.
CREATE TABLE cosigner_outbox (
  id              text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('freeze', 'revoke_session', 'revoke_mandate', 'report_settlement')),
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error      text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX cosigner_outbox_due_idx ON cosigner_outbox (next_attempt_at) WHERE status = 'pending';

-- Auto-save bookkeeping: last run of each scheduled rule.
CREATE TABLE auto_save_run (
  agent_id    text NOT NULL REFERENCES agent (id),
  rule_key    text NOT NULL,
  last_run_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, rule_key)
);

-- One statement.ready event per account and month.
CREATE TABLE statement_notice (
  account_id text NOT NULL REFERENCES account (id),
  period     text NOT NULL,
  event_id   text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, period)
);

-- Neutral fund eligibility list: SANDBOX MOCK entries only. These are not real funds and
-- nothing here is a recommendation. Real entries are added only after counsel sign-off.
INSERT INTO fund (id, name, issuer, token_address, chain_id, settlement, eligibility_json, disclosure) VALUES
  ('fnd_00000000000000000000000001', 'Sandbox Mock Treasury Fund A (not a real fund)', 'Agent Bank sandbox (mock issuer)',
   '0x5A0D000000000000000000000000000000000A01', 84532, 'same_day',
   '{"investor_types": ["any (sandbox)"], "jurisdictions": "sandbox only", "minimum": {"amount": "1.00", "asset": "USDC"}}',
   'SANDBOX MOCK. Not a real fund, not a security, no yield. Exists only to exercise the treasury sweep flow on testnet. Agent Bank makes no recommendation.'),
  ('fnd_00000000000000000000000002', 'Sandbox Mock Treasury Fund B (not a real fund)', 'Agent Bank sandbox (mock issuer)',
   '0x5A0D000000000000000000000000000000000B02', 84532, 'next_day',
   '{"investor_types": ["qualified purchaser (sandbox)"], "jurisdictions": "sandbox only", "minimum": {"amount": "100000.00", "asset": "USDC"}}',
   'SANDBOX MOCK. Not a real fund, not a security, no yield. Exists only to exercise the treasury sweep flow on testnet. Agent Bank makes no recommendation.'),
  ('fnd_00000000000000000000000003', 'Sandbox Mock Treasury Fund A (not a real fund)', 'Agent Bank sandbox (mock issuer)',
   '0x5A0D000000000000000000000000000000000A03', 31337, 'same_day',
   '{"investor_types": ["any (sandbox)"], "jurisdictions": "sandbox only", "minimum": {"amount": "1.00", "asset": "USDC"}}',
   'SANDBOX MOCK. Not a real fund, not a security, no yield. Exists only to exercise the treasury sweep flow on testnet. Agent Bank makes no recommendation.'),
  ('fnd_00000000000000000000000004', 'Sandbox Mock Treasury Fund A (not a real fund)', 'Agent Bank sandbox (mock issuer)',
   '0x5A0D000000000000000000000000000000000A04', 1337, 'same_day',
   '{"investor_types": ["any (sandbox)"], "jurisdictions": "sandbox only", "minimum": {"amount": "1.00", "asset": "USDC"}}',
   'SANDBOX MOCK. Not a real fund, not a security, no yield. Exists only to exercise the treasury sweep flow on testnet. Agent Bank makes no recommendation.'),
  ('fnd_00000000000000000000000005', 'Sandbox Mock Treasury Fund B (not a real fund)', 'Agent Bank sandbox (mock issuer)',
   '0x5A0D000000000000000000000000000000000B05', 1337, 'next_day',
   '{"investor_types": ["qualified purchaser (sandbox)"], "jurisdictions": "sandbox only", "minimum": {"amount": "100000.00", "asset": "USDC"}}',
   'SANDBOX MOCK. Not a real fund, not a security, no yield. Exists only to exercise the treasury sweep flow on testnet. Agent Bank makes no recommendation.');
