-- 0001_ledger: the double-entry ledger behind packages/ledger.
--
-- ledger_account  pockets of a bank account (owner_ref = acct_…) and system accounts
--                 (owner_ref = 'system'), each with a funds location and a cached balance
-- journal_entry   one immutable, balanced movement and the reason it happened
-- journal_line    the signed amounts of an entry (positive increases the account's balance)
-- hold            two-phase reservations: pending, then posted, voided or expired
--
-- Money is bigint minor units; ids are prefixed ULIDs stored with COLLATE "C" so keyset
-- pagination orders them bytewise on every server, whatever its default collation.
--
-- Guarantees enforced here, independently of the library:
--   * journal_entry and journal_line are append-only: UPDATE, DELETE and TRUNCATE fail;
--   * at commit, every entry's lines sum to zero per asset and an entry has exactly the
--     number of lines it was written with, so lines can never be added to an old entry;
--   * ledger_account.balance starts at zero and changes only through journal_line inserts,
--     so the cache cannot drift from the journal through ordinary writes;
--   * pockets (owner_ref <> 'system') can never allow or reach a negative balance;
--   * a hold is created pending, moves to posted/voided/expired only together with a
--     matching resolution entry, and returns to pending only when that entry is reversed;
--   * account codes, owners, locations and chain ids are well formed; mainnets are refused.

CREATE OR REPLACE FUNCTION agentbank_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ------------------------------------------------------------------ ledger accounts

CREATE TABLE ledger_account (
  id             text COLLATE "C" PRIMARY KEY,
  owner_ref      text COLLATE "C" NOT NULL,          -- acct_… or 'system'
  code           text COLLATE "C" NOT NULL,          -- pocket:<name> | pocket:vault:<vlt_id> | sys:…
  asset          text COLLATE "C" NOT NULL,
  chain_id       integer,
  location       text NOT NULL,                      -- where the funds sit, for reconciliation
  allow_negative boolean NOT NULL DEFAULT false,
  balance        bigint NOT NULL DEFAULT 0,          -- projection of sum(journal_line.amount)
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_account_owner_code_asset_key UNIQUE (owner_ref, code, asset),
  CONSTRAINT ledger_account_line_target_key UNIQUE (id, owner_ref, asset),
  CONSTRAINT ledger_account_id_format CHECK (id ~ '^lac_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT ledger_account_owner_format
    CHECK (owner_ref = 'system' OR owner_ref ~ '^acct_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT ledger_account_asset_format CHECK (asset ~ '^[A-Z0-9]{2,16}$'),
  CONSTRAINT ledger_account_code_format CHECK (code ~ (
    '^(pocket:(operating|reserved|fees|savings|escrow|stream|spend|spend_reserved'
    || '|vault:vlt_[0-9A-HJKMNP-TV-Z]{26})'
    || '|sys:(revenue|suspense|chain:[1-9][0-9]{0,14}:[A-Z0-9]{2,16}))$')),
  CONSTRAINT ledger_account_owner_kind CHECK ((owner_ref = 'system') = (code LIKE 'sys:%')),
  CONSTRAINT ledger_account_chain CHECK (CASE
    WHEN code LIKE 'sys:chain:%' THEN chain_id IS NOT NULL AND code = 'sys:chain:' || chain_id::text || ':' || asset
    WHEN code LIKE 'sys:%' THEN chain_id IS NULL
    ELSE true END),
  CONSTRAINT ledger_account_testnet_only CHECK (chain_id IS NULL OR chain_id NOT IN (1, 8453, 10, 42161, 137)),
  CONSTRAINT ledger_account_location CHECK (CASE
    WHEN code IN ('pocket:operating', 'pocket:reserved', 'pocket:fees', 'pocket:savings')
      THEN location = 'smart_account'
    WHEN code LIKE 'pocket:vault:%' THEN location IN ('smart_account', 'vault_contract')
    WHEN code = 'pocket:escrow' THEN location = 'escrow_contract'
    WHEN code = 'pocket:stream' THEN location = 'stream_contract'
    WHEN code IN ('pocket:spend', 'pocket:spend_reserved') THEN location = 'spend_key'
    WHEN code LIKE 'sys:chain:%' THEN location = 'external'
    WHEN code = 'sys:revenue' THEN location = 'revenue_address'
    ELSE location = 'none' END),
  CONSTRAINT ledger_account_negative_only_system CHECK (NOT allow_negative OR owner_ref = 'system'),
  CONSTRAINT ledger_account_non_negative CHECK (allow_negative OR balance >= 0)
);

-- ------------------------------------------------------------------ journal

CREATE TABLE journal_entry (
  id                text COLLATE "C" PRIMARY KEY,
  kind              text NOT NULL,       -- direct | hold | hold_post | hold_void | hold_expire | reversal
  idempotency_key   text NOT NULL,
  request_hash      text NOT NULL,       -- canonical SHA-256 of the request that created the entry
  ref_type          text NOT NULL,       -- why the money moved, e.g. payment, deposit, fee
  ref_id            text,
  memo              text,
  agent_id          text,
  payment_id        text,
  mandate_id        text,
  decision_id       text,
  chain_event_id    text,
  hold_id           text COLLATE "C",
  reverses_entry_id text COLLATE "C",
  metadata          jsonb NOT NULL DEFAULT '{}',
  line_count        integer NOT NULL,    -- seals the entry: lines can never be added later
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entry_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT journal_entry_reverses_entry_id_key UNIQUE (reverses_entry_id),
  CONSTRAINT journal_entry_line_target_key UNIQUE (id, created_at),
  CONSTRAINT journal_entry_reverses_fk FOREIGN KEY (reverses_entry_id) REFERENCES journal_entry (id),
  CONSTRAINT journal_entry_id_format CHECK (id ~ '^ent_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT journal_entry_kind
    CHECK (kind IN ('direct', 'hold', 'hold_post', 'hold_void', 'hold_expire', 'reversal')),
  CONSTRAINT journal_entry_idempotency_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT journal_entry_ref_type_length CHECK (length(ref_type) BETWEEN 1 AND 64),
  CONSTRAINT journal_entry_reversal
    CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL) AND reverses_entry_id IS DISTINCT FROM id),
  CONSTRAINT journal_entry_hold_link CHECK (CASE kind
    WHEN 'direct' THEN hold_id IS NULL
    WHEN 'reversal' THEN true
    ELSE hold_id IS NOT NULL END),
  CONSTRAINT journal_entry_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT journal_entry_line_count CHECK (line_count >= 2)
);
CREATE INDEX journal_entry_time_idx ON journal_entry (created_at DESC, id DESC);
CREATE INDEX journal_entry_ref_idx ON journal_entry (ref_type, ref_id, created_at DESC, id DESC);
CREATE INDEX journal_entry_payment_idx ON journal_entry (payment_id, created_at DESC) WHERE payment_id IS NOT NULL;
CREATE INDEX journal_entry_agent_idx ON journal_entry (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX journal_entry_chain_event_idx ON journal_entry (chain_event_id) WHERE chain_event_id IS NOT NULL;
CREATE INDEX journal_entry_hold_idx ON journal_entry (hold_id) WHERE hold_id IS NOT NULL;

-- owner_ref, asset and created_at are copies kept honest by the composite foreign keys;
-- they let "entries touching account X, newest first" and balanceAt use one index each.
CREATE TABLE journal_line (
  id                bigserial PRIMARY KEY,
  entry_id          text COLLATE "C" NOT NULL,
  ledger_account_id text COLLATE "C" NOT NULL,
  owner_ref         text COLLATE "C" NOT NULL,
  asset             text COLLATE "C" NOT NULL,
  amount            bigint NOT NULL,
  created_at        timestamptz NOT NULL,
  CONSTRAINT journal_line_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT journal_line_entry_fk FOREIGN KEY (entry_id, created_at) REFERENCES journal_entry (id, created_at),
  CONSTRAINT journal_line_account_fk
    FOREIGN KEY (ledger_account_id, owner_ref, asset) REFERENCES ledger_account (id, owner_ref, asset)
);
CREATE INDEX journal_line_entry_idx ON journal_line (entry_id);
CREATE INDEX journal_line_account_time_idx ON journal_line (ledger_account_id, created_at) INCLUDE (amount);
CREATE INDEX journal_line_owner_time_idx ON journal_line (owner_ref, created_at DESC, entry_id DESC);

-- ------------------------------------------------------------------ holds

CREATE TABLE hold (
  id                  text COLLATE "C" PRIMARY KEY,
  idempotency_key     text NOT NULL,
  request_hash        text NOT NULL,
  owner_ref           text COLLATE "C" NOT NULL,
  asset               text COLLATE "C" NOT NULL,
  source              text NOT NULL,                 -- operating | spend
  from_account_id     text COLLATE "C" NOT NULL,     -- pocket:operating or pocket:spend
  reserve_account_id  text COLLATE "C" NOT NULL,     -- pocket:reserved or pocket:spend_reserved
  amount              bigint NOT NULL,
  posted_amount       bigint,
  status              text NOT NULL DEFAULT 'pending',
  expires_at          timestamptz NOT NULL,
  entry_id            text COLLATE "C" NOT NULL,     -- the reservation entry
  resolution_entry_id text COLLATE "C",              -- the post, void or expiry entry
  ref_type            text NOT NULL,
  ref_id              text,
  memo                text,
  agent_id            text,
  payment_id          text,
  mandate_id          text,
  decision_id         text,
  metadata            jsonb NOT NULL DEFAULT '{}',
  void_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT hold_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT hold_entry_id_key UNIQUE (entry_id),
  CONSTRAINT hold_resolution_entry_id_key UNIQUE (resolution_entry_id),
  CONSTRAINT hold_from_fk
    FOREIGN KEY (from_account_id, owner_ref, asset) REFERENCES ledger_account (id, owner_ref, asset),
  CONSTRAINT hold_reserve_fk
    FOREIGN KEY (reserve_account_id, owner_ref, asset) REFERENCES ledger_account (id, owner_ref, asset),
  CONSTRAINT hold_entry_fk FOREIGN KEY (entry_id) REFERENCES journal_entry (id),
  CONSTRAINT hold_resolution_fk FOREIGN KEY (resolution_entry_id) REFERENCES journal_entry (id),
  CONSTRAINT hold_id_format CHECK (id ~ '^hld_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT hold_source CHECK (source IN ('operating', 'spend')),
  CONSTRAINT hold_distinct_accounts CHECK (from_account_id <> reserve_account_id),
  CONSTRAINT hold_amount_positive CHECK (amount > 0),
  CONSTRAINT hold_status CHECK (status IN ('pending', 'posted', 'voided', 'expired')),
  CONSTRAINT hold_resolution
    CHECK ((status = 'pending') = (resolution_entry_id IS NULL) AND (status = 'pending') = (resolved_at IS NULL)),
  CONSTRAINT hold_posted_amount CHECK (CASE
    WHEN status = 'posted' THEN posted_amount > 0 AND posted_amount <= amount
    ELSE posted_amount IS NULL END),
  CONSTRAINT hold_void_reason CHECK (status = 'voided' OR void_reason IS NULL),
  CONSTRAINT hold_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX hold_expiry_idx ON hold (expires_at, id) WHERE status = 'pending';
CREATE INDEX hold_ref_idx ON hold (ref_type, ref_id);
CREATE INDEX hold_payment_idx ON hold (payment_id) WHERE payment_id IS NOT NULL;

-- A hold's entries are written before the hold row itself, so this check waits for commit.
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_hold_fk
  FOREIGN KEY (hold_id) REFERENCES hold (id) DEFERRABLE INITIALLY DEFERRED;

-- ------------------------------------------------------------------ append-only journal

CREATE TRIGGER journal_entry_append_only BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION agentbank_forbid_mutation();
CREATE TRIGGER journal_line_append_only BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION agentbank_forbid_mutation();
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION agentbank_forbid_mutation();
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION agentbank_forbid_mutation();
CREATE TRIGGER ledger_account_no_truncate BEFORE TRUNCATE ON ledger_account
  FOR EACH STATEMENT EXECUTE FUNCTION agentbank_forbid_mutation();
CREATE TRIGGER hold_no_truncate BEFORE TRUNCATE ON hold
  FOR EACH STATEMENT EXECUTE FUNCTION agentbank_forbid_mutation();

-- ------------------------------------------------------------------ zero-sum at commit

CREATE FUNCTION ledger_check_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id   text;
  v_expected   integer;
  v_actual     integer;
  v_unbalanced text;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    v_entry_id := NEW.id;
  ELSE
    v_entry_id := NEW.entry_id;
  END IF;
  SELECT line_count INTO v_expected FROM journal_entry WHERE id = v_entry_id;
  SELECT count(*)::integer INTO v_actual FROM journal_line WHERE entry_id = v_entry_id;
  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'journal entry % has % lines but was written with %', v_entry_id, v_actual, v_expected
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_sealed';
  END IF;
  SELECT string_agg(asset || ' ' || total::text, ', ' ORDER BY asset) INTO v_unbalanced
    FROM (SELECT asset, sum(amount) AS total FROM journal_line
           WHERE entry_id = v_entry_id GROUP BY asset HAVING sum(amount) <> 0) AS unbalanced;
  IF v_unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % does not balance: %', v_entry_id, v_unbalanced
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_balanced';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();

-- ------------------------------------------------------------------ cached balances

-- Statement-level so that only the net effect of a multi-line insert on each account
-- counts; the CHECK constraints on ledger_account then refuse negative pockets.
CREATE FUNCTION ledger_apply_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_account AS a
     SET balance = a.balance + d.delta
    FROM (SELECT ledger_account_id, sum(amount)::bigint AS delta
            FROM new_lines GROUP BY ledger_account_id) AS d
   WHERE a.id = d.ledger_account_id AND d.delta <> 0;
  RETURN NULL;
END;
$$;

CREATE TRIGGER journal_line_apply_balance AFTER INSERT ON journal_line
  REFERENCING NEW TABLE AS new_lines FOR EACH STATEMENT EXECUTE FUNCTION ledger_apply_lines();

CREATE FUNCTION ledger_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 THEN
      RAISE EXCEPTION 'ledger account % must open with a zero balance', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger accounts are permanent: DELETE is not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.owner_ref, NEW.code, NEW.asset, NEW.chain_id, NEW.location, NEW.allow_negative, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.owner_ref, OLD.code, OLD.asset, OLD.chain_id, OLD.location, OLD.allow_negative, OLD.created_at) THEN
    RAISE EXCEPTION 'ledger account % is immutable apart from its cached balance', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Depth 1 is a direct UPDATE; ledger_apply_lines runs at depth 2.
  IF NEW.balance <> OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger account % balance changes only through journal lines', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_account_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION ledger_account_guard();

-- ------------------------------------------------------------------ hold lifecycle

CREATE FUNCTION ledger_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds are permanent: DELETE is not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'hold % must be created pending', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ledger_account WHERE id = NEW.from_account_id AND code = 'pocket:' || NEW.source)
       OR NOT EXISTS (SELECT 1 FROM ledger_account WHERE id = NEW.reserve_account_id AND code =
            CASE NEW.source WHEN 'operating' THEN 'pocket:reserved' ELSE 'pocket:spend_reserved' END) THEN
      RAISE EXCEPTION 'hold % must move funds from pocket:% into its reserve pocket', NEW.id, NEW.source
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM journal_entry WHERE id = NEW.entry_id AND kind = 'hold' AND hold_id = NEW.id) THEN
      RAISE EXCEPTION 'hold % must reference its own reservation entry', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.idempotency_key, NEW.request_hash, NEW.owner_ref, NEW.asset, NEW.source, NEW.from_account_id,
      NEW.reserve_account_id, NEW.amount, NEW.expires_at, NEW.entry_id, NEW.ref_type, NEW.ref_id, NEW.memo,
      NEW.agent_id, NEW.payment_id, NEW.mandate_id, NEW.decision_id, NEW.metadata, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.idempotency_key, OLD.request_hash, OLD.owner_ref, OLD.asset, OLD.source, OLD.from_account_id,
      OLD.reserve_account_id, OLD.amount, OLD.expires_at, OLD.entry_id, OLD.ref_type, OLD.ref_id, OLD.memo,
      OLD.agent_id, OLD.payment_id, OLD.mandate_id, OLD.decision_id, OLD.metadata, OLD.created_at) THEN
    RAISE EXCEPTION 'hold % may only change its status and resolution', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'pending' THEN
    v_kind := CASE NEW.status WHEN 'posted' THEN 'hold_post' WHEN 'voided' THEN 'hold_void' ELSE 'hold_expire' END;
    IF NOT EXISTS (SELECT 1 FROM journal_entry
                    WHERE id = NEW.resolution_entry_id AND hold_id = NEW.id AND kind = v_kind) THEN
      RAISE EXCEPTION 'hold % can only become % with its own % entry', OLD.id, NEW.status, v_kind
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status <> 'pending' AND NEW.status = 'pending' THEN
    IF NOT EXISTS (SELECT 1 FROM journal_entry WHERE reverses_entry_id = OLD.resolution_entry_id) THEN
      RAISE EXCEPTION 'hold % can only be re-opened by reversing its resolution entry', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.status, NEW.resolution_entry_id, NEW.posted_amount, NEW.void_reason, NEW.resolved_at)
        IS DISTINCT FROM
        (OLD.status, OLD.resolution_entry_id, OLD.posted_amount, OLD.void_reason, OLD.resolved_at) THEN
    RAISE EXCEPTION 'hold % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hold_guard BEFORE INSERT OR UPDATE OR DELETE ON hold
  FOR EACH ROW EXECUTE FUNCTION ledger_hold_guard();
