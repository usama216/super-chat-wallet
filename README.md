# Super Chat Wallet

A backend for a token wallet and live-stream Super Chats, built with NestJS, PostgreSQL and TypeScript.

Viewers buy tokens (the payment is mocked) and send Super Chats, which are a message plus tokens, to a creator during a live stream. The creator receives the amount minus a 20% platform fee and can request a payout. An admin can reverse a Super Chat and refund the sender. Viewers receive Super Chats in real time over WebSocket, in order, and bigger amounts stay pinned longer.

The design is built around four guarantees:

| Guarantee | How it is enforced |
|---|---|
| Balances come from a double-entry ledger, never from an editable number | `ledger_entries` is append-only and every transaction must sum to 0. Both rules are enforced by Postgres triggers. |
| The same request sent twice charges once | `UNIQUE (user, idempotency_key)` on purchases, Super Chats and payouts, checked inside the money-moving transaction |
| No double spending under concurrent requests | `SELECT … FOR UPDATE` on the account being spent from, before the balance is read |
| Viewers see Super Chats in order | A per-stream sequence number assigned under a row lock, plus Postgres `NOTIFY`, which is delivered in commit order |

---

## Quick start

Requirements: Docker with Docker Compose.

```bash
docker compose up --build          # Postgres + API on http://localhost:3000, WebSocket on ws://localhost:3000/ws
```

**Interactive API docs (Swagger): http://localhost:3000/docs.** Click **Authorize** to set `x-user-id`, then use "Try it out" on any endpoint.

Postgres is published on host port **5433**, so it doesn't clash with a local Postgres on 5432. Migrations run automatically when the API starts.

### Running without Docker (for development)

```bash
docker compose up -d postgres      # only the database
npm ci
export DATABASE_URL=postgres://superchat:superchat@localhost:5433/superchat
npm run start:dev
```

Configuration (environment variables): `DATABASE_URL` (required), `PORT` (default 3000), and `PLATFORM_FEE_BPS` (default 2000, which is 20%).

---

## Try it

Authentication is mocked: the caller is identified by the `x-user-id` header. A demo admin is seeded with id `00000000-0000-0000-0000-00000000ad01`.

```bash
# 1. Create a creator and a viewer (each response contains the user id)
curl -s -XPOST localhost:3000/users -H 'content-type: application/json' -d '{"displayName":"Cara"}'
curl -s -XPOST localhost:3000/users -H 'content-type: application/json' -d '{"displayName":"Vic"}'
CREATOR=<id>; VIEWER=<id>

# 2. Creator goes live
curl -s -XPOST localhost:3000/streams -H "x-user-id: $CREATOR" -H 'content-type: application/json' -d '{"id":"demo-stream"}'

# 3. Viewer buys 500 tokens. Run it twice: the second response is 200 + Idempotent-Replayed, and nothing is charged.
curl -si -XPOST localhost:3000/wallet/purchases -H "x-user-id: $VIEWER" -H 'Idempotency-Key: buy-001' \
     -H 'content-type: application/json' -d '{"amount":500}'

# 4. Viewer sends a 100-token Super Chat (creator gets 80, platform 20)
curl -s -XPOST localhost:3000/streams/demo-stream/super-chats -H "x-user-id: $VIEWER" -H 'Idempotency-Key: sc-001' \
     -H 'content-type: application/json' -d '{"message":"Great stream!","amount":100}'

# 5. Balances (both computed from the ledger)
curl -s localhost:3000/me -H "x-user-id: $VIEWER"     # wallet 400
curl -s localhost:3000/me -H "x-user-id: $CREATOR"    # earnings 80

# 6. Creator requests a payout; admin marks it paid
curl -s -XPOST localhost:3000/payouts -H "x-user-id: $CREATOR" -H 'Idempotency-Key: po-001' \
     -H 'content-type: application/json' -d '{"amount":50}'
curl -s -XPOST localhost:3000/admin/payouts/<payoutId>/paid -H 'x-user-id: 00000000-0000-0000-0000-00000000ad01'

# 7. Admin reverses the Super Chat: viewer refunded in full
curl -s -XPOST localhost:3000/admin/super-chats/<superChatId>/reversal -H 'x-user-id: 00000000-0000-0000-0000-00000000ad01' \
     -H 'content-type: application/json' -d '{"reason":"chargeback"}'
```

Watching a stream live (for example with `npx wscat -c ws://localhost:3000/ws`):

