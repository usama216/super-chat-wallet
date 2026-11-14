import { Inject, Injectable } from '@nestjs/common';
import { assertSameRequest, requestHash } from '../common/idempotency';
import { DatabaseService, Queryable } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { credit, debit } from '../ledger/ledger.types';
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider';

export type PurchaseStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface Purchase {
  id: string;
  userId: string;
  amount: number;
  status: PurchaseStatus;
  providerChargeId: string | null;
  failureReason: string | null;
  createdAt: Date;
}

interface PurchaseRow extends Purchase {
  requestHash: string;
}

const PURCHASE_COLUMNS = `
  id, user_id AS "userId", amount, status,
  provider_charge_id AS "providerChargeId", failure_reason AS "failureReason",
  created_at AS "createdAt", request_hash AS "requestHash"`;

export interface PurchaseOutcome {
  purchase: Purchase;
  /** true when this was a retry and the earlier result was returned */
  replayed: boolean;
}

/**
 * Buying tokens happens in three steps rather than one transaction:
 *
 *  1. Insert a PENDING purchase. The unique (user_id, idempotency_key) means a retry gets
 *     the existing row instead of a new one.
 *  2. Charge the provider outside any DB transaction, so a slow network call never holds
 *     locks. The provider is idempotent by purchase id, so calling it twice is harmless.
 *  3. In one transaction, flip PENDING -> COMPLETED and post the ledger entries. The
 *     `WHERE status = 'PENDING'` lets only one request win, so tokens are credited once.
 *
 * If the process dies between steps the purchase stays PENDING, and a retry with the same
 * key picks it up from step 2.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  async purchase(userId: string, idempotencyKey: string, amount: number): Promise<PurchaseOutcome> {
    const hash = requestHash({ amount });

    // 1. claim the key. A concurrent duplicate waits on the unique index, then sees the conflict.
    const inserted = await this.db.query<PurchaseRow>(
      `INSERT INTO purchases (user_id, idempotency_key, request_hash, amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING ${PURCHASE_COLUMNS}`,
      [userId, idempotencyKey, hash, amount],
    );

    let row: PurchaseRow;
    let replayed = false;
    if (inserted.rows.length > 0) {
      row = inserted.rows[0];
    } else {
      row = await this.findByKey(this.db.pool, userId, idempotencyKey);
      assertSameRequest(row.requestHash, hash);
      replayed = true;
      if (row.status !== 'PENDING') {
        return { purchase: toPublic(row), replayed };
      }
      // still PENDING: an earlier attempt crashed or is in flight, carry on
    }

    // 2. charge (no transaction open)
    const charge = await this.payments.charge({
      idempotencyKey: row.id,
      userId,
      amount: row.amount,
    });

    // 3. finalize exactly once
    const finalRow = await this.db.transaction(async (tx) => {
      if (charge.status === 'declined') {
        const failed = await tx.query<PurchaseRow>(
          `UPDATE purchases SET status = 'FAILED', failure_reason = $2, updated_at = now()
            WHERE id = $1 AND status = 'PENDING'
            RETURNING ${PURCHASE_COLUMNS}`,
          [row.id, charge.reason],
        );
        return failed.rows[0] ?? (await this.findById(tx, row.id));
      }

      const completed = await tx.query<PurchaseRow>(
        `UPDATE purchases SET status = 'COMPLETED', provider_charge_id = $2, updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
          RETURNING ${PURCHASE_COLUMNS}`,
        [row.id, charge.chargeId],
      );
      if (completed.rows.length === 0) {
        // a concurrent duplicate already finished it
        return this.findById(tx, row.id);
      }

      const clearingId = await this.ledger.systemAccountId(tx, 'PAYMENT_CLEARING');
      const walletId = await this.ledger.userAccountId(tx, userId, 'USER_WALLET');
      await this.ledger.post(tx, 'PURCHASE', row.id, [
        debit(clearingId, row.amount),
        credit(walletId, row.amount),
      ]);
      return completed.rows[0];
    });

    return { purchase: toPublic(finalRow), replayed };
  }

  private async findByKey(q: Queryable, userId: string, key: string): Promise<PurchaseRow> {
    const { rows } = await q.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return rows[0];
  }

  private async findById(q: Queryable, id: string): Promise<PurchaseRow> {
    const { rows } = await q.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
}

function toPublic(row: PurchaseRow): Purchase {
  const { requestHash: _hidden, ...publicFields } = row;
  return publicFields;
}
