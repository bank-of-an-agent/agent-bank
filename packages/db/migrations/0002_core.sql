-- 0002_core: identity, accounts, authority (sessions, mandates, policies),
-- payments, approvals, escrow, streams, savings, billing, webhooks, audit.
--
-- Conventions: ids are prefixed text (org_, agt_, acct_, pay_ …); money is
-- bigint minor units (USDC: 6 decimals) and never numeric/float; addresses
-- are stored checksummed; every timestamp is timestamptz.

CREATE OR REPLACE FUNCTION agentbank_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TABLE org (
  id                  text PRIMARY KEY,
  legal_name          text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('individual', 'company')),
  country             char(2) NOT NULL,
  contact_email       text NOT NULL,
  kyc_status          text NOT NULL DEFAULT 'pending'
                      CHECK (kyc_status IN ('pending', 'in_review', 'approved', 'rejected')),
  kyc_provider        text,
  kyc_reference       text,
  tier                text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'business', 'enterprise')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  frozen_reason       text,
  pending_unfreeze_at timestamptz,
  owner_address       text NOT NULL,
  treasury_account_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES org (id),
  user_id     text NOT NULL,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'approver', 'viewer')),
  passkey_ids text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE passkey (
  id          text PRIMARY KEY,           -- WebAuthn credential id (base64url)
  member_id   text NOT NULL REFERENCES member (id),
  public_key  bytea NOT NULL,
  counter     bigint NOT NULL DEFAULT 0,
  transports  text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES org (id),
  name         text NOT NULL,
  prefix       text NOT NULL,
  secret_hash  text NOT NULL UNIQUE,      -- sha256 of the secret; the secret is shown once
  scopes       text[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);

CREATE TABLE agent (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES org (id),
  name                text NOT NULL,
  description         text,
  did                 text,
  erc8004_id          text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  frozen_reason       text,
  pending_unfreeze_at timestamptz,
  agent_card_url      text,
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_org_idx ON agent (org_id, created_at DESC);

CREATE TABLE account (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES org (id),
  agent_id          text REFERENCES agent (id),
  role              text NOT NULL CHECK (role IN ('agent', 'treasury')),
  chain_id          integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  address           text NOT NULL,
  deployed          boolean NOT NULL DEFAULT false,
  owner_address     text NOT NULL,
  spend_key_address text,
  spend_key_permit  jsonb,
  spend_key_permit_status text NOT NULL DEFAULT 'none'
                    CHECK (spend_key_permit_status IN ('none', 'pending', 'executed')),
  salt              text NOT NULL,
  module_versions   jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address),
  CHECK ((role = 'agent') = (agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_agent_chain_uq ON account (agent_id, chain_id) WHERE role = 'agent';
CREATE INDEX account_org_idx ON account (org_id);
CREATE INDEX account_spend_key_idx ON account (spend_key_address) WHERE spend_key_address IS NOT NULL;

CREATE TABLE session_key (
  id                  text PRIMARY KEY,
  account_id          text NOT NULL REFERENCES account (id),
  public_key          text NOT NULL,      -- session key address
  scope_json          jsonb NOT NULL,
  owner_authorization jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending_install'
                      CHECK (status IN ('pending_install', 'active', 'expired', 'revoked')),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  onchain_tx           text,
  install_operation_id text,
  revoke_operation_id  text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_key_account_idx ON session_key (account_id);

-- On-chain operations only the owner key can authorize (Agent Bank cannot sign them).
CREATE TABLE owner_operation (
  id           text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES account (id),
  purpose      text NOT NULL CHECK (purpose IN (
                 'session.install', 'session.revoke', 'topup.configure', 'sweep.configure',
                 'vault.withdraw', 'payment', 'account.deploy', 'owner.swap')),
  subject_id   text NOT NULL,
  status       text NOT NULL DEFAULT 'requires_signature'
               CHECK (status IN ('requires_signature', 'submitted', 'succeeded', 'failed', 'expired')),
  chain_id     integer NOT NULL,
  user_op      jsonb NOT NULL,
  user_op_hash text NOT NULL,
  tx_hash      text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_operation_account_idx ON owner_operation (account_id);

CREATE TABLE mandate (
  id               text PRIMARY KEY,
  agent_id         text NOT NULL REFERENCES agent (id),
  signed_payload   jsonb NOT NULL,
  signer           text NOT NULL,
  signature        text NOT NULL,
  mandate_hash     text NOT NULL,
  constraints_json jsonb NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  spent            bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  occurrences      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mandate_agent_idx ON mandate (agent_id);

CREATE TABLE policy (
  id                  text PRIMARY KEY,
  agent_id            text NOT NULL REFERENCES agent (id),
  version             integer NOT NULL CHECK (version > 0),
  rules_json          jsonb NOT NULL,
  policy_hash         text NOT NULL,
  change_kind         text NOT NULL CHECK (change_kind IN ('initial', 'tighten', 'loosen', 'mixed', 'unchanged')),
  effective_at        timestamptz NOT NULL,
  signed_by           text,
  owner_authorization jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

CREATE TABLE payment_request (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES account (id),
  pay_to             text NOT NULL,
  amount             bigint NOT NULL CHECK (amount > 0),
  asset              text NOT NULL DEFAULT 'USDC',
  memo               text,
  reference          text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'canceled')),
  paid_by_payment_id text,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment (
  id                       text PRIMARY KEY,
  account_id               text NOT NULL REFERENCES account (id),
  org_id                   text NOT NULL REFERENCES org (id),
  agent_id                 text REFERENCES agent (id),
  kind                     text NOT NULL
                           CHECK (kind IN ('transfer', 'x402', 'escrow', 'stream', 'payout', 'refill', 'topup', 'fee', 'vault')),
  counterparty_type        text NOT NULL CHECK (counterparty_type IN ('address', 'agent', 'x402', 'escrow', 'stream')),
  counterparty_address     text NOT NULL,
  counterparty_agent_id    text,
  counterparty_x402_domain text,
  amount                   bigint NOT NULL CHECK (amount > 0),
  fee                      bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
  asset                    text NOT NULL DEFAULT 'USDC',
  status                   text NOT NULL CHECK (status IN (
                             'requires_approval', 'requires_signature', 'submitted', 'settled',
                             'denied', 'failed', 'canceled', 'expired')),
  memo                     text,
  mandate_id               text REFERENCES mandate (id),
  payment_request_id       text REFERENCES payment_request (id),
  decision_id              text,
  approval_id              text,
  owner_operation_id       text,
  escrow_id                text,
  stream_id                text,
  hold_id                  text,
  session_id               text,
  user_op                  jsonb,
  user_op_hash             text,
  tx_hash                  text,
  x402_nonce               text,
  failure_reason           text,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  idempotency_key          text NOT NULL,
  request_hash             text NOT NULL,
  signature_deadline       timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  settled_at               timestamptz,
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX payment_account_idx ON payment (account_id, created_at DESC);
CREATE INDEX payment_open_idx ON payment (status) WHERE status IN ('requires_approval', 'requires_signature', 'submitted');
CREATE INDEX payment_user_op_idx ON payment (user_op_hash) WHERE user_op_hash IS NOT NULL;
CREATE INDEX payment_tx_idx ON payment (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX payment_x402_nonce_uq ON payment (x402_nonce) WHERE x402_nonce IS NOT NULL;

CREATE TABLE policy_decision (
  id                 text PRIMARY KEY,
  payment_id         text,
  agent_id           text NOT NULL,
  policy_id          text,
  policy_version     integer NOT NULL DEFAULT 0,
  outcome            text NOT NULL CHECK (outcome IN ('allow', 'deny', 'require_approval', 'require_owner')),
  rule_hits_json     jsonb NOT NULL,
  approvers_required integer NOT NULL DEFAULT 0,
  source             text NOT NULL CHECK (source IN ('api', 'cosigner', 'dry_run')),
  evaluated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decision_payment_idx ON policy_decision (payment_id);

CREATE TABLE approval (
  id                 text PRIMARY KEY,
  payment_id         text NOT NULL UNIQUE REFERENCES payment (id),
  org_id             text NOT NULL REFERENCES org (id),
  agent_id           text NOT NULL REFERENCES agent (id),
  required_approvers integer NOT NULL CHECK (required_approvers BETWEEN 1 AND 5),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_org_status_idx ON approval (org_id, status);

CREATE TABLE approval_decision (
  approval_id text NOT NULL REFERENCES approval (id),
  member_id   text NOT NULL REFERENCES member (id),
  decision    text NOT NULL CHECK (decision IN ('approve', 'deny')),
  assertion   jsonb,
  signed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, member_id)
);

CREATE TABLE escrow (
  id               text PRIMARY KEY,
  payer_account_id text NOT NULL REFERENCES account (id),
  payee_address    text NOT NULL,
  payee_agent_id   text,
  amount           bigint NOT NULL CHECK (amount > 0),
  fee              bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
  asset            text NOT NULL DEFAULT 'USDC',
  status           text NOT NULL CHECK (status IN (
                     'requires_signature', 'locking', 'locked', 'released', 'refunded',
                     'disputed', 'resolved', 'failed', 'canceled')),
  release_mode     text NOT NULL CHECK (release_mode IN ('payer', 'arbiter', 'validator')),
  arbiter          text,
  validator_json   jsonb,
  terms_hash       text,
  contract_address text NOT NULL,
  onchain_id       text,
  expires_at       timestamptz NOT NULL,
  pending_action   text CHECK (pending_action IN ('lock', 'release', 'refund', 'dispute')),
  payment_id       text REFERENCES payment (id),
  user_op          jsonb,
  user_op_hash     text,
  tx_hash          text,
  memo             text,
  mandate_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escrow_payer_idx ON escrow (payer_account_id);

CREATE TABLE stream (
  id                   text PRIMARY KEY,
  payer_account_id     text NOT NULL REFERENCES account (id),
  payee_address        text NOT NULL,
  payee_agent_id       text,
  kind                 text NOT NULL CHECK (kind IN ('streaming', 'recurring')),
  amount_per_interval  bigint NOT NULL CHECK (amount_per_interval > 0),
  interval_seconds     integer NOT NULL CHECK (interval_seconds > 0),
  deposit              bigint NOT NULL CHECK (deposit > 0),
  settled              bigint NOT NULL DEFAULT 0 CHECK (settled >= 0),
  settle_every_seconds integer NOT NULL DEFAULT 3600,
  start_at             timestamptz NOT NULL,
  stop_at              timestamptz,
  status               text NOT NULL CHECK (status IN ('requires_signature', 'active', 'paused', 'completed', 'canceled', 'failed')),
  contract_address     text NOT NULL,
  onchain_id           text,
  pending_action       text CHECK (pending_action IN ('create', 'cancel', 'top_up')),
  payment_id           text REFERENCES payment (id),
  user_op              jsonb,
  user_op_hash         text,
  tx_hash              text,
  last_settled_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (settled <= deposit)
);

CREATE TABLE vault (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES account (id),
  kind             text NOT NULL CHECK (kind IN ('goal', 'locked')),
  name             text NOT NULL,
  target           bigint CHECK (target IS NULL OR target > 0),
  unlock_at        timestamptz,
  contract_address     text,
  onchain_id           text,
  pending_operation_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'goal' OR unlock_at IS NOT NULL)
);

CREATE TABLE auto_topup_rule (
  id                  text PRIMARY KEY,
  agent_id            text NOT NULL UNIQUE REFERENCES agent (id),
  treasury_account_id text NOT NULL REFERENCES account (id),
  refill_to           bigint NOT NULL CHECK (refill_to > 0),
  when_below          bigint NOT NULL CHECK (when_below >= 0),
  max_per_day          bigint NOT NULL CHECK (max_per_day > 0),
  status               text NOT NULL DEFAULT 'pending_install' CHECK (status IN ('pending_install', 'active', 'disabled')),
  install_operation_id text,
  owner_authorization  jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (when_below < refill_to)
);

CREATE TABLE fund (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  issuer           text NOT NULL,
  token_address    text NOT NULL,
  chain_id         integer NOT NULL,
  settlement       text NOT NULL CHECK (settlement IN ('same_day', 'next_day')),
  eligibility_json jsonb NOT NULL,
  disclosure       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sweep_rule (
  id                  text PRIMARY KEY,
  account_id          text NOT NULL UNIQUE REFERENCES account (id),
  fund_id             text NOT NULL REFERENCES fund (id),
  floor               bigint NOT NULL CHECK (floor >= 0),
  threshold           bigint NOT NULL CHECK (threshold >= 0),
  max_share_bps        integer NOT NULL CHECK (max_share_bps BETWEEN 0 AND 10000),
  status               text NOT NULL DEFAULT 'pending_install' CHECK (status IN ('pending_install', 'active', 'disabled')),
  install_operation_id text,
  signed_by           text NOT NULL,
  owner_authorization jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fund_position (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES account (id),
  fund_id    text NOT NULL REFERENCES fund (id),
  shares     numeric(78, 0) NOT NULL DEFAULT 0,  -- fund shares may use 18 decimals
  last_price numeric(78, 0),                     -- USDC minor units per 1e18 shares
  priced_at  timestamptz,
  UNIQUE (account_id, fund_id)
);

CREATE TABLE plan (
  code          text PRIMARY KEY CHECK (code IN ('free', 'pro', 'business', 'enterprise')),
  name          text NOT NULL,
  monthly_price bigint NOT NULL CHECK (monthly_price >= 0),
  max_agents    integer,
  features      text[] NOT NULL
);

INSERT INTO plan (code, name, monthly_price, max_agents, features) VALUES
  ('free', 'Free', 0, 3, ARRAY['sandbox', 'policies', 'x402', 'escrow']),
  ('pro', 'Pro', 99000000, 25, ARRAY['approvals', 'vaults', 'auto_save', 'webhooks', 'statements']),
  ('business', 'Business', 499000000, NULL, ARRAY['multi_approver', 'treasury_sweep', 'audit_exports']),
  ('enterprise', 'Enterprise', 4000000000, NULL, ARRAY['sso', 'custom_policy', 'sla', 'dedicated_cosigner_region']);

CREATE TABLE subscription (
  org_id               text PRIMARY KEY REFERENCES org (id),
  plan_code            text NOT NULL REFERENCES plan (code),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fee_charge (
  id              text PRIMARY KEY,
  account_id      text NOT NULL REFERENCES account (id),
  org_id          text NOT NULL REFERENCES org (id),
  kind            text NOT NULL CHECK (kind IN (
                    'outbound_payment', 'x402_receive', 'escrow', 'stream',
                    'treasury_sweep', 'subscription', 'gas')),
  source_ref      text NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  ledger_entry_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, source_ref)
);
CREATE INDEX fee_charge_org_idx ON fee_charge (org_id, created_at);

CREATE TABLE x402_payee (
  account_id text PRIMARY KEY REFERENCES account (id),
  domains    text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoint (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES org (id),
  url        text NOT NULL,
  events     text[] NOT NULL,
  secret     text NOT NULL,   -- envelope-encrypted with KMS in production deployments
  status     text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES org (id),
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_org_idx ON event (org_id, created_at DESC);

CREATE TABLE webhook_delivery (
  id               text PRIMARY KEY,
  endpoint_id      text NOT NULL REFERENCES webhook_endpoint (id),
  event_id         text NOT NULL REFERENCES event (id),
  attempt          integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (next_attempt_at) WHERE status = 'pending';

-- API-level idempotency: same key + same request returns the stored response.
CREATE TABLE idempotency_record (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- RFC 9421 signature nonces (replay protection), pruned after expiry.
CREATE TABLE request_nonce (
  key_id     text NOT NULL,
  nonce      text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce)
);

-- Hash-chained audit log of policy decisions, approvals, co-signatures and admin actions.
CREATE TABLE audit_log (
  seq       bigint PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL,
  action    text NOT NULL,
  subject   text NOT NULL,
  payload   jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash      text NOT NULL UNIQUE
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION agentbank_forbid_mutation();