```json
> {"event":"subscribe","data":{"streamId":"demo-stream"}}
< {"event":"subscribed","data":{"streamId":"demo-stream","lastSeq":1,"serverTime":"…","pinned":[…]}}
< {"event":"super_chat.created","data":{"id":"…","streamSeq":2,"amount":100,"message":"…","pinnedUntil":"…"}}
< {"event":"super_chat.reversed","data":{"streamId":"demo-stream","superChatId":"…","reversedAt":"…"}}
```

To reconnect without missing anything, subscribe with `"afterSeq": <last seq you saw>`. The missed Super Chats are sent first, in order, and then live delivery continues.

### Checking the money guarantees by hand

Uses `demo-stream` from step 2 above.

```bash
# A fresh viewer
V=$(curl -s -XPOST localhost:3000/users -H 'content-type: application/json' -d '{"displayName":"Racer"}' \
    | sed 's/.*"id":"\([^"]*\)".*/\1/')

# Idempotency: the same 100-token purchase fired 20 times at once -> one 201, nineteen 200
(for i in $(seq 20); do curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:3000/wallet/purchases \
   -H "x-user-id: $V" -H 'Idempotency-Key: race-buy' -H 'content-type: application/json' \
   -d '{"amount":100}' & done; wait) | sort | uniq -c

# Double spending: 20 different Super Chats of 30 at once against 100 tokens -> three 201, seventeen 402
(for i in $(seq 20); do curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:3000/streams/demo-stream/super-chats \
   -H "x-user-id: $V" -H "Idempotency-Key: race-$i" -H 'content-type: application/json' \
   -d '{"message":"race","amount":30}' & done; wait) | sort | uniq -c

curl -s localhost:3000/me -H "x-user-id: $V"    # wallet: 10
```

### API

| Method & path | Who | Notes |
|---|---|---|
| `POST /users` | anyone | Sign-up stand-in. Always creates role `user`. |
| `GET /me` | user | Profile plus `wallet` and `earnings` balances |
| `POST /wallet/purchases` | user | **Idempotency-Key required.** `{amount}`, 1–1,000,000 |
| `GET /wallet` | user | Balance and the latest ledger entries (statement) |
| `POST /streams` | user | `{id}`. The caller becomes the stream's creator. |
| `POST /streams/:id/super-chats` | user | **Idempotency-Key required.** `{message, amount}`. 402 if the wallet is short. |
| `GET /streams/:id/super-chats?afterSeq=&limit=` | user | History in sequence order |
| `GET /streams/:id/pinned` | user | Currently pinned, biggest first |
| `POST /payouts` / `GET /payouts` | user | **Idempotency-Key required.** `{amount}` from earnings |
| `POST /admin/super-chats/:id/reversal` | admin | Full refund. Repeating it is a no-op. |
| `GET /admin/payouts?status=` | admin | |
| `POST /admin/payouts/:id/paid` · `/reject` | admin | Repeating it is a no-op. The opposite decision returns 409. |

Status codes: `201` means created. `200` with the header `Idempotent-Replayed: true` means a retry, and the original result is returned. `402 InsufficientFunds` means the account is short. `422` means an Idempotency-Key was reused with a different body.

---

## Architecture

```
src/
  ledger/        LedgerService: the only code that writes money. post(), postReversal(), lockAccount(), balanceOf()
  wallet/        token purchase (3-phase, idempotent) + PaymentProvider interface and mock
  super-chats/   streams, send (lock → idempotency → balance → seq → post → notify), reversal, fee and pin policies
  payouts/       request (hold) → paid / rejected
  admin/         admin endpoints (reversal, payout processing)
  realtime/      pg NOTIFY publisher, LISTEN connection, WebSocket gateway
  common/        mock auth guards, Idempotency-Key handling, errors
  database/      pg pool, transaction helper, SQL migration runner
  swagger.ts     OpenAPI / Swagger UI at /docs
migrations/      plain SQL: the schema, constraints and ledger triggers
```

### Money model

Every place money can sit is an **account**. Every movement is a **ledger transaction** with two or more signed **entries** (positive means debit, negative means credit) that sum to zero.

| Account | Owner | Normal side | May go negative |
|---|---|---|---|
| `USER_WALLET` | each user | credit (a liability: tokens the platform owes the user) | **no** |
| `CREATOR_EARNINGS` | each user | credit | yes (clawback after reversal, see below) |
| `PLATFORM_FEES` | system | credit (revenue) | – |
| `PAYMENT_CLEARING` | system | debit (an asset: money received from the payment provider) | – |
| `PAYOUTS_IN_TRANSIT` | system | credit (owed to creators, payout pending) | – |

