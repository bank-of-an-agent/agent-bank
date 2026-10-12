-- 0004_x402: the x402 facilitator's authorization log (owned by apps/facilitator).
--
-- One row per EIP-3009 authorization the facilitator has accepted for settlement. The row is
-- inserted with status 'settling' BEFORE `transferWithAuthorization` is submitted, and
-- UNIQUE (chain_id, asset, authorizer, nonce) makes every authorization single-use across
-- concurrent requests and facilitator replicas: a second settle of the same authorization
-- cannot insert its row and never reaches the chain. Failed verifications write nothing.
--
-- Lifecycle: settling -> settled  (receipt succeeded: tx_hash, block_number, settled_at set)
--            settling -> failed   (dry-run or on-chain revert, or never mined before expiry)
-- A row stays 'settling' while the outcome is unknown (submitted, receipt not seen yet).
-- 'failed' is terminal: the payer signs a new authorization (single-use, design § Security).
--
-- The reconciler matches USDC AuthorizationUsed(authorizer, nonce) and the Transfer in the
-- same transaction to a row by (chain_id, asset, authorizer, nonce) or by tx_hash. Rows with a
-- payee_account_id belong to an Agent Bank seller (registered x402 payee): the 0.5% receive
-- fee accrues to that account when the settlement is seen on-chain.
--
-- Conventions as in 0002_core: prefixed text ids (x4p_), bigint minor units, checksummed
-- addresses (the facilitator always writes getAddress() forms, so the UNIQUE key is
-- canonical), lowercase hex nonces and hashes, timestamptz.

CREATE TABLE x402_authorization (
  id               text PRIMARY KEY,
  chain_id         integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  scheme           text NOT NULL DEFAULT 'exact' CHECK (scheme = 'exact'),
  asset            text NOT NULL CHECK (asset ~ '^0x[0-9a-fA-F]{40}$'),
  authorizer       text NOT NULL CHECK (authorizer ~ '^0x[0-9a-fA-F]{40}$'), -- EIP-3009 `from` (payer)
  nonce            text NOT NULL CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  pay_to           text NOT NULL CHECK (pay_to ~ '^0x[0-9a-fA-F]{40}$'),     -- EIP-3009 `to` = payTo
  amount           bigint NOT NULL CHECK (amount > 0),                         -- minor units
  valid_after      bigint NOT NULL CHECK (valid_after >= 0),                   -- unix seconds
  valid_before     bigint NOT NULL CHECK (valid_before > valid_after),         -- unix seconds
  payee_account_id text REFERENCES account (id),
  resource_url     text,
  -- Fingerprint of the authorization, signature and requirements: an identical settle
  -- request is answered from this row (idempotent); a different one is refused.
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'settling' CHECK (status IN ('settling', 'settled', 'failed')),
  relayer          text,
  tx_hash          text CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number     bigint,
  failure_reason   text,
  failure_detail   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  settled_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, asset, authorizer, nonce),
  CHECK (status <> 'settled' OR (tx_hash IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);

CREATE INDEX x402_authorization_payee_idx ON x402_authorization (payee_account_id, created_at DESC)
  WHERE payee_account_id IS NOT NULL;
CREATE INDEX x402_authorization_pay_to_idx ON x402_authorization (chain_id, pay_to, created_at DESC);
CREATE INDEX x402_authorization_tx_idx ON x402_authorization (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX x402_authorization_open_idx ON x402_authorization (created_at) WHERE status = 'settling';
