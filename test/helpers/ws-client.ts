import { WebSocket } from 'ws';

export interface WsMessage {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

/** Minimal test WebSocket client: records every message and lets a test wait for conditions. */
export class TestWsClient {
  readonly messages: WsMessage[] = [];
  private readonly socket: WebSocket;
  private waiters: Array<() => void> = [];

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()));
      this.waiters.forEach((w) => w());
    });
  }

  static async connect(baseUrl: string): Promise<TestWsClient> {
    const client = new TestWsClient(baseUrl.replace(/^http/, 'ws') + '/ws');
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', () => resolve());
      client.socket.once('error', reject);
    });
    return client;
  }

  send(event: string, data: unknown) {
    this.socket.send(JSON.stringify({ event, data }));
  }

  /** Subscribe and wait until the server confirms with the join snapshot. */
  async subscribe(streamId: string, afterSeq?: number): Promise<WsMessage> {
    this.send('subscribe', afterSeq === undefined ? { streamId } : { streamId, afterSeq });
    await this.waitFor(() => this.messages.some((m) => m.event === 'subscribed' && m.data.streamId === streamId));
    return this.messages.find((m) => m.event === 'subscribed' && m.data.streamId === streamId)!;
  }

  ofType(event: string): WsMessage[] {
    return this.messages.filter((m) => m.event === event);
  }

  waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        reject(new Error(`Timed out waiting; received ${JSON.stringify(this.messages.map((m) => m.event))}`));
      }, timeoutMs);
      const check = () => {
        if (condition()) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== check);
          resolve();
        }
      };
      this.waiters.push(check);
    });
  }

  close() {
    this.socket.close();
  }
}
