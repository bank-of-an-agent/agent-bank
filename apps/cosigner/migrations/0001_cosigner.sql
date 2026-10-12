-- 0001_cosigner: the co-signer's own database, separate from the API's.
--
-- The co-signer is the enforcement authority for policies, sessions, mandates
-- and freezes, and keeps its own spend history, so a compromised API cannot
-- talk it into signing anything its own policy would refuse.
--
-- Conventions: money is bigint minor units (USDC: 6 decimals), never numeric
-- or float; addresses are stored lowercase; every timestamp is timestamptz and
-- comes from the service clock (never now()), so delays are testable.

CREATE OR REPLACE FUNCTION cosigner_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------------------------------------------------------------- bindings
-- Trust on first use: the first registration of an org pins its owner key,
-- and agents and accounts are pinned to their org and agent. Later requests
-- that disagree are refused, so a compromised API cannot swap in its own
-- "owner" to authorize loosening changes.

CREATE TABLE org_binding (
  org_id        text PRIMARY KEY,
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  created_at    timestamptz NOT NULL
);

CREATE TABLE agent_binding (
  agent_id   text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES org_binding (org_id),
  created_at timestamptz NOT NULL
);
CREATE INDEX agent_binding_org_idx ON agent_binding (org_id);

CREATE TABLE account_binding (
  account_id text PRIMARY KEY,
  agent_id   text NOT NULL REFERENCES agent_binding (agent_id),
  chain_id   integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  address    text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (chain_id, address)
);
CREATE INDEX account_binding_agent_idx ON account_binding (agent_id);

-- The org treasury (owner-authorized `treasury.set`): the only address a
-- savings sweep may go to. Account id and address are pinned together.
CREATE TABLE treasury (
  org_id     text PRIMARY KEY REFERENCES org_binding (org_id),
  account_id text NOT NULL UNIQUE,
  address    text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  signed_by  text NOT NULL,
  set_at     timestamptz NOT NULL
);

