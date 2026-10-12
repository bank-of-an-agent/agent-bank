-- 0006_proofs: private proofs (docs/private-proofs.md, ADR 0014). Per-agent disclosure settings,
-- enrolled identity commitments, proof-of-funds reservations (ledger holds bound to one
-- verifier's scope tag), the attested-facts roots the attester key publishes to
-- AgentAttestationRegistry with their leaves (kept per epoch so witnesses can be served for every
-- valid root), the roots job's per-chain dirty flags, and the escrow resolution split the
-- reconciler records from `Resolved` (for the `disputes_lost` attribute).
--
-- Conventions as in 0002_core: prefixed text ids, bigint minor units, timestamptz, CHECK enums;
-- every chain_id refuses mainnet ids. Attribute values are u64 and stored as base-10 strings in
-- jsonb so they stay exact; roots, leaves and commitments are lowercase 32-byte hex.

-- What an agent may prove. Disclosure is the owner's decision: widening needs the owner's
-- `proofs.disclose` authorization, narrowing only an API key (and revokes older roots).
CREATE TABLE proof_settings (
  agent_id        text PRIMARY KEY REFERENCES agent (id),
  org_id          text NOT NULL REFERENCES org (id),
  enabled         boolean NOT NULL DEFAULT false,
  disclose        text[] NOT NULL DEFAULT '{}'
                  CHECK (disclose <@ ARRAY['principal', 'limits', 'balance', 'reservations', 'account_age', 'reputation']::text[]),
  disclosure_mask integer NOT NULL DEFAULT 0 CHECK (disclosure_mask BETWEEN 0 AND 8191),
  updated_at      timestamptz NOT NULL,
  updated_by      text NOT NULL
);
CREATE INDEX proof_settings_org_idx ON proof_settings (org_id);

-- The agent's identity commitment Poseidon(secret). The secret never reaches Agent Bank.
CREATE TABLE proof_identity (
  account_id          text PRIMARY KEY REFERENCES account (id),
  agent_id            text NOT NULL REFERENCES agent (id),
  org_id              text NOT NULL REFERENCES org (id),
  identity_commitment text NOT NULL CHECK (identity_commitment ~ '^0x[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

-- Proof-of-funds reservations: an `operating → reserved` hold (ref_type `proof_reservation`)
-- that becomes a leaf with reserved_amount / reserved_until / reserved_for = scope_tag.
-- `hold_id` has no foreign key: the in-memory ledger used in tests keeps holds outside SQL.
CREATE TABLE proof_reservation (
  id                text PRIMARY KEY,                                 -- prv_…
  account_id        text NOT NULL REFERENCES account (id),
  agent_id          text NOT NULL REFERENCES agent (id),
  org_id            text NOT NULL REFERENCES org (id),
  chain_id          integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  hold_id           text NOT NULL,
  amount            bigint NOT NULL CHECK (amount > 0),
  scope_tag         numeric(20, 0) NOT NULL CHECK (scope_tag >= 0 AND scope_tag <= 18446744073709551615),
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'released', 'expired')),
  included_in_epoch bigint CHECK (included_in_epoch > 0),
  created_at        timestamptz NOT NULL,
  released_at       timestamptz
);
CREATE INDEX proof_reservation_account_idx ON proof_reservation (account_id, created_at DESC);
CREATE INDEX proof_reservation_org_idx ON proof_reservation (org_id, created_at DESC);
CREATE INDEX proof_reservation_open_idx ON proof_reservation (expires_at) WHERE status IN ('pending', 'active');

-- Attested-facts roots: publishing → published → (revoked | expired), or failed. `narrowing`
-- marks a build triggered by a narrowing change: once it lands, every other valid root is revoked.
CREATE TABLE proof_root (
  chain_id       integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  root           text NOT NULL CHECK (root ~ '^0x[0-9a-f]{64}$'),
  epoch          bigint NOT NULL CHECK (epoch > 0),
  snapshot_at    timestamptz NOT NULL,
  valid_until    timestamptz NOT NULL,
  leaf_count     integer NOT NULL CHECK (leaf_count > 0),
  status         text NOT NULL CHECK (status IN ('publishing', 'published', 'revoked', 'expired', 'failed')),
  tx_hash        text,
  published_at   timestamptz,
  revoked_at     timestamptz,
  revoke_tx_hash text,
  narrowing      boolean NOT NULL DEFAULT false,
  failure_reason text,
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (chain_id, epoch),
  UNIQUE (chain_id, root),
  CHECK (valid_until > snapshot_at)
);
CREATE INDEX proof_root_status_idx ON proof_root (chain_id, status, epoch DESC);

-- One row per leaf and epoch, in tree order (account id, then reservation id; the base leaf
-- has no reservation). Pruned a day after the root's validity window.
CREATE TABLE proof_leaf (
  chain_id        integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  epoch           bigint NOT NULL,
  leaf_index      integer NOT NULL CHECK (leaf_index >= 0),
  account_id      text NOT NULL REFERENCES account (id),
  reservation_id  text REFERENCES proof_reservation (id),
  leaf            text NOT NULL CHECK (leaf ~ '^0x[0-9a-f]{64}$'),
  attributes      jsonb NOT NULL,
  disclosure_mask integer NOT NULL CHECK (disclosure_mask BETWEEN 0 AND 8191),
  PRIMARY KEY (chain_id, epoch, leaf_index),
  FOREIGN KEY (chain_id, epoch) REFERENCES proof_root (chain_id, epoch) ON DELETE CASCADE
);
CREATE INDEX proof_leaf_member_idx ON proof_leaf (chain_id, epoch, account_id, reservation_id);
CREATE INDEX proof_leaf_account_idx ON proof_leaf (account_id, chain_id, epoch DESC);

-- The roots job's work queue, one row per chain. A change marks the tree dirty (with
-- `narrowing` for changes that must revoke older roots) and bumps `version`; the job clears the
-- flags only when `version` is unchanged since its snapshot. `min_epoch` is the registry's
-- latest epoch when it is ahead of this database (an epoch below it would revert).
CREATE TABLE proof_tree_state (
  chain_id    integer PRIMARY KEY CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  dirty       boolean NOT NULL DEFAULT false,
  narrowing   boolean NOT NULL DEFAULT false,
  dirty_since timestamptz,
  version     bigint NOT NULL DEFAULT 0,
  min_epoch   bigint NOT NULL DEFAULT 0 CHECK (min_epoch >= 0),
  updated_at  timestamptz NOT NULL
);

-- Escrow resolutions (`Resolved(id, payeeAmount, payerAmount)`), recorded by the reconciler.
ALTER TABLE escrow ADD COLUMN resolution_payee_amount bigint CHECK (resolution_payee_amount >= 0);
ALTER TABLE escrow ADD COLUMN resolution_payer_amount bigint CHECK (resolution_payer_amount >= 0);
CREATE INDEX escrow_payee_address_idx ON escrow (lower(payee_address));
