import {
  buy,
  createStream,
  createTestApp,
  createUser,
  earningsBalance,
  expectLedgerInvariants,
  postingsFor,
  sendSuperChat,
  systemBalance,
  TestContext,
  walletBalance,
} from './helpers/test-app';

/**
 * Sending Super Chats: money split, IDEMPOTENCY, and NO DOUBLE SPENDING under concurrency.
 */
describe('Super Chat send', () => {
  let ctx: TestContext;
  let creator: string;
  let stream: string;

  /** A fresh viewer holding `tokens` in their wallet. */
  async function viewerWith(tokens: number, name = 'viewer'): Promise<string> {
    const id = await createUser(ctx, name);
    if (tokens > 0) await buy(ctx, id, tokens, `topup-${id}`).expect(201);
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    creator = await createUser(ctx, 'creator');
    stream = await createStream(ctx, creator, 'main-stream');
  });

  afterAll(async () => {
    await expectLedgerInvariants(ctx);
    await ctx.close();
  });

  it('moves the amount from the viewer: 80% to the creator, 20% to the platform', async () => {
    const viewer = await viewerWith(1000);
    const earningsBefore = await earningsBalance(ctx, creator);
    const feesBefore = await systemBalance(ctx, 'PLATFORM_FEES');

    const res = await sendSuperChat(ctx, viewer, stream, 100, 'sc-1', 'great stream!').expect(201);

    expect(res.body).toMatchObject({
      streamId: stream,
      senderId: viewer,
      creatorId: creator, // recipient comes from the stream, not from the client
      message: 'great stream!',
      amount: 100,
      creatorAmount: 80,
      platformFee: 20,
      status: 'COMPLETED',
    });
    expect(await walletBalance(ctx, viewer)).toBe(900);
    expect((await earningsBalance(ctx, creator)) - earningsBefore).toBe(80);
    expect((await systemBalance(ctx, 'PLATFORM_FEES')) - feesBefore).toBe(20);
    expect(await postingsFor(ctx, 'SUPER_CHAT', res.body.id)).toBe(1);
  });

  it('rounds odd amounts in a documented way: creator gets floor(80%), platform the rest', async () => {
    const viewer = await viewerWith(7);
    const res = await sendSuperChat(ctx, viewer, stream, 7, 'odd').expect(201);
    expect(res.body).toMatchObject({ amount: 7, creatorAmount: 5, platformFee: 2 });
    expect(await walletBalance(ctx, viewer)).toBe(0);
  });

  describe('idempotency', () => {
    it('the same request sent twice charges once', async () => {
      const viewer = await viewerWith(500);

      const first = await sendSuperChat(ctx, viewer, stream, 100, 'dup').expect(201);
      const second = await sendSuperChat(ctx, viewer, stream, 100, 'dup').expect(200);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await walletBalance(ctx, viewer)).toBe(400); // charged once, not twice
      expect(await postingsFor(ctx, 'SUPER_CHAT', first.body.id)).toBe(1);
    });

    it('20 identical requests fired at the same time charge once', async () => {
      const viewer = await viewerWith(500);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => sendSuperChat(ctx, viewer, stream, 100, 'burst')),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(await walletBalance(ctx, viewer)).toBe(400);

      const { rows } = await ctx.db.query(
        `SELECT id FROM super_chats WHERE sender_id = $1 AND idempotency_key = 'burst'`,
        [viewer],
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects reusing a key with a different body (422) and charges nothing more', async () => {
      const viewer = await viewerWith(500);
      await sendSuperChat(ctx, viewer, stream, 100, 'reuse', 'first').expect(201);

      await sendSuperChat(ctx, viewer, stream, 100, 'reuse', 'different message').expect(422);
      await sendSuperChat(ctx, viewer, stream, 200, 'reuse', 'first').expect(422);

      expect(await walletBalance(ctx, viewer)).toBe(400);
    });
  });

  describe('no double spending', () => {
    it('balance 100, 20 concurrent sends of 30 each: exactly 3 succeed, balance ends at 10', async () => {
      const viewer = await viewerWith(100);
      const earningsBefore = await earningsBalance(ctx, creator);

      // 20 DIFFERENT keys = 20 genuinely different spend attempts, all at once.
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => sendSuperChat(ctx, viewer, stream, 30, `race-${i}`)),
      );

      const ok = responses.filter((r) => r.status === 201);
      const rejected = responses.filter((r) => r.status === 402);
      expect(ok).toHaveLength(3); // 3 * 30 = 90 <= 100; a 4th would need 120
      expect(rejected).toHaveLength(17);
      // Every rejection is a clean "insufficient funds" from the wallet lock + balance check,
      // NOT a 500 from the database safety-net trigger. That proves the application-level lock
      // did the work.
      expect(rejected.every((r) => r.body.error === 'InsufficientFunds')).toBe(true);

      expect(await walletBalance(ctx, viewer)).toBe(10);
      expect((await earningsBalance(ctx, creator)) - earningsBefore).toBe(3 * 24);
    });

    it('a wallet can never go below zero, across many viewers spending at once', async () => {
      // 10 viewers with 50 tokens each; each fires 10 concurrent sends of 20 (100 attempts total).
      const viewers = await Promise.all(Array.from({ length: 10 }, (_, i) => viewerWith(50, `v${i}`)));

      const responses = await Promise.all(
        viewers.flatMap((v) =>
          Array.from({ length: 10 }, (_, i) => sendSuperChat(ctx, v, stream, 20, `multi-${i}`)),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(10 * 2); // 2 per viewer
      expect(responses.filter((r) => r.status === 402)).toHaveLength(10 * 8);
      for (const v of viewers) {
        expect(await walletBalance(ctx, v)).toBe(10);
      }
    });

    it('insufficient funds changes nothing and does not use up a stream position', async () => {
      const viewer = await viewerWith(10);
      const before = await ctx.db.query<{ lastSeq: number }>(
        'SELECT last_seq AS "lastSeq" FROM streams WHERE id = $1',
        [stream],
      );

      const res = await sendSuperChat(ctx, viewer, stream, 11, 'too-much').expect(402);

      expect(res.body.error).toBe('InsufficientFunds');
      expect(await walletBalance(ctx, viewer)).toBe(10);
      const after = await ctx.db.query<{ lastSeq: number }>(
        'SELECT last_seq AS "lastSeq" FROM streams WHERE id = $1',
        [stream],
      );
      expect(after.rows[0].lastSeq).toBe(before.rows[0].lastSeq);
    });
  });

  it('gives every Super Chat on a stream a unique, gap-free sequence number under concurrency', async () => {
    const creator2 = await createUser(ctx, 'creator2');
    const ordered = await createStream(ctx, creator2, 'ordered-stream');
    const viewers = await Promise.all(Array.from({ length: 15 }, (_, i) => viewerWith(10, `o${i}`)));

    await Promise.all(viewers.map((v, i) => sendSuperChat(ctx, v, ordered, 10, `o-${i}`).expect(201)));

    const list = await ctx.http().get(`/streams/${ordered}/super-chats`).set('x-user-id', creator2).expect(200);
    expect(list.body.map((s: { streamSeq: number }) => s.streamSeq)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
  });

  it('pins bigger amounts for longer, and lists pinned chats biggest first', async () => {
    const creator3 = await createUser(ctx, 'creator3');
    const pinStream = await createStream(ctx, creator3, 'pin-stream');
    const viewer = await viewerWith(10_000);

    const small = await sendSuperChat(ctx, viewer, pinStream, 10, 'p-small').expect(201);
    const big = await sendSuperChat(ctx, viewer, pinStream, 5_000, 'p-big').expect(201);
    const mid = await sendSuperChat(ctx, viewer, pinStream, 200, 'p-mid').expect(201);

    const pinnedFor = (r: { body: { createdAt: string; pinnedUntil: string } }) =>
      (Date.parse(r.body.pinnedUntil) - Date.parse(r.body.createdAt)) / 1000;
    expect(pinnedFor(small)).toBe(30);
    expect(pinnedFor(mid)).toBe(300);
    expect(pinnedFor(big)).toBe(3600);

    const pinned = await ctx.http().get(`/streams/${pinStream}/pinned`).set('x-user-id', viewer).expect(200);
    expect(pinned.body.map((s: { amount: number }) => s.amount)).toEqual([5_000, 200, 10]);
  });

  it('rejects invalid requests', async () => {
    const viewer = await viewerWith(100);

    await sendSuperChat(ctx, viewer, 'no-such-stream', 10, 'x1').expect(404);
    await sendSuperChat(ctx, creator, stream, 10, 'x2').expect(400); // own stream
    await sendSuperChat(ctx, viewer, stream, 0, 'x3').expect(400);
    await sendSuperChat(ctx, viewer, stream, 2.5, 'x4').expect(400);
    await sendSuperChat(ctx, viewer, stream, 10, 'x5', '').expect(400);
    await sendSuperChat(ctx, viewer, stream, 10, 'x6', 'a'.repeat(501)).expect(400);
    await ctx
      .http()
      .post(`/streams/${stream}/super-chats`)
      .set('x-user-id', viewer)
      .send({ message: 'hi', amount: 10 })
      .expect(400); // missing Idempotency-Key

    expect(await walletBalance(ctx, viewer)).toBe(100);
  });
});