| Event | Entries |
|---|---|
| Purchase 100 | debit CLEARING 100 · credit WALLET 100 |
| Super Chat 100 | debit WALLET 100 · credit EARNINGS 80 · credit FEES 20 |
| Reversal | exact mirror of the Super Chat posting |
| Payout requested 50 | debit EARNINGS 50 · credit IN_TRANSIT 50 |
| Payout paid | debit IN_TRANSIT 50 · credit CLEARING 50 |
| Payout rejected | debit IN_TRANSIT 50 · credit EARNINGS 50 |

`balance = SUM(entries)`, flipped to the account's normal side (the `account_balance()` SQL function). No balance column exists anywhere.

---

## Design decisions

### 1. The database is the last line of defence for the ledger
The service layer validates every posting, and Postgres enforces the same rules again so that no bug or manual SQL session can break them:
- **Append-only:** triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on ledger tables. Mistakes are corrected with new reversing transactions, which also gives an audit trail.
- **Balanced:** a `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks at `COMMIT` that each transaction has at least 2 entries that sum to 0. It must be deferred because entries are inserted one row at a time.
- **One posting per business event:** `UNIQUE (kind, reference_id)`, so a purchase can't be credited twice and a Super Chat can't be reversed twice, even if the application logic had a bug.
- **Non-negative wallets:** a deferred trigger. This is a *safety net* only (see §3).

### 2. Raw SQL (`pg`) instead of an ORM
The core of this project is locking, constraints and transactions. With raw SQL every `FOR UPDATE`, every `ON CONFLICT` and every transaction boundary is visible in the code that a reviewer reads. The schema is plain SQL migrations for the same reason. The cost is some hand-written mapping, which is acceptable at this size.

### 3. Concurrency: explicit row locks under READ COMMITTED
Every spend follows the same pattern inside one transaction: **lock the account being debited (`SELECT … FOR UPDATE`) → read the balance → check → post**. A concurrent spend from the same wallet waits on the lock and then reads the new balance. Spends from different wallets don't block each other.
- I chose this over `SERIALIZABLE` because the locks document exactly what is serialized, and the behaviour under contention is waiting rather than random serialization failures. The transaction helper still retries `40001` and `40P01` errors as a precaution.
- **Lock order** is always *spender's account → stream row* (send) and *Super Chat row → creator earnings* (reversal). Credits never take locks. No two flows take the same locks in opposite order, so they can't deadlock.
- The idempotency check runs *after* the wallet lock. Two copies of the same request are two spends from the same wallet, so the second copy runs after the first has committed and finds it. No separate idempotency lock is needed.

### 4. Idempotency keys are stored with the operation they created
The `Idempotency-Key` header is required on every money-moving POST, and the key is a unique column on the purchase, Super Chat or payout row. The key and the effect commit atomically, so there is no window where one exists without the other. I chose this over a generic "idempotency middleware" table that caches responses, because there the key and the effect would be written separately. A SHA-256 hash of the request body is stored with the key, and reusing a key with a different body returns `422`, the same behaviour as Stripe. Keys are scoped per user.

Admin actions (reverse, mark paid/rejected) are idempotent by nature because they move one existing object to a final state. A repeat returns the current state.

### 5. Purchases use three phases, not one transaction
1. Insert a `PENDING` purchase. This claims the key and commits.
2. Call the payment provider **outside** any DB transaction, so a slow network call never holds locks. The provider is called with our purchase id as *its* idempotency key, so the card is charged at most once even if this step is retried.
3. In one transaction, run `UPDATE … SET status='COMPLETED' WHERE status='PENDING'` and post the ledger entries. Only one request can win that update.

If the server crashes between phases, the purchase stays `PENDING`, and a retry with the same key resumes it.

### 6. Fee rounding is explicit
`creatorAmount = floor(amount × (10000 − feeBps) / 10000)` and `platformFee = amount − creatorAmount`. Integer math only. The parts always add up to the amount, which a CHECK constraint enforces. The platform keeps the fractional token. `fee_bps` and both parts are stored on each Super Chat, so changing the fee later never changes history.

### 7. Reversal mirrors the ledger and may make a creator negative
A reversal reads the original posting and writes its exact negation instead of recomputing 80/20. The sender is refunded in full, including the platform fee. If the creator has already withdrawn the money, their earnings go **negative**: the viewer is still made whole, and the creator can't request another payout until future earnings cover the debt. The alternative, refusing the reversal, would reward a fraudulent creator for withdrawing quickly.

### 8. Payouts hold the money at request time
A request moves tokens from `CREATOR_EARNINGS` to `PAYOUTS_IN_TRANSIT` immediately, so the same tokens can't be requested twice. An admin "mark paid" stands in for a payout provider's confirmation webhook. Reject releases the hold.

### 9. Ordered real-time delivery with Postgres LISTEN/NOTIFY
- Each Super Chat takes `streams.last_seq + 1` while holding that stream's row lock, so Super Chats on one stream commit in sequence order.
- `pg_notify` is called **inside** the transaction. Postgres delivers it only on commit (a rolled-back or insufficient-funds attempt is never broadcast) and delivers notifications in commit order. Every API instance listens, so this works across horizontally scaled instances without extra infrastructure.
- On join, the gateway registers the socket in buffering mode, loads the snapshot (pinned chats, or the missed chats after `afterSeq`), sends it, then flushes the buffer and drops anything with `seq <= lastSent`. Nothing is lost or duplicated in the gap between snapshot and live.
- **Pinning:** the server computes `pinnedUntil` from amount tiers (30 s, 2 min, 5 min, 30 min, 1 h) and stores it, so every viewer agrees. Clients unpin locally when the time passes (`serverTime` is included to correct clock skew). This avoids a server-side timer per message.

### 10. Amounts are integers within `Number.MAX_SAFE_INTEGER`
Postgres stores `BIGINT`. The `pg` type parser converts to JS `number` and **throws** if a value is not a safe integer, instead of silently losing precision. Input limits (1,000,000 per purchase or Super Chat) keep realistic values many orders of magnitude below that limit.

---

## Trade-offs and known limitations

- **Balance = `SUM` over the account's entries.** This is simple and always consistent, and a covering index keeps it fast, but the cost grows with an account's history. See "What I'd do next".
- **One stream is serialized.** The stream-row lock that guarantees ordering also means Super Chats on a single stream commit one at a time (each holds the lock for a few milliseconds). This is fine for realistic Super Chat rates. Sharding the sequence or ordering by commit timestamp would be the next step for extreme traffic.
- **NOTIFY is not a durable queue.** If an instance's LISTEN connection drops, events during the gap aren't replayed by Postgres. The listener reconnects, and clients recover through `afterSeq` (every event has a sequence number), but the server doesn't push the gap automatically. Payloads are limited to 8 KB (Super Chat messages are capped at 500 characters).
- **Auth is mocked** (`x-user-id`). The guards are isolated, so real JWT auth would replace two classes.
- **The payment provider is mocked**, and its idempotency memory is in-process. A real provider (Stripe) keeps it on its side.
- **A failed Super Chat (402) doesn't consume its idempotency key.** The transaction rolls back, so a retry with the same key after a top-up succeeds. I consider this correct, since nothing happened the first time.
- **Purchases left `PENDING`** by a crash are only resumed when the client retries. There is no background reconciler yet.

## What I'd do next

1. **Balance snapshots:** periodic `(account_id, balance, last_entry_id)` checkpoints so a balance is a snapshot plus a small `SUM`, keeping reads O(1) as history grows. The ledger stays the source of truth.
2. **Transactional outbox plus a broker** (Redis Streams or Kafka) for real-time events, giving durable, replayable delivery and server-side gap filling. The ordering logic (per-stream seq) stays the same.
3. **PENDING purchase reconciler:** a job that queries the provider for stale `PENDING` purchases and completes or fails them. Also a real payment webhook endpoint (verified signature, idempotent by event id).
4. **Real auth** (JWT or OIDC), rate limiting on money-moving endpoints, and per-user daily limits.
5. **Ledger reconciliation job and alerts:** continuously re-check the invariants (global sum 0, wallets ≥ 0) and compare `PAYMENT_CLEARING` with the provider's settlement reports.
6. **Creator debt handling:** future earnings already pay off a negative balance automatically, because it's just a sum. I'd add an admin view of creators in debt and a policy for long-unpaid debt.
7. **Observability:** structured logs with request and idempotency ids, and metrics on lock wait time and 402/422 rates. I'd also add response schemas to the OpenAPI spec (the request side is documented at `/docs`).
