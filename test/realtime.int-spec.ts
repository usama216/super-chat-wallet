import {
  buy,
  createStream,
  createTestApp,
  createUser,
  sendSuperChat,
  TestContext,
} from './helpers/test-app';
import { TestWsClient } from './helpers/ws-client';

/**
 * Real-time delivery over WebSocket: viewers see Super Chats live, IN ORDER.
 */
describe('Real-time Super Chats over WebSocket', () => {
  let ctx: TestContext;
  const clients: TestWsClient[] = [];

  async function viewer(tokens: number, name = 'viewer'): Promise<string> {
    const id = await createUser(ctx, name);
    await buy(ctx, id, tokens, `topup-${id}`).expect(201);
    return id;
  }

  async function connect(): Promise<TestWsClient> {
    const client = await TestWsClient.connect(ctx.baseUrl);
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    clients.forEach((c) => c.close());
    await ctx.close();
  });

  it('delivers concurrently sent Super Chats to every viewer in stream order', async () => {
    const creator = await createUser(ctx, 'creator');
    const stream = await createStream(ctx, creator, 'live-1');
    const watcherA = await connect();
    const watcherB = await connect();
    await watcherA.subscribe(stream);
    await watcherB.subscribe(stream);

    // 25 different viewers send at the same moment, with distinct amounts so we can identify them.
    const senders = await Promise.all(Array.from({ length: 25 }, (_, i) => viewer(100, `s${i}`)));
    await Promise.all(senders.map((s, i) => sendSuperChat(ctx, s, stream, i + 1, `k${i}`).expect(201)));

    for (const watcher of [watcherA, watcherB]) {
      await watcher.waitFor(() => watcher.ofType('super_chat.created').length === 25);
      const seqs = watcher.ofType('super_chat.created').map((m) => m.data.streamSeq);
      // Exactly 1..25, in order: no gaps, no duplicates, no reordering.
      expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    }
    // Both viewers saw the very same sequence of Super Chats.
    const idsA = watcherA.ofType('super_chat.created').map((m) => m.data.id);
    const idsB = watcherB.ofType('super_chat.created').map((m) => m.data.id);
    expect(idsA).toEqual(idsB);
  });

  it('events carry the full Super Chat, including the server-decided pin time', async () => {
    const creator = await createUser(ctx, 'creator');
    const stream = await createStream(ctx, creator, 'live-2');
    const watcher = await connect();
    await watcher.subscribe(stream);
    const sender = await viewer(1000);

    const res = await sendSuperChat(ctx, sender, stream, 250, 'full', 'hi there').expect(201);

    await watcher.waitFor(() => watcher.ofType('super_chat.created').length === 1);
    const event = watcher.ofType('super_chat.created')[0].data;
    expect(event).toMatchObject({
      id: res.body.id,
      message: 'hi there',
      amount: 250,
      creatorAmount: 200,
      platformFee: 50,
      pinnedUntil: res.body.pinnedUntil,
    });
    expect(event.requestHash).toBeUndefined();
  });

  it('only sends a viewer the streams they subscribed to', async () => {
    const creator = await createUser(ctx, 'creator');
    const watched = await createStream(ctx, creator, 'watched');
    const other = await createStream(ctx, creator, 'other');
    const watcher = await connect();
    await watcher.subscribe(watched);
    const sender = await viewer(100);

    await sendSuperChat(ctx, sender, other, 10, 'other-1').expect(201);
    await sendSuperChat(ctx, sender, watched, 10, 'watched-1').expect(201);

    await watcher.waitFor(() => watcher.ofType('super_chat.created').length === 1);
    expect(watcher.ofType('super_chat.created')[0].data.streamId).toBe(watched);
  });

  it('a failed Super Chat (insufficient funds) is never broadcast', async () => {
    const creator = await createUser(ctx, 'creator');
    const stream = await createStream(ctx, creator, 'live-3');
    const watcher = await connect();
    await watcher.subscribe(stream);
    const poor = await viewer(5);
    const rich = await viewer(100);

    await sendSuperChat(ctx, poor, stream, 50, 'fail').expect(402);
    await sendSuperChat(ctx, rich, stream, 50, 'ok').expect(201);

    await watcher.waitFor(() => watcher.ofType('super_chat.created').length === 1);
    expect(watcher.ofType('super_chat.created')[0].data.senderId).toBe(rich);
  });

  it('joining sends a snapshot of what is pinned, biggest first', async () => {
    const creator = await createUser(ctx, 'creator');
    const stream = await createStream(ctx, creator, 'live-4');
    const sender = await viewer(10_000);
    await sendSuperChat(ctx, sender, stream, 10, 'p1').expect(201);
    await sendSuperChat(ctx, sender, stream, 1_000, 'p2').expect(201);
    await sendSuperChat(ctx, sender, stream, 200, 'p3').expect(201);

    const watcher = await connect();
    const joined = await watcher.subscribe(stream);

    expect(joined.data.lastSeq).toBe(3);
    expect(joined.data.pinned.map((s: { amount: number }) => s.amount)).toEqual([1_000, 200, 10]);
    // History is not replayed as live events when joining fresh.
    expect(watcher.ofType('super_chat.created')).toHaveLength(0);
  });

  it('a reconnecting viewer catches up from afterSeq, in order, then continues live', async () => {
    const creator = await createUser(ctx, 'creator');
    const stream = await createStream(ctx, creator, 'live-5');
    const sender = await viewer(1000);
    for (let i = 1; i <= 5; i++) {
      await sendSuperChat(ctx, sender, stream, 10, `r${i}`).expect(201);
    }

    // The viewer had seen up to seq 2 before their connection dropped.
    const watcher = await connect();
    await watcher.subscribe(stream, 2);
    await sendSuperChat(ctx, sender, stream, 10, 'r6').expect(201);

    await watcher.waitFor(() => watcher.ofType('super_chat.created').length === 4);
    expect(watcher.ofType('super_chat.created').map((m) => m.data.streamSeq)).toEqual([3, 4, 5, 6]);
  });

  it('rejects an invalid subscribe message', async () => {
    const watcher = await connect();
    watcher.send('subscribe', { streamId: '../../etc' });
    await watcher.waitFor(() => watcher.ofType('error').length === 1);
    expect(watcher.ofType('error')[0].data.message).toMatch(/streamId/);
  });
});
