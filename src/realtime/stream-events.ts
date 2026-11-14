import { Queryable } from '../database/database.service';
import type { SuperChat } from '../super-chats/super-chats.service';

// Events go out through Postgres LISTEN/NOTIFY rather than an in-process emitter:
//  - pg_notify inside a transaction is delivered only on commit (never for a rolled-back send)
//  - notifications arrive in commit order, and super chats on a stream commit in seq order
//    (they all lock the stream row), so listeners get them in seq order
//  - every app instance listens, so it works with more than one instance
// Every created event carries its streamSeq, so clients can detect and fill gaps.
export const STREAM_EVENTS_CHANNEL = 'stream_events';

export type StreamEvent =
  | { type: 'super_chat.created'; streamId: string; superChat: SuperChat }
  | { type: 'super_chat.reversed'; streamId: string; superChatId: string; reversedAt: Date };

/** Must be called with the transaction's client so the event is tied to the commit. */
export async function publishStreamEvent(tx: Queryable, event: StreamEvent): Promise<void> {
  // NOTIFY payloads are limited to 8000 bytes; a 500-char message is well under that.
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) > 7900) {
    throw new Error(`Stream event too large for NOTIFY (${Buffer.byteLength(payload)} bytes)`);
  }
  await tx.query('SELECT pg_notify($1, $2)', [STREAM_EVENTS_CHANNEL, payload]);
}
