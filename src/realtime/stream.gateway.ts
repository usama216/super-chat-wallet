import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';
import { StreamsService } from '../super-chats/streams.service';
import { SuperChatsService } from '../super-chats/super-chats.service';
import { StreamEvent } from './stream-events';
import { StreamEventsListener } from './stream-events.listener';

/*
 * ws://host/ws, JSON messages.
 *
 * client -> server
 *   { "event": "subscribe",   "data": { "streamId": "abc", "afterSeq": 12 } }   afterSeq optional
 *   { "event": "unsubscribe", "data": { "streamId": "abc" } }
 *
 * server -> client
 *   subscribed          { streamId, lastSeq, serverTime, pinned: [...] }
 *   super_chat.created  { ...superChat }                    in streamSeq order
 *   super_chat.reversed { streamId, superChatId, reversedAt }
 *   error               { message }
 *
 * Watching is public and read-only; sending goes through REST (auth, idempotency, status codes).
 * Clients unpin when pinnedUntil passes, using serverTime to correct their clock.
 */
interface Subscription {
  streamId: string;
  /** highest streamSeq sent so far, used to drop duplicates */
  lastSentSeq: number;
  /** live events wait here while the join snapshot is loading */
  buffer: StreamEvent[] | null;
}

const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CATCH_UP = 200;

@WebSocketGateway({ path: '/ws' })
export class StreamGateway implements OnModuleInit, OnGatewayDisconnect {
  private readonly logger = new Logger(StreamGateway.name);
  private readonly viewers = new Map<string, Map<WebSocket, Subscription>>();

  constructor(
    private readonly listener: StreamEventsListener,
    private readonly streams: StreamsService,
    private readonly superChats: SuperChatsService,
  ) {}

  onModuleInit() {
    this.listener.onEvent((event) => this.dispatch(event));
  }

  /*
   * A super chat could commit between loading the snapshot and going live. To avoid losing
   * it, the socket is registered first in buffering mode, then the snapshot is loaded and
   * sent, then the buffer is flushed, skipping anything already covered (by seq).
   */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() body: { streamId?: unknown; afterSeq?: unknown },
  ) {
    const streamId = body?.streamId;
    if (typeof streamId !== 'string' || !STREAM_ID_RE.test(streamId)) {
      return this.send(socket, 'error', { message: 'subscribe needs a valid streamId' });
    }
    const afterSeq = body.afterSeq;
    if (afterSeq !== undefined && !(Number.isSafeInteger(afterSeq) && (afterSeq as number) >= 0)) {
      return this.send(socket, 'error', { message: 'afterSeq must be a non-negative integer' });
    }

    const sub: Subscription = { streamId, lastSentSeq: 0, buffer: [] };
    if (!this.viewers.has(streamId)) this.viewers.set(streamId, new Map());
    this.viewers.get(streamId)!.set(socket, sub);

    try {
      // read lastSeq before pinned, so everything up to lastSeq is covered by the pinned query
      const lastSeq = await this.streams.lastSeq(streamId);
      const pinned = await this.superChats.pinned(streamId);
      const missed =
        afterSeq === undefined
          ? []
          : await this.superChats.listForStream(streamId, afterSeq as number, MAX_CATCH_UP);

      this.send(socket, 'subscribed', { streamId, lastSeq, serverTime: new Date(), pinned });
      sub.lastSentSeq = afterSeq === undefined ? lastSeq : (afterSeq as number);
      for (const sc of missed) {
        this.send(socket, 'super_chat.created', sc);
        sub.lastSentSeq = sc.streamSeq;
      }

      const buffered = sub.buffer ?? [];
      sub.buffer = null;
      for (const event of buffered) this.deliver(socket, sub, event);
    } catch (err) {
      this.viewers.get(streamId)?.delete(socket);
      this.send(socket, 'error', { message: (err as Error).message });
    }
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() socket: WebSocket, @MessageBody() body: { streamId?: string }) {
    if (body?.streamId) this.viewers.get(body.streamId)?.delete(socket);
  }

  handleDisconnect(socket: WebSocket) {
    for (const [streamId, subs] of this.viewers) {
      subs.delete(socket);
      if (subs.size === 0) this.viewers.delete(streamId);
    }
  }

  private dispatch(event: StreamEvent) {
    const subs = this.viewers.get(event.streamId);
    if (!subs) return;
    for (const [socket, sub] of subs) {
      if (sub.buffer) sub.buffer.push(event);
      else this.deliver(socket, sub, event);
    }
  }

  private deliver(socket: WebSocket, sub: Subscription, event: StreamEvent) {
    if (event.type === 'super_chat.created') {
      if (event.superChat.streamSeq <= sub.lastSentSeq) return; // already sent in the snapshot
      sub.lastSentSeq = event.superChat.streamSeq;
      this.send(socket, event.type, event.superChat);
    } else {
      this.send(socket, event.type, {
        streamId: event.streamId,
        superChatId: event.superChatId,
        reversedAt: event.reversedAt,
      });
    }
  }

  private send(socket: WebSocket, event: string, data: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ event, data }), (err) => {
      if (err) this.logger.warn(`WebSocket send failed: ${err.message}`);
    });
  }
}