-- The x402 spend key of an account (ADR 0001), registered with the owner's
-- `spend_key.set` authorization; x402 payments must name it and refills may
-- only go to it. A key serves one account and is never changed in place.
CREATE TABLE spend_key_binding (
  account_id text PRIMARY KEY,
  address    text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  signed_by  text NOT NULL,
  created_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------- authority

CREATE TABLE session (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES org_binding (org_id),
  agent_id            text NOT NULL REFERENCES agent_binding (agent_id),
  account_id          text NOT NULL REFERENCES account_binding (account_id),
  chain_id            integer NOT NULL,
  account_address     text NOT NULL CHECK (account_address ~ '^0x[0-9a-f]{40}$'),
  public_key          text NOT NULL CHECK (public_key ~ '^0x[0-9a-f]{40}$'),
  scope               jsonb NOT NULL,
  owner_authorization jsonb NOT NULL,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL
);
CREATE INDEX session_agent_idx ON session (agent_id);

CREATE TABLE mandate (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES org_binding (org_id),
  agent_id            text NOT NULL REFERENCES agent_binding (agent_id),
  chain_id            integer NOT NULL,
  document            jsonb NOT NULL,
  mandate_hash        text NOT NULL,
  signer              text NOT NULL,
  owner_authorization jsonb NOT NULL,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  -- Usage so far (reserved + settled spend under the mandate), maintained in
  -- the same transaction as the spend records it summarizes.
  spent               bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  occurrences         integer NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  last_occurrence_at  timestamptz,
  created_at          timestamptz NOT NULL
);
CREATE INDEX mandate_agent_idx ON mandate (agent_id);

-- Revocations of sessions or mandates the co-signer has not (yet) seen, so a
-- late registration cannot resurrect them.
CREATE TABLE revocation (
  kind       text NOT NULL CHECK (kind IN ('session', 'mandate')),
  id         text NOT NULL,
  revoked_at timestamptz NOT NULL,
  PRIMARY KEY (kind, id)
);

-- Versioned policies. The version in force at time t is the highest
-- non-cancelled version with effective_at <= t. Writing any new version
-- cancels a version that is still pending (a delayed loosening), so a pending
-- loosening can never override a newer change.
CREATE TABLE policy_version (
  agent_id            text NOT NULL REFERENCES agent_binding (agent_id),
  version             integer NOT NULL CHECK (version > 0),
  document            jsonb NOT NULL,
  policy_hash         text NOT NULL,
  change_kind         text NOT NULL CHECK (change_kind IN ('initial', 'tighten', 'loosen', 'mixed', 'unchanged')),
  effective_at        timestamptz NOT NULL,
  signed_by           text,
  owner_authorization jsonb,
  cancelled_at        timestamptz,
  cancelled_by        integer,
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (agent_id, version),
  CHECK (effective_at >= created_at),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);

-- Owner authorizations are single-use, keyed by their EIP-712 digest (not
-- the signature bytes, which are malleable).
CREATE TABLE owner_authorization_use (
  digest       text PRIMARY KEY,
  action       text NOT NULL,
  subject      text NOT NULL,
  payload_hash text NOT NULL,
  signer       text NOT NULL,
  ref          text NOT NULL,
  used_at      timestamptz NOT NULL
);

-- One row per freeze episode. A target is frozen at t while an episode has
-- frozen_at <= t and no unfreeze effective at or before t. Freezing again
-- while an unfreeze is pending cancels the pending unfreeze.
CREATE TABLE freeze_episode (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope                 text NOT NULL CHECK (scope IN ('org', 'agent', 'session')),
  target_id             text NOT NULL,
  reason                text NOT NULL,
  frozen_at             timestamptz NOT NULL,
  unfreeze_requested_at timestamptz,
  unfreeze_effective_at timestamptz,
  unfreeze_reason       text,
  unfreeze_signed_by    text,
  CHECK ((unfreeze_requested_at IS NULL) = (unfreeze_effective_at IS NULL))
);
CREATE INDEX freeze_episode_target_idx ON freeze_episode (scope, target_id, frozen_at);
-- At most one episode per target without an unfreeze request.
CREATE UNIQUE INDEX freeze_episode_open_uq ON freeze_episode (scope, target_id)
  WHERE unfreeze_requested_at IS NULL;

-- ---------------------------------------------------------------- spend history

-- One row per co-signed operation or x402 authorization. `amount` is the
-- payment counted against policy caps (0 for actions that move nothing out,
-- e.g. an escrow release); `outflow` is everything the operation moves out
-- of the account (payment, fees, fee and savings sweeps), as the on-chain
-- hook counts it.
CREATE TABLE spend (
  payment_id               text PRIMARY KEY,
  source                   text NOT NULL CHECK (source IN ('cosign', 'x402')),
  action                   text NOT NULL,
  org_id                   text NOT NULL,
  agent_id                 text NOT NULL,
  account_id               text NOT NULL,
  session_id               text,
  mandate_id               text,
  kind                     text NOT NULL,
  counterparty_address     text,
  counterparty_agent_id    text,
  counterparty_erc8004_id  text,
  counterparty_x402_domain text,
  amount                   bigint NOT NULL CHECK (amount >= 0),
  fee                      bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
  savings                  bigint NOT NULL DEFAULT 0 CHECK (savings >= 0),
  outflow                  bigint NOT NULL,
  status                   text NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  settled_amount           bigint CHECK (settled_amount IS NULL OR (settled_amount >= 0 AND settled_amount <= amount)),
  request_hash             text NOT NULL,
  user_op_hash             text,
  signature                text,
  decision_id              text NOT NULL,
  reserved_at              timestamptz NOT NULL,
  settled_at               timestamptz,
  released_at              timestamptz,
  CHECK (outflow >= amount)
);
CREATE INDEX spend_agent_time_idx ON spend (agent_id, reserved_at);
CREATE INDEX spend_session_time_idx ON spend (session_id, reserved_at) WHERE session_id IS NOT NULL;
CREATE INDEX spend_mandate_idx ON spend (mandate_id) WHERE mandate_id IS NOT NULL;

CREATE TABLE counterparty_seen (
  agent_id      text NOT NULL,
  id_type       text NOT NULL CHECK (id_type IN ('address', 'agent_id', 'erc8004_id', 'x402_domain')),
  value         text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, id_type, value)
);

CREATE TABLE decision (
  id                 text PRIMARY KEY,
  source             text NOT NULL CHECK (source IN ('evaluate', 'cosign', 'x402')),
  payment_id         text,
  org_id             text NOT NULL,
  agent_id           text NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('allow', 'deny', 'require_approval', 'require_owner')),
  rule_hits          jsonb NOT NULL,
  approvers_required integer NOT NULL CHECK (approvers_required >= 0),
  policy_version     integer NOT NULL CHECK (policy_version >= 0),
  evaluated_at       timestamptz NOT NULL,
  retry_at           timestamptz
);
CREATE INDEX decision_payment_idx ON decision (payment_id) WHERE payment_id IS NOT NULL;
CREATE TRIGGER decision_append_only BEFORE UPDATE OR DELETE ON decision
  FOR EACH ROW EXECUTE FUNCTION cosigner_forbid_mutation();

-- ---------------------------------------------------------------- audit
-- Hash-chained, append-only: every decision, co-signature, refusal, policy
-- change, freeze/unfreeze and session/mandate change. `payload` holds the
-- exact canonical JSON that was hashed.

CREATE TABLE audit_log (
  seq       bigint PRIMARY KEY CHECK (seq > 0),
  at        timestamptz NOT NULL,
  actor     text NOT NULL,
  action    text NOT NULL,
  subject   text NOT NULL,
  payload   text NOT NULL,
  prev_hash text NOT NULL,
  hash      text NOT NULL UNIQUE
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION cosigner_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION cosigner_forbid_mutation();

-- Head of the chain; appending locks this row, which serializes appends.
CREATE TABLE audit_head (
  id   smallint PRIMARY KEY CHECK (id = 1),
  seq  bigint NOT NULL,
  hash text NOT NULL
);
INSERT INTO audit_head (id, seq, hash)
VALUES (1, 0, '0x0000000000000000000000000000000000000000000000000000000000000000');
