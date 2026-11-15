-- Free chat messages on a live. They don't move money, so they live outside the ledger and
-- need none of its guarantees (no idempotency key, no locking). The id doubles as the order.
CREATE TABLE chat_messages (
    id          BIGSERIAL   PRIMARY KEY,
    stream_id   TEXT        NOT NULL REFERENCES streams(id),
    sender_id   UUID        NOT NULL REFERENCES users(id),
    text        TEXT        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_stream_idx ON chat_messages (stream_id, id);
