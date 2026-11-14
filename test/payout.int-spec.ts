import {
  ADMIN_ID,
  buy,
  createStream,
  createTestApp,
  createUser,
  earningsBalance,
  expectLedgerInvariants,
  processPayout,
  requestPayout,
  sendSuperChat,
  systemBalance,
  TestContext,
} from './helpers/test-app';

/**
 * Creator payouts: hold on request, idempotent, no double withdrawal, admin paid / reject.
 */
describe('Creator payouts', () => {
  let ctx: TestContext;

  /** A creator whose earnings are exactly `earned` tokens (from one Super Chat). */
  async function creatorWithEarnings(earned: number, name: string): Promise<string> {
    const creator = await createUser(ctx, `${name}-creator`);
    const stream = await createStream(ctx, creator, `${name}-stream`);
    const viewer = await createUser(ctx, `${name}-viewer`);
    const amount = (earned * 10_000) / 8_000; // earned must be a multiple of 4 for an exact 80%
    await buy(ctx, viewer, amount, `${name}-topup`).expect(201);
    await sendSuperChat(ctx, viewer, stream, amount, `${name}-sc`).expect(201);
    expect(await earningsBalance(ctx, creator)).toBe(earned);
    return creator;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await expectLedgerInvariants(ctx);
    await ctx.close();
  });

  it('a request moves the amount from earnings into the in-transit hold', async () => {
    const creator = await creatorWithEarnings(80, 'hold');
    const inTransitBefore = await systemBalance(ctx, 'PAYOUTS_IN_TRANSIT');

    const res = await requestPayout(ctx, creator, 50, 'p1').expect(201);

    expect(res.body).toMatchObject({ creatorId: creator, amount: 50, status: 'REQUESTED' });
    expect(await earningsBalance(ctx, creator)).toBe(30);
    expect((await systemBalance(ctx, 'PAYOUTS_IN_TRANSIT')) - inTransitBefore).toBe(50);

    const mine = await ctx.http().get('/payouts').set('x-user-id', creator).expect(200);
    expect(mine.body.map((p: { id: string }) => p.id)).toEqual([res.body.id]);
  });

  it('the same payout request sent twice holds the money once', async () => {
    const creator = await creatorWithEarnings(80, 'dup');

    const first = await requestPayout(ctx, creator, 40, 'same').expect(201);
    const second = await requestPayout(ctx, creator, 40, 'same').expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(await earningsBalance(ctx, creator)).toBe(40);
    await requestPayout(ctx, creator, 41, 'same').expect(422); // same key, different amount
  });

  it('earnings 80, 10 concurrent requests for 50: exactly one succeeds', async () => {
    const creator = await creatorWithEarnings(80, 'race');

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => requestPayout(ctx, creator, 50, `race-${i}`)),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 402)).toHaveLength(9);
    expect(await earningsBalance(ctx, creator)).toBe(30);
  });

  it('cannot request more than the earnings balance', async () => {
    const creator = await creatorWithEarnings(80, 'over');
    const res = await requestPayout(ctx, creator, 81, 'too-much').expect(402);
    expect(res.body.error).toBe('InsufficientFunds');
    expect(await earningsBalance(ctx, creator)).toBe(80);
  });

  it('marking paid releases the hold out of the platform; doing it twice is a no-op', async () => {
    const creator = await creatorWithEarnings(80, 'paid');
    const payout = (await requestPayout(ctx, creator, 80, 'all').expect(201)).body;
    const inTransitBefore = await systemBalance(ctx, 'PAYOUTS_IN_TRANSIT');
    const clearingBefore = await systemBalance(ctx, 'PAYMENT_CLEARING');

    const paid = await processPayout(ctx, payout.id, 'paid').expect(200);
    expect(paid.body).toMatchObject({ status: 'PAID', processedBy: ADMIN_ID });
    expect(inTransitBefore - (await systemBalance(ctx, 'PAYOUTS_IN_TRANSIT'))).toBe(80);
    expect(clearingBefore - (await systemBalance(ctx, 'PAYMENT_CLEARING'))).toBe(80);

    const again = await processPayout(ctx, payout.id, 'paid').expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(clearingBefore - (await systemBalance(ctx, 'PAYMENT_CLEARING'))).toBe(80);

    await processPayout(ctx, payout.id, 'reject').expect(409); // can't un-pay
    expect(await earningsBalance(ctx, creator)).toBe(0);
  });

  it('rejecting returns the held tokens to the creator', async () => {
    const creator = await creatorWithEarnings(80, 'reject');
    const payout = (await requestPayout(ctx, creator, 60, 'r').expect(201)).body;
    expect(await earningsBalance(ctx, creator)).toBe(20);

    await processPayout(ctx, payout.id, 'reject').expect(200);

    expect(await earningsBalance(ctx, creator)).toBe(80);
    await processPayout(ctx, payout.id, 'paid').expect(409);
  });

  it('"paid" and "reject" racing on the same payout: exactly one wins', async () => {
    const creator = await creatorWithEarnings(80, 'decide');
    const payout = (await requestPayout(ctx, creator, 80, 'd').expect(201)).body;

    const responses = await Promise.all([
      ...Array.from({ length: 5 }, () => processPayout(ctx, payout.id, 'paid')),
      ...Array.from({ length: 5 }, () => processPayout(ctx, payout.id, 'reject')),
    ]);

    const winners = responses.filter((r) => r.status === 200 && r.headers['idempotent-replayed'] !== 'true');
    expect(winners).toHaveLength(1);
    const final = winners[0].body.status;
    // Everyone asking for the winning state got 200, everyone asking for the other got 409.
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await earningsBalance(ctx, creator)).toBe(final === 'PAID' ? 0 : 80);
  });

  it('only admins can process payouts', async () => {
    const creator = await creatorWithEarnings(80, 'authz');
    const payout = (await requestPayout(ctx, creator, 10, 'a').expect(201)).body;

    await ctx.http().post(`/admin/payouts/${payout.id}/paid`).set('x-user-id', creator).expect(403);
    await ctx.http().get('/admin/payouts').set('x-user-id', creator).expect(403);

    const list = await ctx.http().get('/admin/payouts?status=REQUESTED').set('x-user-id', ADMIN_ID).expect(200);
    expect(list.body.some((p: { id: string }) => p.id === payout.id)).toBe(true);
  });
});
