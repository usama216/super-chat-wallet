import {
  ADMIN_ID,
  buy,
  createStream,
  createTestApp,
  createUser,
  earningsBalance,
  expectLedgerInvariants,
  postingsFor,
  processPayout,
  requestPayout,
  reverseSuperChat,
  sendSuperChat,
  systemBalance,
  TestContext,
  walletBalance,
} from './helpers/test-app';
import { TestWsClient } from './helpers/ws-client';

/**
 * Admin reversal: full refund to the sender, exact clawback, idempotent under concurrency.
 */
describe('Admin Super Chat reversal', () => {
  let ctx: TestContext;

  /** creator + stream + viewer who already sent one Super Chat of `amount`. */
  async function scenario(amount: number, name: string) {
    const creator = await createUser(ctx, `${name}-creator`);
    const stream = await createStream(ctx, creator, `${name}-stream`);
    const viewer = await createUser(ctx, `${name}-viewer`);
    await buy(ctx, viewer, 1000, `${name}-topup`).expect(201);
    const sent = await sendSuperChat(ctx, viewer, stream, amount, `${name}-sc`).expect(201);
    return { creator, stream, viewer, superChat: sent.body };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await expectLedgerInvariants(ctx);
    await ctx.close();
  });

  it('refunds the sender in full and claws back the creator share and the platform fee', async () => {
    const feesBefore = await systemBalance(ctx, 'PLATFORM_FEES');
    const { creator, viewer, superChat } = await scenario(100, 'basic');
    expect(await walletBalance(ctx, viewer)).toBe(900);
    expect(await earningsBalance(ctx, creator)).toBe(80);

    const res = await reverseSuperChat(ctx, superChat.id).expect(200);

    expect(res.body).toMatchObject({ id: superChat.id, status: 'REVERSED' });
    expect(res.body.reversedAt).toBeTruthy();
    expect(await walletBalance(ctx, viewer)).toBe(1000); // full refund, fee included
    expect(await earningsBalance(ctx, creator)).toBe(0);
    expect(await systemBalance(ctx, 'PLATFORM_FEES')).toBe(feesBefore);
    expect(await postingsFor(ctx, 'SUPER_CHAT_REVERSAL', superChat.id)).toBe(1);
    // The original posting is still there: history is never rewritten.
    expect(await postingsFor(ctx, 'SUPER_CHAT', superChat.id)).toBe(1);
  });

  it('mirrors odd-amount splits exactly (7 = 5 creator + 2 platform)', async () => {
    const { creator, viewer, superChat } = await scenario(7, 'odd');
    await reverseSuperChat(ctx, superChat.id).expect(200);

    expect(await walletBalance(ctx, viewer)).toBe(1000);
    expect(await earningsBalance(ctx, creator)).toBe(0);

    // Per account, original + reversal sum to exactly 0.
    const { rows } = await ctx.db.query<{ account_id: string; net: number }>(
      `SELECT e.account_id, SUM(e.amount)::bigint AS net
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.reference_id = $1 GROUP BY e.account_id`,
      [superChat.id],
    );
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.net === 0)).toBe(true);
  });

  it('reversing twice refunds once', async () => {
    const { viewer, superChat } = await scenario(100, 'twice');

    await reverseSuperChat(ctx, superChat.id).expect(200);
    const again = await reverseSuperChat(ctx, superChat.id).expect(200);

    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await walletBalance(ctx, viewer)).toBe(1000); // not 1100
    expect(await postingsFor(ctx, 'SUPER_CHAT_REVERSAL', superChat.id)).toBe(1);
  });

  it('10 concurrent reversals of the same Super Chat refund exactly once', async () => {
    const { viewer, creator, superChat } = await scenario(100, 'race');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => reverseSuperChat(ctx, superChat.id)),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
    expect(await walletBalance(ctx, viewer)).toBe(1000);
    expect(await earningsBalance(ctx, creator)).toBe(0);
    expect(await postingsFor(ctx, 'SUPER_CHAT_REVERSAL', superChat.id)).toBe(1);
  });

  it('after the creator already withdrew, the viewer is still refunded and the creator goes negative', async () => {
    const { creator, viewer, superChat } = await scenario(100, 'clawback');
    const payout = await requestPayout(ctx, creator, 80, 'withdraw-all').expect(201);
    await processPayout(ctx, payout.body.id, 'paid').expect(200);
    expect(await earningsBalance(ctx, creator)).toBe(0);

    await reverseSuperChat(ctx, superChat.id).expect(200);

    expect(await walletBalance(ctx, viewer)).toBe(1000);
    expect(await earningsBalance(ctx, creator)).toBe(-80); // owes the platform 80

    // A creator in debt can't withdraw.
    const blocked = await requestPayout(ctx, creator, 1, 'while-negative').expect(402);
    expect(blocked.body.error).toBe('InsufficientFunds');
  });

  it('removes the Super Chat from the pinned list and notifies viewers live', async () => {
    const { stream, superChat } = await scenario(500, 'live');
    const watcher = await TestWsClient.connect(ctx.baseUrl);
    try {
      const joined = await watcher.subscribe(stream);
      expect(joined.data.pinned.map((s: { id: string }) => s.id)).toEqual([superChat.id]);

      await reverseSuperChat(ctx, superChat.id).expect(200);

      await watcher.waitFor(() => watcher.ofType('super_chat.reversed').length === 1);
      expect(watcher.ofType('super_chat.reversed')[0].data).toMatchObject({
        streamId: stream,
        superChatId: superChat.id,
      });
      const pinned = await ctx.http().get(`/streams/${stream}/pinned`).set('x-user-id', ADMIN_ID).expect(200);
      expect(pinned.body).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it('only admins can reverse', async () => {
    const { creator, viewer, superChat } = await scenario(100, 'authz');

    await reverseSuperChat(ctx, superChat.id, viewer).expect(403);
    await reverseSuperChat(ctx, superChat.id, creator).expect(403);
    await reverseSuperChat(ctx, '00000000-0000-0000-0000-000000000000').expect(404);
    await reverseSuperChat(ctx, 'not-a-uuid').expect(400);

    expect(await walletBalance(ctx, viewer)).toBe(900);
  });
});
