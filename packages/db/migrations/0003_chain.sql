-- 0003_chain: chain evidence and reconciliation (owned by packages/reconciliation).
--
-- chain_tx            one row per (block, transaction) the indexer pushed: the unit the reconciler
--                     processes atomically, the ledger entries it posted for it, and the row changes
--                     (payment settled, escrow locked, …) to undo if the block is orphaned
-- chain_event         every normalized log the indexer pushed (id = chainId:blockHash:txHash:logIndex),
--                     its outcome and the one ledger entry it is the evidence of
-- reconciliation_run  the nightly (and on-demand) on-chain balance assertions the indexer reports
--
-- Guarantees enforced here, independently of the library:
--   * each chain event matches at most one ledger entry and each entry at most one event
--     (chain_event.matched_entry_id UNIQUE);
--   * evidence is never deleted: events of orphaned blocks become 'reorged' and their entries are
--     reversed, or rebound to the re-included copy of the same transaction (superseded_by);
--   * mainnet chain ids are refused.
--
-- Conventions as in 0002_core: hashes are lowercase 0x-hex, addresses checksummed, money bigint
-- minor units, timestamps timestamptz.

CREATE TABLE chain_tx (
  id                 text PRIMARY KEY,                       -- `${chain_id}:${block_hash}:${tx_hash}`
  chain_id           integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  block_number       bigint NOT NULL CHECK (block_number >= 0),
  block_hash         text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp    timestamptz NOT NULL,
  tx_hash            text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  first_log_index    integer NOT NULL CHECK (first_log_index >= 0),
  -- sha256 of the transaction's value-relevant logs: equal fingerprints mean a re-included
  -- transaction did exactly the same thing, so its postings are rebound instead of redone.
  fingerprint        text NOT NULL,
  status             text NOT NULL CHECK (status IN ('processed', 'deferred', 'reorged')),
  outcome            text CHECK (outcome IN ('matched', 'deposit', 'suspense', 'ignored', 'mixed')),
  deferred_reason    text CHECK (deferred_reason IN ('window', 'finality', 'error')),
  -- Incremented when the same block is processed again after its reorg reversal completed,
  -- so ledger idempotency keys of the new postings never collide with the reversed ones.
  generation         integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  entry_ids          text[] NOT NULL DEFAULT '{}',           -- ledger entries posted, in order
  effects            jsonb NOT NULL DEFAULT '[]',            -- row changes to undo on reorg, in order
  -- 'pending': orphaned, but reversing now would overdraw a pocket (funds held for a later
  -- payment); retried until it succeeds or the transaction is re-included and rebound.
  reversal           text NOT NULL DEFAULT 'none' CHECK (reversal IN ('none', 'pending', 'done', 'rebound')),
  reversal_entry_ids text[] NOT NULL DEFAULT '{}',
  superseded_by      text REFERENCES chain_tx (id),
  alerted_at         timestamptz,                            -- unexplained outflow alert raised
  detail             jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  processed_at       timestamptz,
  reorged_at         timestamptz,
  CONSTRAINT chain_tx_deferred_reason CHECK ((status = 'deferred') = (deferred_reason IS NOT NULL)),
  CONSTRAINT chain_tx_reversal CHECK ((status = 'reorged') = (reversal <> 'none')),
  CONSTRAINT chain_tx_superseded CHECK (superseded_by IS NULL OR reversal = 'rebound'),
  CONSTRAINT chain_tx_detail_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT chain_tx_effects_array CHECK (jsonb_typeof(effects) = 'array')
);
CREATE INDEX chain_tx_tx_hash_idx ON chain_tx (chain_id, tx_hash);
CREATE INDEX chain_tx_block_hash_idx ON chain_tx (chain_id, block_hash);
CREATE INDEX chain_tx_block_idx ON chain_tx (chain_id, block_number DESC, first_log_index DESC);
CREATE INDEX chain_tx_pending_reversal_idx ON chain_tx (chain_id, block_number DESC) WHERE reversal = 'pending';
CREATE INDEX chain_tx_deferred_idx ON chain_tx (chain_id, block_number) WHERE status = 'deferred';

CREATE TABLE chain_event (
  id               text PRIMARY KEY,                         -- `${chain_id}:${block_hash}:${tx_hash}:${log_index}`
  chain_tx_id      text NOT NULL REFERENCES chain_tx (id),
  chain_id         integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)),
  block_number     bigint NOT NULL CHECK (block_number >= 0),
  block_hash       text NOT NULL,
  block_timestamp  timestamptz NOT NULL,
  tx_hash          text NOT NULL,
  log_index        integer NOT NULL CHECK (log_index >= 0),
  contract         text NOT NULL,
  event_name       text NOT NULL,
  args             jsonb NOT NULL,
  user_op_hash     text,
  finality         text NOT NULL CHECK (finality IN ('latest', 'safe', 'finalized')),
  status           text NOT NULL CHECK (status IN ('processed', 'deferred', 'reorged', 'suspense')),
  -- What the reconciler did with it (the IngestResult status): matched an expected movement,
  -- posted a deposit, posted to suspense, is waiting (window or finality), or nothing to do.
  result           text NOT NULL CHECK (result IN ('matched', 'deposit', 'suspense', 'deferred', 'ignored')),
  ref              text,                                     -- pay_/esc_/str_/vlt_/acct_ id it settled
  entry_id         text,                                     -- the entry accounting for it (may be shared)
  matched_entry_id text,                                     -- the one entry it is the evidence of
  detail           jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT chain_event_matched_entry_id_key UNIQUE (matched_entry_id),
  CONSTRAINT chain_event_matched_is_entry CHECK (matched_entry_id IS NULL OR matched_entry_id = entry_id),
  CONSTRAINT chain_event_args_object CHECK (jsonb_typeof(args) = 'object'),
  CONSTRAINT chain_event_detail_object CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX chain_event_tx_idx ON chain_event (chain_tx_id, log_index);
CREATE INDEX chain_event_tx_hash_idx ON chain_event (chain_id, tx_hash);
CREATE INDEX chain_event_block_hash_idx ON chain_event (chain_id, block_hash);
CREATE INDEX chain_event_user_op_idx ON chain_event (user_op_hash) WHERE user_op_hash IS NOT NULL;
CREATE INDEX chain_event_entry_idx ON chain_event (entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX chain_event_open_idx ON chain_event (chain_id, block_number) WHERE status IN ('deferred', 'suspense');

CREATE TABLE reconciliation_run (
  id               text PRIMARY KEY,
  chain_id         integer NOT NULL CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)),
  block_number     bigint NOT NULL CHECK (block_number >= 0),
  checked          integer NOT NULL CHECK (checked >= 0),
  mismatch_count   integer NOT NULL CHECK (mismatch_count >= 0),
  mismatches       jsonb NOT NULL DEFAULT '[]',              -- [{ address, onchain, expected, account_id }]
  status           text NOT NULL CHECK (status IN ('ok', 'mismatch')),
  suspense_balance bigint NOT NULL DEFAULT 0,                -- sys:suspense when the run was recorded
  frozen_agents    text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL,
  CONSTRAINT reconciliation_run_status CHECK ((status = 'ok') = (mismatch_count = 0)),
  CONSTRAINT reconciliation_run_mismatches_array CHECK (jsonb_typeof(mismatches) = 'array')
);
CREATE INDEX reconciliation_run_time_idx ON reconciliation_run (chain_id, created_at DESC);
