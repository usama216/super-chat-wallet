import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Queryable } from '../database/database.service';
import { LedgerKind, PostingLine, SystemAccountType, UserAccountType } from './ledger.types';

/**
 * The only code that writes to the ledger.
 *
 * Methods take a Queryable instead of opening their own transaction: the caller owns the
 * transaction because it knows what has to commit together (e.g. "purchase COMPLETED" and
 * its ledger entries).
 */
@Injectable()
export class LedgerService {
  // System account ids never change after the migration, so cache them.
  private readonly systemAccountIds = new Map<SystemAccountType, string>();

  async systemAccountId(q: Queryable, type: SystemAccountType): Promise<string> {
    const cached = this.systemAccountIds.get(type);
    if (cached) return cached;
    const { rows } = await q.query<{ id: string }>(
      'SELECT id FROM accounts WHERE type = $1 AND owner_id IS NULL',
      [type],
    );
    if (rows.length === 0) {
      throw new InternalServerErrorException(`System account ${type} is missing`);
    }
    this.systemAccountIds.set(type, rows[0].id);
    return rows[0].id;
  }

  async userAccountId(q: Queryable, userId: string, type: UserAccountType): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      'SELECT id FROM accounts WHERE owner_id = $1 AND type = $2',
      [userId, type],
    );
    if (rows.length === 0) {
      throw new InternalServerErrorException(`User ${userId} has no ${type} account`);
    }
    return rows[0].id;
  }

  /**
   * Row-locks an account until the transaction ends. This is the double-spend protection:
   * every spend locks the account first, then reads the balance, then posts. A concurrent
   * spend on the same account waits here and then sees the updated balance. Spends on
   * different accounts don't block each other.
   */
  async lockAccount(q: Queryable, accountId: string): Promise<void> {
    await q.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  }

  async balanceOf(q: Queryable, accountId: string): Promise<number> {
    const { rows } = await q.query<{ balance: number }>(
      'SELECT account_balance($1) AS balance',
      [accountId],
    );
    return rows[0]?.balance ?? 0;
  }

  /**
   * Writes one balanced transaction (header + entries). Checked here for a clear error, and
   * again by the database triggers at commit.
   */
  async post(
    q: Queryable,
    kind: LedgerKind,
    referenceId: string,
    lines: PostingLine[],
  ): Promise<string> {
    if (lines.length < 2) {
      throw new InternalServerErrorException('A ledger posting needs at least 2 lines');
    }
    let sum = 0;
    for (const line of lines) {
      if (!Number.isSafeInteger(line.amount) || line.amount === 0) {
        throw new InternalServerErrorException(`Invalid ledger amount ${line.amount}`);
      }
      sum += line.amount;
    }
    if (sum !== 0) {
      throw new InternalServerErrorException(`Unbalanced posting for ${kind}: sum is ${sum}`);
    }

    const { rows } = await q.query<{ id: string }>(
      'INSERT INTO ledger_transactions (kind, reference_id) VALUES ($1, $2) RETURNING id',
      [kind, referenceId],
    );
    const transactionId = rows[0].id;

    // One multi-row insert: VALUES ($1,$2,$3), ($1,$4,$5), ...
    const values: string[] = [];
    const params: unknown[] = [transactionId];
    for (const line of lines) {
      params.push(line.accountId, line.amount);
      values.push(`($1, $${params.length - 1}, $${params.length})`);
    }
    await q.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ${values.join(', ')}`,
      params,
    );
    return transactionId;
  }

  /**
   * Posts the exact negation of an earlier posting. Mirroring the stored entries (rather
   * than recomputing the split) means the reversal undoes exactly what happened, even if
   * the fee rate changed since.
   */
  async postReversal(
    q: Queryable,
    originalKind: LedgerKind,
    referenceId: string,
    reversalKind: LedgerKind,
  ): Promise<string> {
    const { rows } = await q.query<{ accountId: string; amount: number }>(
      `SELECT e.account_id AS "accountId", e.amount
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.kind = $1 AND t.reference_id = $2
        ORDER BY e.id`,
      [originalKind, referenceId],
    );
    if (rows.length === 0) {
      throw new InternalServerErrorException(`No ${originalKind} posting found for ${referenceId}`);
    }
    return this.post(
      q,
      reversalKind,
      referenceId,
      rows.map((r) => ({ accountId: r.accountId, amount: -r.amount })),
    );
  }

  /** Latest entries of an account, signed from the owner's point of view (+ in, - out). */
  async statement(q: Queryable, accountId: string, limit = 50) {
    const { rows } = await q.query<{
      entryId: number;
      transactionId: string;
      kind: LedgerKind;
      referenceId: string;
      amount: number;
      createdAt: Date;
    }>(
      `SELECT e.id AS "entryId",
              t.id AS "transactionId",
              t.kind,
              t.reference_id AS "referenceId",
              e.amount * CASE a.normal_side WHEN 'DEBIT' THEN 1 ELSE -1 END AS amount,
              e.created_at AS "createdAt"
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
         JOIN accounts a ON a.id = e.account_id
        WHERE e.account_id = $1
        ORDER BY e.id DESC
        LIMIT $2`,
      [accountId, limit],
    );
    return rows;
  }
}
