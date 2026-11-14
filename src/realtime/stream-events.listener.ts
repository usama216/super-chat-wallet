import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { STREAM_EVENTS_CHANNEL, StreamEvent } from './stream-events';

type Handler = (event: StreamEvent) => void;

// LISTEN needs one long-lived connection, so this uses its own Client instead of the pool.
// Events are passed on synchronously in the order Postgres delivers them.
// If the connection drops we reconnect; anything sent in between is not replayed by
// Postgres, so clients catch up with afterSeq.
@Injectable()
export class StreamEventsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamEventsListener.name);
  private readonly handlers = new Set<Handler>();
  private client: Client | null = null;
  private stopping = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onEvent(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.config.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel !== STREAM_EVENTS_CHANNEL || !msg.payload) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(msg.payload) as StreamEvent;
      } catch {
        this.logger.error(`Dropping malformed event payload: ${msg.payload.slice(0, 200)}`);
        return;
      }
      for (const handler of this.handlers) handler(event);
    });
    client.on('error', (err) => {
      this.logger.error(`LISTEN connection error: ${err.message}`);
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));

    await client.connect();
    await client.query(`LISTEN ${STREAM_EVENTS_CHANNEL}`);
    this.client = client;
  }

  private scheduleReconnect(dead: Client) {
    if (this.stopping || this.client !== dead) return;
    this.client = null;
    this.retryConnect();
  }

  private retryConnect() {
    setTimeout(() => {
      if (this.stopping) return;
      this.connect().catch((err) => {
        this.logger.error(`Reconnect failed, retrying: ${err.message}`);
        this.retryConnect();
      });
    }, 1000);
  }
}
