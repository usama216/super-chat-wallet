import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { InsufficientFundsException } from '../common/errors';
import { assertSameRequest, requestHash } from '../common/idempotency';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { DatabaseService, Queryable } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { credit, debit, PostingLine } from '../ledger/ledger.types';
import { publishStreamEvent } from '../realtime/stream-events';
import { splitFee } from './fee-policy';
import { pinDurationSeconds } from './pin-policy';

export interface SuperChat {
  id: string;
  streamId: string;
  senderId: string;
  creatorId: string;
  message: string;
  amount: number;
  platformFee: number;
  creatorAmount: number;
  streamSeq: number;
  pinnedUntil: Date;
  status: 'COMPLETED' | 'REVERSED';
  createdAt: Date;
  reversedAt: Date | null;
}

interface SuperChatRow extends SuperChat {
  requestHash: string;
}

export const SUPER_CHAT_COLUMNS = `
  id, stream_id AS "streamId", sender_id AS "senderId", creator_id AS "creatorId",
  message, amount, platform_fee AS "platformFee", creator_amount AS "creatorAmount",
  stream_seq AS "streamSeq", pinned_until AS "pinnedUntil", status,
  created_at AS "createdAt", reversed_at AS "reversedAt", request_hash AS "requestHash"`;

export interface SendSuperChatInput {
  streamId: string;
  message: string;
  amount: number;
}

export interface SendOutcome {
  superChat: SuperChat;
  replayed: boolean;
}

