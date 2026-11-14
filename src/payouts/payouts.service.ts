import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InsufficientFundsException } from '../common/errors';
import { assertSameRequest, requestHash } from '../common/idempotency';
import { DatabaseService, Queryable } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { credit, debit } from '../ledger/ledger.types';

export type PayoutStatus = 'REQUESTED' | 'PAID' | 'REJECTED';

export interface Payout {
  id: string;
  creatorId: string;
  amount: number;
  status: PayoutStatus;
  processedAt: Date | null;
  processedBy: string | null;
  createdAt: Date;
}

interface PayoutRow extends Payout {
  requestHash: string;
}

const PAYOUT_COLUMNS = `
  id, creator_id AS "creatorId", amount, status, processed_at AS "processedAt",
  processed_by AS "processedBy", created_at AS "createdAt", request_hash AS "requestHash"`;

/**
 * Payouts: REQUESTED -> PAID | REJECTED
 *   request : earnings -> payouts in transit   (held right away, so it can't be requested twice)
 *   paid    : in transit -> payment clearing   (money leaves the platform)
 *   reject  : in transit -> earnings           (hold released)
 *
 * "Admin marks paid" stands in for a payout provider's confirmation webhook.
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // Same pattern as sending a super chat: lock, idempotency check, balance check, post.
  async request(creatorId: string, idempotencyKey: string, amount: number) {
    const hash = requestHash({ amount });

    return this.db.transaction(async (tx) => {
      const earningsId = await this.ledger.userAccountId(tx, creatorId, 'CREATOR_EARNINGS');
      await this.ledger.lockAccount(tx, earningsId);

      const existing = await tx.query<PayoutRow>(
        `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE creator_id = $1 AND idempotency_key = $2`,
        [creatorId, idempotencyKey],
      );
      if (existing.rows[0]) {
        assertSameRequest(existing.rows[0].requestHash, hash);
        return { payout: toPublic(existing.rows[0]), replayed: true };
      }

      const balance = await this.ledger.balanceOf(tx, earningsId);
      if (balance < amount) {
        throw new InsufficientFundsException(balance, amount);
      }

      const inserted = await tx.query<PayoutRow>(
        `INSERT INTO payouts (creator_id, idempotency_key, request_hash, amount)
         VALUES ($1, $2, $3, $4)
         RETURNING ${PAYOUT_COLUMNS}`,
        [creatorId, idempotencyKey, hash, amount],
      );
      const payout = inserted.rows[0];

      const inTransitId = await this.ledger.systemAccountId(tx, 'PAYOUTS_IN_TRANSIT');
      await this.ledger.post(tx, 'PAYOUT_REQUEST', payout.id, [
        debit(earningsId, amount),
        credit(inTransitId, amount),
      ]);
      return { payout: toPublic(payout), replayed: false };
    });
  }

  // Asking for the state it's already in is a no-op; asking for the other final state is 409.
  // The row lock stops "paid" and "reject" from both winning.
  async process(adminId: string, payoutId: string, decision: 'PAID' | 'REJECTED') {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<PayoutRow>(
        `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1 FOR UPDATE`,
        [payoutId],
      );
      const payout = locked.rows[0];
      if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);
      if (payout.status === decision) {
        return { payout: toPublic(payout), replayed: true };
      }
      if (payout.status !== 'REQUESTED') {
        throw new ConflictException(`Payout is already ${payout.status}`);
      }

      const inTransitId = await this.ledger.systemAccountId(tx, 'PAYOUTS_IN_TRANSIT');
      if (decision === 'PAID') {
        const clearingId = await this.ledger.systemAccountId(tx, 'PAYMENT_CLEARING');
        await this.ledger.post(tx, 'PAYOUT_PAID', payout.id, [
          debit(inTransitId, payout.amount),
          credit(clearingId, payout.amount),
        ]);
      } else {
        const earningsId = await this.ledger.userAccountId(tx, payout.creatorId, 'CREATOR_EARNINGS');
        await this.ledger.post(tx, 'PAYOUT_REJECTED', payout.id, [
          debit(inTransitId, payout.amount),
          credit(earningsId, payout.amount),
        ]);
      }

      const updated = await tx.query<PayoutRow>(
        `UPDATE payouts SET status = $2, processed_at = now(), processed_by = $3
          WHERE id = $1
          RETURNING ${PAYOUT_COLUMNS}`,
        [payout.id, decision, adminId],
      );
      return { payout: toPublic(updated.rows[0]), replayed: false };
    });
  }

  async listForCreator(q: Queryable, creatorId: string): Promise<Payout[]> {
    const { rows } = await q.query<PayoutRow>(
      `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE creator_id = $1 ORDER BY created_at DESC`,
      [creatorId],
    );
    return rows.map(toPublic);
  }

  async list(status?: PayoutStatus): Promise<Payout[]> {
    const { rows } = await this.db.query<PayoutRow>(
      `SELECT ${PAYOUT_COLUMNS} FROM payouts
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at ASC`,
      [status ?? null],
    );
    return rows.map(toPublic);
  }
}

function toPublic(row: PayoutRow): Payout {
  const { requestHash: _hidden, ...rest } = row;
  return rest;
}
