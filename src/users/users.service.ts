import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';

export interface User {
  id: string;
  displayName: string;
  role: 'user' | 'admin';
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // Accounts are created together with the user, so money flows can always assume they
  // exist and just lock them (no "create if missing" race on hot paths).
  async create(displayName: string): Promise<User> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<User>(
        `INSERT INTO users (display_name) VALUES ($1)
         RETURNING id, display_name AS "displayName", role, created_at AS "createdAt"`,
        [displayName],
      );
      const user = rows[0];
      await tx.query(
        `INSERT INTO accounts (type, owner_id, normal_side, allow_negative) VALUES
           ('USER_WALLET',      $1, 'CREDIT', FALSE),
           ('CREATOR_EARNINGS', $1, 'CREDIT', TRUE)`,
        [user.id],
      );
      return user;
    });
  }

  /** Latest users first. Used by the test UI to switch between users. */
  async list(limit = 200): Promise<User[]> {
    const { rows } = await this.db.query<User>(
      `SELECT id, display_name AS "displayName", role, created_at AS "createdAt"
         FROM users ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.db.query<User>(
      `SELECT id, display_name AS "displayName", role, created_at AS "createdAt"
         FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async balances(userId: string) {
    const walletId = await this.ledger.userAccountId(this.db.pool, userId, 'USER_WALLET');
    const earningsId = await this.ledger.userAccountId(this.db.pool, userId, 'CREATOR_EARNINGS');
    return {
      wallet: await this.ledger.balanceOf(this.db.pool, walletId),
      earnings: await this.ledger.balanceOf(this.db.pool, earningsId),
    };
  }
}