@Injectable()
export class SuperChatsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Sends a super chat in one transaction:
   *
   *  1. Lock the sender's wallet. Other spends from this wallet wait until we commit, which
   *     prevents double spending and also makes the idempotency check below race-free
   *     (a duplicate request is just another spend from the same wallet).
   *  2. If this Idempotency-Key was already used, return the existing super chat.
   *  3. Validate the stream and check the balance (402 if short; nothing is written).
   *  4. Take the next stream seq. This locks the stream row, so super chats on a stream
   *     commit in seq order. It comes after the balance check so a failing request never
   *     holds the stream lock.
   *  5. Insert the super chat and post: debit wallet, credit creator, credit platform.
   *  6. pg_notify the event; Postgres only delivers it if we commit.
   *
   * Lock order is always wallet -> stream. Credited accounts aren't locked (a credit can't
   * overdraw anything), so no two flows take locks in opposite order.
   */
  async send(senderId: string, idempotencyKey: string, input: SendSuperChatInput): Promise<SendOutcome> {
    const hash = requestHash({ streamId: input.streamId, message: input.message, amount: input.amount });

    return this.db.transaction(async (tx) => {
      // 1
      const walletId = await this.ledger.userAccountId(tx, senderId, 'USER_WALLET');
      await this.ledger.lockAccount(tx, walletId);

      // 2
      const existing = await this.findByKey(tx, senderId, idempotencyKey);
      if (existing) {
        assertSameRequest(existing.requestHash, hash);
        return { superChat: toPublic(existing), replayed: true };
      }

      // 3
      const stream = await tx.query<{ creatorId: string }>(
        'SELECT creator_id AS "creatorId" FROM streams WHERE id = $1',
        [input.streamId],
      );
      if (stream.rows.length === 0) {
        throw new NotFoundException(`Stream ${input.streamId} not found`);
      }
      const creatorId = stream.rows[0].creatorId;
      if (creatorId === senderId) {
        throw new BadRequestException('You cannot send a Super Chat to your own stream');
      }

      const balance = await this.ledger.balanceOf(tx, walletId);
      if (balance < input.amount) {
        throw new InsufficientFundsException(balance, input.amount);
      }

      // 4
      const seq = await tx.query<{ lastSeq: number }>(
        'UPDATE streams SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq AS "lastSeq"',
        [input.streamId],
      );
      const streamSeq = seq.rows[0].lastSeq;

      // 5
      const split = splitFee(input.amount, this.config.platformFeeBps);
      const pinSeconds = pinDurationSeconds(input.amount);

      const inserted = await tx.query<SuperChatRow>(
        `INSERT INTO super_chats
           (stream_id, sender_id, creator_id, idempotency_key, request_hash, message, amount,
            fee_bps, platform_fee, creator_amount, stream_seq, pinned_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(secs => $12))
         RETURNING ${SUPER_CHAT_COLUMNS}`,
        [
          input.streamId, senderId, creatorId, idempotencyKey, hash, input.message, input.amount,
          split.feeBps, split.platformFee, split.creatorAmount, streamSeq, pinSeconds,
        ],
      );
      const superChat = inserted.rows[0];

      await this.ledger.post(
        tx,
        'SUPER_CHAT',
        superChat.id,
        await this.postingLines(tx, walletId, creatorId, split.creatorAmount, split.platformFee),
      );

      // 6
      const publicSuperChat = toPublic(superChat);
      await publishStreamEvent(tx, {
        type: 'super_chat.created',
        streamId: input.streamId,
        superChat: publicSuperChat,
      });

      return { superChat: publicSuperChat, replayed: false };
    });
  }

  // A zero share is skipped (ledger entries can't be 0), e.g. a 1-token chat gives the
  // creator floor(0.8) = 0.
  private async postingLines(
    tx: PoolClient,
    walletId: string,
    creatorId: string,
    creatorAmount: number,
    platformFee: number,
  ): Promise<PostingLine[]> {
    const lines: PostingLine[] = [debit(walletId, creatorAmount + platformFee)];
    if (creatorAmount > 0) {
      lines.push(credit(await this.ledger.userAccountId(tx, creatorId, 'CREATOR_EARNINGS'), creatorAmount));
    }
    if (platformFee > 0) {
      lines.push(credit(await this.ledger.systemAccountId(tx, 'PLATFORM_FEES'), platformFee));
    }
    return lines;
  }

  /**
   * Admin reversal: full refund to the sender, clawed back from the creator and the platform.
   *
   * Locks the super chat row first, so concurrent reversals run one after another and the
   * later ones just see REVERSED and return it. That's why this needs no Idempotency-Key.
   * The creator's earnings account is locked next (same lock order as payouts, which only
   * lock earnings) so a reversal and a payout request can't interleave.
   *
   * If the creator already withdrew, their earnings go negative and they can't request a
   * payout until future earnings cover it. Refusing the reversal instead would let a
   * fraudulent creator keep the money just by withdrawing fast.
   */
  async reverse(
    adminId: string,
    superChatId: string,
    reason: string | undefined,
  ): Promise<{ superChat: SuperChat; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<SuperChatRow>(
        `SELECT ${SUPER_CHAT_COLUMNS} FROM super_chats WHERE id = $1 FOR UPDATE`,
        [superChatId],
      );
      const row = locked.rows[0];
      if (!row) throw new NotFoundException(`Super Chat ${superChatId} not found`);
      if (row.status === 'REVERSED') {
        return { superChat: toPublic(row), replayed: true };
      }

      const earningsId = await this.ledger.userAccountId(tx, row.creatorId, 'CREATOR_EARNINGS');
      await this.ledger.lockAccount(tx, earningsId);

      await this.ledger.postReversal(tx, 'SUPER_CHAT', row.id, 'SUPER_CHAT_REVERSAL');

      const updated = await tx.query<SuperChatRow>(
        `UPDATE super_chats
            SET status = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = $3
          WHERE id = $1
          RETURNING ${SUPER_CHAT_COLUMNS}`,
        [row.id, adminId, reason ?? null],
      );
      const reversed = toPublic(updated.rows[0]);
      await publishStreamEvent(tx, {
        type: 'super_chat.reversed',
        streamId: reversed.streamId,
        superChatId: reversed.id,
        reversedAt: reversed.reversedAt!,
      });
      return { superChat: reversed, replayed: false };
    });
  }

  async listForStream(streamId: string, afterSeq: number, limit: number): Promise<SuperChat[]> {
    const { rows } = await this.db.query<SuperChatRow>(
      `SELECT ${SUPER_CHAT_COLUMNS} FROM super_chats
        WHERE stream_id = $1 AND stream_seq > $2
        ORDER BY stream_seq ASC
        LIMIT $3`,
      [streamId, afterSeq, limit],
    );
    return rows.map(toPublic);
  }

  /** Currently pinned, biggest amount first, then oldest. */
  async pinned(streamId: string): Promise<SuperChat[]> {
    const { rows } = await this.db.query<SuperChatRow>(
      `SELECT ${SUPER_CHAT_COLUMNS} FROM super_chats
        WHERE stream_id = $1 AND status = 'COMPLETED' AND pinned_until > now()
        ORDER BY amount DESC, stream_seq ASC`,
      [streamId],
    );
    return rows.map(toPublic);
  }

  private async findByKey(q: Queryable, senderId: string, key: string): Promise<SuperChatRow | null> {
    const { rows } = await q.query<SuperChatRow>(
      `SELECT ${SUPER_CHAT_COLUMNS} FROM super_chats WHERE sender_id = $1 AND idempotency_key = $2`,
      [senderId, key],
    );
    return rows[0] ?? null;
  }
}

export function toPublic(row: SuperChatRow | SuperChat): SuperChat {
  const { requestHash: _hidden, ...rest } = row as SuperChatRow;
  return rest;
}
