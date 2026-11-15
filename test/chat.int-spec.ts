import { createStream, createTestApp, createUser, expectLedgerInvariants, TestContext, walletBalance } from './helpers/test-app';

/**
 * Free chat on a live: stored in order, validated, and never touches money.
 */
describe('Live chat messages', () => {
  let ctx: TestContext;
  let creator: string;
  let viewer: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    creator = await createUser(ctx, 'chat-creator');
    viewer = await createUser(ctx, 'chat-viewer');
    await createStream(ctx, creator, 'chat-stream');
  });

  afterAll(async () => {
    await expectLedgerInvariants(ctx);
    await ctx.close();
  });

  const send = (userId: string, text: unknown, stream = 'chat-stream') =>
    ctx.http().post(`/streams/${stream}/messages`).set('x-user-id', userId).send({ text });

  it('stores messages and returns them oldest first', async () => {
    const first = await send(viewer, '  hello  ').expect(201);
    expect(first.body).toMatchObject({ streamId: 'chat-stream', senderId: viewer, text: 'hello' });
    await send(creator, 'welcome!').expect(201);

    const res = await ctx.http().get('/streams/chat-stream/messages').set('x-user-id', viewer).expect(200);
    expect(res.body.map((m: { text: string }) => m.text)).toEqual(['hello', 'welcome!']);
  });

  it('returns only the latest messages when limited', async () => {
    const res = await ctx.http().get('/streams/chat-stream/messages?limit=1').set('x-user-id', viewer).expect(200);
    expect(res.body.map((m: { text: string }) => m.text)).toEqual(['welcome!']);
  });

  it('rejects empty and too long messages', async () => {
    await send(viewer, '   ').expect(400);
    await send(viewer, 'x'.repeat(301)).expect(400);
  });

  it('404s for an unknown live and 401s without a user', async () => {
    await send(viewer, 'hi', 'no-such-stream').expect(404);
    await ctx.http().post('/streams/chat-stream/messages').send({ text: 'hi' }).expect(401);
  });

  it('costs nothing', async () => {
    expect(await walletBalance(ctx, viewer)).toBe(0);
  });
});
