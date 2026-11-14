import {
  buy,
  createTestApp,
  createUser,
  expectLedgerInvariants,
  postingsFor,
  TestContext,
  walletBalance,
} from './helpers/test-app';

/**
 * Token purchase: correctness + IDEMPOTENCY ("the same request sent twice charges once").
 */
describe('Token purchase (idempotent)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await expectLedgerInvariants(ctx);
    await ctx.close();
  });

  beforeEach(() => {
    ctx.payments.mode = 'approve';
  });

  it('credits the wallet through a balanced ledger posting', async () => {
    const alice = await createUser(ctx, 'alice');

    const res = await buy(ctx, alice, 500, 'buy-1').expect(201);

    expect(res.body).toMatchObject({ amount: 500, status: 'COMPLETED' });
    expect(res.body.providerChargeId).toMatch(/^mock_ch_/);
    expect(res.body.requestHash).toBeUndefined(); // internal field never leaks
    expect(await walletBalance(ctx, alice)).toBe(500);

    // Exactly one ledger transaction, and it moved 500 from clearing to the wallet.
    expect(await postingsFor(ctx, 'PURCHASE', res.body.id)).toBe(1);
    const { rows } = await ctx.db.query<{ type: string; amount: number }>(
      `SELECT a.type, e.amount FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
         JOIN accounts a ON a.id = e.account_id
        WHERE t.reference_id = $1 ORDER BY e.amount DESC`,
      [res.body.id],
    );
    expect(rows).toEqual([
      { type: 'PAYMENT_CLEARING', amount: 500 }, // debit
      { type: 'USER_WALLET', amount: -500 }, // credit
    ]);
  });

  it('the same request sent twice charges once', async () => {
    const bob = await createUser(ctx, 'bob');
    const callsBefore = ctx.payments.calls;

    const first = await buy(ctx, bob, 300, 'bob-key').expect(201);
    const second = await buy(ctx, bob, 300, 'bob-key').expect(200);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body); // identical result, same purchase id
    expect(await walletBalance(ctx, bob)).toBe(300); // not 600
    expect(await postingsFor(ctx, 'PURCHASE', first.body.id)).toBe(1);
    // A finished purchase is answered from the database; the provider isn't even called again.
    expect(ctx.payments.calls - callsBefore).toBe(1);
  });

  it('20 identical requests fired at the same time still charge once', async () => {
    const carol = await createUser(ctx, 'carol');
    const chargesBefore = ctx.payments.chargeIds.size;

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => buy(ctx, carol, 250, 'carol-burst')),
    );

    // Every caller got a successful answer about the SAME purchase...
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(responses.every((r) => r.body.status === 'COMPLETED')).toBe(true);
    // ...exactly one of them created it (201), the rest were replays (200)...
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
    // ...and money moved exactly once: one card charge, one ledger posting, balance 250.
    expect(ctx.payments.chargeIds.size - chargesBefore).toBe(1);
    expect(await postingsFor(ctx, 'PURCHASE', [...ids][0])).toBe(1);
    expect(await walletBalance(ctx, carol)).toBe(250);
  });

  it('rejects reusing a key with a different amount (422) and changes nothing', async () => {
    const dave = await createUser(ctx, 'dave');
    await buy(ctx, dave, 100, 'dave-key').expect(201);

    const res = await buy(ctx, dave, 999, 'dave-key').expect(422);

    expect(res.body.message).toMatch(/different request body/);
    expect(await walletBalance(ctx, dave)).toBe(100);
  });

  it('idempotency keys are scoped per user', async () => {
    const erin = await createUser(ctx, 'erin');
    const frank = await createUser(ctx, 'frank');

    const a = await buy(ctx, erin, 10, 'shared-key').expect(201);
    const b = await buy(ctx, frank, 10, 'shared-key').expect(201);

    expect(a.body.id).not.toBe(b.body.id);
    expect(await walletBalance(ctx, erin)).toBe(10);
    expect(await walletBalance(ctx, frank)).toBe(10);
  });

  it('different keys are different purchases, even when concurrent (no lost updates)', async () => {
    const gina = await createUser(ctx, 'gina');

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => buy(ctx, gina, 10, `gina-${i}`)),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(await walletBalance(ctx, gina)).toBe(200);
  });

  it('a declined payment records FAILED, credits nothing, and a retry stays FAILED', async () => {
    const hank = await createUser(ctx, 'hank');
    ctx.payments.mode = 'decline';

    const res = await buy(ctx, hank, 100, 'hank-key').expect(201);
    expect(res.body).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
    expect(await postingsFor(ctx, 'PURCHASE', res.body.id)).toBe(0);

    // Even if the card would work now, the SAME key means the SAME (failed) attempt.
    // The client must use a new key for a new attempt.
    ctx.payments.mode = 'approve';
    const retry = await buy(ctx, hank, 100, 'hank-key').expect(200);
    expect(retry.body.status).toBe('FAILED');
    expect(await walletBalance(ctx, hank)).toBe(0);
  });

  it('recovers from a provider outage: purchase stays PENDING, the retry completes it once', async () => {
    const ivy = await createUser(ctx, 'ivy');
    ctx.payments.mode = 'throw';

    await buy(ctx, ivy, 70, 'ivy-key').expect(500);
    const pending = await ctx.db.query<{ status: string }>(
      `SELECT status FROM purchases WHERE idempotency_key = 'ivy-key'`,
    );
    expect(pending.rows[0].status).toBe('PENDING');
    expect(await walletBalance(ctx, ivy)).toBe(0);

    ctx.payments.mode = 'approve';
    const retry = await buy(ctx, ivy, 70, 'ivy-key').expect(200);
    expect(retry.body.status).toBe('COMPLETED');
    expect(await walletBalance(ctx, ivy)).toBe(70);

    // And retrying once more changes nothing.
    await buy(ctx, ivy, 70, 'ivy-key').expect(200);
    expect(await walletBalance(ctx, ivy)).toBe(70);
  });

  it('validates input', async () => {
    const jack = await createUser(ctx, 'jack');

    await ctx.http().post('/wallet/purchases').set('x-user-id', jack).send({ amount: 10 }).expect(400); // no key
    await buy(ctx, jack, 0, 'k1').expect(400);
    await buy(ctx, jack, -5, 'k2').expect(400);
    await buy(ctx, jack, 1.5, 'k3').expect(400);
    await buy(ctx, jack, 1_000_001, 'k4').expect(400);
    await ctx
      .http()
      .post('/wallet/purchases')
      .set('Idempotency-Key', 'k5')
      .send({ amount: 10 })
      .expect(401); // no user
    expect(await walletBalance(ctx, jack)).toBe(0);
  });
});
