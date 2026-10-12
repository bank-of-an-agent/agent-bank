-- 0001_indexer: the indexer's own database (never the API's).
--
-- indexer_cursor         last block whose events the reconciler accepted, per chain
-- indexer_block          recent canonical block headers, to detect reorgs from parent hashes
-- indexer_deferred       events the reconciler deferred (window or finality), resent as the
--                        chain advances
-- indexer_pending_reorg  orphaned blocks not yet reported: the replacement blocks are pushed
--                        first (so re-included transactions are rebound), then the reorg
-- indexer_balance_check  nightly (and on-demand) on-chain balance assertions
-- indexer_state          small key/value state (watchlist version, last balance check day)

CREATE TABLE indexer_cursor (
  chain_id     integer PRIMARY KEY CHECK (chain_id NOT IN (1, 8453, 10, 42161, 137)), -- mainnet locked
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash   text NOT NULL,
  updated_at   timestamptz NOT NULL
);

CREATE TABLE indexer_block (
  chain_id     integer NOT NULL,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash   text NOT NULL,
  parent_hash  text NOT NULL,
  timestamp    bigint NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE indexer_deferred (
  event_id            text PRIMARY KEY,
  chain_id            integer NOT NULL,
  block_number        bigint NOT NULL,
  block_hash          text NOT NULL,
  tx_hash             text NOT NULL,
  log_index           integer NOT NULL,
  event               jsonb NOT NULL,          -- the ChainEventInternal last sent
  attempts            integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  last_sent_head      bigint NOT NULL,
  last_sent_finalized bigint NOT NULL,
  first_deferred_at   timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
CREATE INDEX indexer_deferred_order_idx ON indexer_deferred (chain_id, block_number, log_index);
CREATE INDEX indexer_deferred_block_idx ON indexer_deferred (chain_id, block_hash);

CREATE TABLE indexer_pending_reorg (
  chain_id     integer NOT NULL,
  block_hash   text NOT NULL,
  block_number bigint NOT NULL,
  detected_at  timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_hash)
);

CREATE TABLE indexer_balance_check (
  id           text PRIMARY KEY,
  chain_id     integer NOT NULL,
  block_number bigint NOT NULL,
  checked      integer NOT NULL CHECK (checked >= 0),
  mismatches   jsonb NOT NULL,
  reported     boolean NOT NULL,
  run_id       text,
  created_at   timestamptz NOT NULL
);
CREATE INDEX indexer_balance_check_time_idx ON indexer_balance_check (chain_id, created_at DESC);

CREATE TABLE indexer_state (
  chain_id   integer NOT NULL,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id, key)
);
