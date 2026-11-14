import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { DatabaseService } from '../../src/database/database.service';
import { runMigrations } from '../../src/database/migrator';
import {
  ChargeRequest,
  ChargeResult,
  MockPaymentProvider,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../../src/wallet/payment-provider';

// Runs the real app (HTTP server, WebSocket, Postgres). Only the payment provider is faked.
// Each test file starts from an empty schema; tests create their own users.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://superchat:superchat@localhost:5433/superchat_test';

export const ADMIN_ID = '00000000-0000-0000-0000-00000000ad01';

/** Idempotent like the mock, but counts calls and can decline or throw (provider outage). */
export class TestPaymentProvider implements PaymentProvider {
  private readonly inner = new MockPaymentProvider();
  mode: 'approve' | 'decline' | 'throw' = 'approve';
  calls = 0;
  readonly chargeIds = new Set<string>();

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    this.calls++;
    if (this.mode === 'throw') throw new Error('payment provider unavailable');
    if (this.mode === 'decline') return { status: 'declined', reason: 'card_declined' };
    const result = await this.inner.charge(req);
    if (result.status === 'succeeded') this.chargeIds.add(result.chargeId);
    return result;
  }
}

export interface TestContext {
  app: INestApplication;
  db: DatabaseService;
  payments: TestPaymentProvider;
  baseUrl: string;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

// creates superchat_test next to the app database if it doesn't exist yet
async function ensureTestDatabase(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/superchat';
  const admin = new Pool({ connectionString: url.toString() });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

export async function resetDatabase(): Promise<void> {
  await ensureTestDatabase();
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    // the ledger blocks DELETE/TRUNCATE, so drop the whole schema instead
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

export async function createTestApp(): Promise<TestContext> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  await resetDatabase();

  const payments = new TestPaymentProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(payments)
    .compile();

  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  // real port so concurrent requests hit one server and WebSocket clients can connect
  await app.listen(0);
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    db: app.get(DatabaseService),
    payments,
    baseUrl,
    http: () => request(baseUrl),
    close: () => app.close(),
  };
}

// ---- API helpers ----

export async function createUser(ctx: TestContext, displayName = 'user'): Promise<string> {
  const res = await ctx.http().post('/users').send({ displayName }).expect(201);
  return res.body.id;
}

export function buy(ctx: TestContext, userId: string, amount: number, key: string) {
  return ctx
    .http()
    .post('/wallet/purchases')
    .set('x-user-id', userId)
    .set('Idempotency-Key', key)
    .send({ amount });
}

export async function createStream(ctx: TestContext, creatorId: string, streamId: string) {
  await ctx.http().post('/streams').set('x-user-id', creatorId).send({ id: streamId }).expect(201);
  return streamId;
}

export function sendSuperChat(
  ctx: TestContext,
  senderId: string,
  streamId: string,
  amount: number,
  key: string,
  message = `hello ${key}`,
) {
  return ctx
    .http()
    .post(`/streams/${streamId}/super-chats`)
    .set('x-user-id', senderId)
    .set('Idempotency-Key', key)
    .send({ message, amount });
}

export function reverseSuperChat(ctx: TestContext, superChatId: string, adminId = ADMIN_ID) {
  return ctx
    .http()
    .post(`/admin/super-chats/${superChatId}/reversal`)
    .set('x-user-id', adminId)
    .send({ reason: 'test reversal' });
}

export function requestPayout(ctx: TestContext, creatorId: string, amount: number, key: string) {
  return ctx
    .http()
    .post('/payouts')
    .set('x-user-id', creatorId)
    .set('Idempotency-Key', key)
    .send({ amount });
}

export function processPayout(ctx: TestContext, payoutId: string, action: 'paid' | 'reject') {
  return ctx.http().post(`/admin/payouts/${payoutId}/${action}`).set('x-user-id', ADMIN_ID).send();
}

/** System account balance (PLATFORM_FEES etc.), straight from the ledger. */
export async function systemBalance(ctx: TestContext, type: string): Promise<number> {
  const { rows } = await ctx.db.query<{ balance: number }>(
    'SELECT account_balance(id) AS balance FROM accounts WHERE type = $1 AND owner_id IS NULL',
    [type],
  );
  return rows[0].balance;
}

export async function walletBalance(ctx: TestContext, userId: string): Promise<number> {
  const res = await ctx.http().get('/me').set('x-user-id', userId).expect(200);
  return res.body.balances.wallet;
}

export async function earningsBalance(ctx: TestContext, userId: string): Promise<number> {
  const res = await ctx.http().get('/me').set('x-user-id', userId).expect(200);
  return res.body.balances.earnings;
}

/** Number of ledger transactions of a kind that reference a given business object. */
export async function postingsFor(ctx: TestContext, kind: string, referenceId: string) {
  const { rows } = await ctx.db.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = $1 AND reference_id = $2',
    [kind, referenceId],
  );
  return rows[0].n;
}

// Checked at the end of each integration file: the whole ledger sums to 0, every
// transaction sums to 0, and no wallet is negative.
export async function expectLedgerInvariants(ctx: TestContext): Promise<void> {
  const total = await ctx.db.query<{ sum: number }>(
    'SELECT COALESCE(SUM(amount), 0)::bigint AS sum FROM ledger_entries',
  );
  expect(total.rows[0].sum).toBe(0);

  const unbalanced = await ctx.db.query(
    'SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount) <> 0',
  );
  expect(unbalanced.rows).toEqual([]);

  const negativeWallets = await ctx.db.query(
    `SELECT id FROM accounts WHERE type = 'USER_WALLET' AND account_balance(id) < 0`,
  );
  expect(negativeWallets.rows).toEqual([]);
}
