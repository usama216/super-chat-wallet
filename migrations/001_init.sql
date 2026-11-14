-- Core schema.
--
-- Balances are never stored. Money lives in a double-entry ledger:
--   * accounts            - where money can sit (user wallet, creator earnings, platform fees, ...)
--   * ledger_transactions - one row per money movement (a purchase, a super chat, ...)
--   * ledger_entries      - signed lines of a transaction: amount > 0 is a debit, < 0 a credit
-- Entries of a transaction always sum to 0, and entries are never updated or deleted.
-- A correction is a new transaction (e.g. a reversal).
--
-- The rules are enforced here with constraints/triggers as well as in the app, so a bug
-- or a manual query can't leave the ledger in a bad state.
--
-- Amounts are whole tokens stored as BIGINT. No floats anywhere.


-- Users ---------------------------------------------------------------------------------
-- Auth is mocked, so a user is just an id and a role. Any user can go live and receive
-- super chats; 'admin' is the only special role.
CREATE TABLE users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name  TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
    role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Accounts ------------------------------------------------------------------------------
--   PAYMENT_CLEARING   system, asset      money received from the payment provider
--   USER_WALLET        per user           tokens a viewer can spend
--   CREATOR_EARNINGS   per user           creator's share, can be paid out
--   PLATFORM_FEES      system, revenue    platform's cut
--   PAYOUTS_IN_TRANSIT system             payout requested, not sent yet
--
-- normal_side: wallets/earnings/fees grow with credits, clearing grows with debits.
-- The balance is flipped to that side so every balance reads as a normal positive number.
--
-- allow_negative: wallets can't go below zero. Creator earnings can, on purpose: if an
-- admin reverses a super chat after the creator already withdrew, the viewer still gets
-- refunded and the creator owes it back from future earnings.
CREATE TABLE accounts (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    type            TEXT        NOT NULL CHECK (type IN (
                                    'USER_WALLET', 'CREATOR_EARNINGS',
                                    'PLATFORM_FEES', 'PAYMENT_CLEARING', 'PAYOUTS_IN_TRANSIT')),
    owner_id        UUID        REFERENCES users(id),
    normal_side     TEXT        NOT NULL CHECK (normal_side IN ('DEBIT', 'CREDIT')),
    allow_negative  BOOLEAN     NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- user accounts have an owner, system accounts don't
    CONSTRAINT accounts_owner_matches_type CHECK (
        (type IN ('USER_WALLET', 'CREATOR_EARNINGS')) = (owner_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX accounts_owner_type_uq ON accounts (owner_id, type) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_type_uq ON accounts (type) WHERE owner_id IS NULL;

INSERT INTO accounts (type, owner_id, normal_side, allow_negative) VALUES
    ('PAYMENT_CLEARING',   NULL, 'DEBIT',  TRUE),
    ('PLATFORM_FEES',      NULL, 'CREDIT', TRUE),
    ('PAYOUTS_IN_TRANSIT', NULL, 'CREDIT', TRUE);


-- Ledger --------------------------------------------------------------------------------
-- (kind, reference_id) is unique: a business event (one purchase, one reversal of a given
-- super chat, ...) can be posted only once, whatever the app does.
CREATE TABLE ledger_transactions (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT        NOT NULL CHECK (kind IN (
                                  'PURCHASE', 'SUPER_CHAT', 'SUPER_CHAT_REVERSAL',
                                  'PAYOUT_REQUEST', 'PAYOUT_PAID', 'PAYOUT_REJECTED')),
    reference_id  UUID        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_transactions_kind_reference_uq UNIQUE (kind, reference_id)
);

CREATE TABLE ledger_entries (
    id              BIGSERIAL   PRIMARY KEY,
    transaction_id  UUID        NOT NULL REFERENCES ledger_transactions(id),
    account_id      UUID        NOT NULL REFERENCES accounts(id),
    amount          BIGINT      NOT NULL CHECK (amount <> 0),   -- + debit, - credit
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Covering index so a balance (SUM by account) is an index-only scan.
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id) INCLUDE (amount);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);


-- Balance of an account, flipped to its normal side.
CREATE FUNCTION account_balance(p_account_id UUID) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT (COALESCE(SUM(e.amount), 0)
           * CASE a.normal_side WHEN 'DEBIT' THEN 1 ELSE -1 END)::BIGINT
    FROM accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.id
    WHERE a.id = p_account_id
    GROUP BY a.id, a.normal_side
$$;


-- The ledger is append-only.
CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate
    BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();
CREATE TRIGGER ledger_transactions_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
CREATE TRIGGER ledger_transactions_no_truncate
    BEFORE TRUNCATE ON ledger_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();


-- Every transaction has at least 2 entries that sum to 0.
-- Deferred to COMMIT, because entries are inserted one row at a time and the transaction
-- is only balanced once all of them are in. Also attached to ledger_transactions so a
-- header with no entries is caught.
CREATE FUNCTION ledger_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_tx_id   UUID;
    v_sum     NUMERIC;
    v_count   INT;
BEGIN
    IF TG_TABLE_NAME = 'ledger_entries' THEN
        v_tx_id := NEW.transaction_id;
    ELSE
        v_tx_id := NEW.id;
    END IF;

    SELECT COALESCE(SUM(amount), 0), COUNT(*)
      INTO v_sum, v_count
      FROM ledger_entries
     WHERE transaction_id = v_tx_id;

    IF v_count < 2 THEN
        RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 are required', v_tx_id, v_count
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced: entries sum to %', v_tx_id, v_sum
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
    AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();


-- Accounts with allow_negative = false can't go below zero.
-- This is a safety net only. On its own it has a race (two concurrent transactions don't
-- see each other's entries); the real double-spend protection is the row lock the app
-- takes on the wallet before checking the balance.
CREATE FUNCTION ledger_assert_non_negative() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_allow_negative BOOLEAN;
    v_balance        BIGINT;
BEGIN
    SELECT allow_negative INTO v_allow_negative FROM accounts WHERE id = NEW.account_id;
    IF v_allow_negative THEN
        RETURN NULL;
    END IF;

    v_balance := account_balance(NEW.account_id);
    IF v_balance < 0 THEN
        RAISE EXCEPTION 'account % would have a negative balance (%)', NEW.account_id, v_balance
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_non_negative
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_assert_non_negative();


-- Business tables -----------------------------------------------------------------------
-- These record what happened and its status. They never hold a balance.
--
-- Idempotency: (user, idempotency_key) is unique on purchases, super_chats and payouts,
-- so a retried request can't create a second operation. request_hash lets us reject a
-- reused key that comes with a different body.


-- Purchase lifecycle: PENDING -> COMPLETED | FAILED (see PurchasesService).
CREATE TABLE purchases (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id),
    idempotency_key     TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    request_hash        TEXT        NOT NULL,
    amount              BIGINT      NOT NULL CHECK (amount > 0),
    status              TEXT        NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    provider_charge_id  TEXT,
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT purchases_user_idempotency_uq UNIQUE (user_id, idempotency_key)
);


-- A stream is just an id owned by a creator. The server derives the money recipient from
-- the stream, so a client can't route a super chat to someone else.
-- last_seq is the per-stream counter that gives super chats their order.
CREATE TABLE streams (
    id          TEXT        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    creator_id  UUID        NOT NULL REFERENCES users(id),
    last_seq    BIGINT      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Fee split is computed at send time and stored, so a later fee change doesn't affect
-- old super chats:
--   creator_amount = floor(amount * (10000 - fee_bps) / 10000)
--   platform_fee   = amount - creator_amount     (platform keeps the rounding remainder)
CREATE TABLE super_chats (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id        TEXT        NOT NULL REFERENCES streams(id),
    sender_id        UUID        NOT NULL REFERENCES users(id),
    creator_id       UUID        NOT NULL REFERENCES users(id),
    idempotency_key  TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    request_hash     TEXT        NOT NULL,
    message          TEXT        NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
    amount           BIGINT      NOT NULL CHECK (amount > 0),
    fee_bps          INT         NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
    platform_fee     BIGINT      NOT NULL CHECK (platform_fee >= 0),
    creator_amount   BIGINT      NOT NULL CHECK (creator_amount >= 0),
    stream_seq       BIGINT      NOT NULL,
    pinned_until     TIMESTAMPTZ NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'COMPLETED'
                                 CHECK (status IN ('COMPLETED', 'REVERSED')),
    reversed_at      TIMESTAMPTZ,
    reversed_by      UUID        REFERENCES users(id),
    reversal_reason  TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT super_chats_split_adds_up   CHECK (platform_fee + creator_amount = amount),
    CONSTRAINT super_chats_not_to_self     CHECK (sender_id <> creator_id),
    CONSTRAINT super_chats_reversal_fields CHECK (
        (status = 'REVERSED') = (reversed_at IS NOT NULL AND reversed_by IS NOT NULL)
    ),
    CONSTRAINT super_chats_sender_idempotency_uq UNIQUE (sender_id, idempotency_key),
    CONSTRAINT super_chats_stream_seq_uq         UNIQUE (stream_id, stream_seq)
);

CREATE INDEX super_chats_stream_pinned_idx ON super_chats (stream_id, pinned_until DESC);


-- Payout lifecycle: REQUESTED -> PAID | REJECTED.
-- The amount is moved into PAYOUTS_IN_TRANSIT at request time, so the same earnings
-- can't be requested twice.
CREATE TABLE payouts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id       UUID        NOT NULL REFERENCES users(id),
    idempotency_key  TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    request_hash     TEXT        NOT NULL,
    amount           BIGINT      NOT NULL CHECK (amount > 0),
    status           TEXT        NOT NULL DEFAULT 'REQUESTED'
                                 CHECK (status IN ('REQUESTED', 'PAID', 'REJECTED')),
    processed_at     TIMESTAMPTZ,
    processed_by     UUID        REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payouts_creator_idempotency_uq UNIQUE (creator_id, idempotency_key)
);
