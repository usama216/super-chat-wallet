import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { IdempotencyKey } from '../common/idempotency';
import { DatabaseService } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { ApiIdempotent, USER_ID_AUTH } from '../swagger';
import { PurchasesService } from './purchases.service';

// Per-purchase cap; also keeps every amount far below Number.MAX_SAFE_INTEGER.
export const MAX_PURCHASE_TOKENS = 1_000_000;

class PurchaseDto {
  @ApiProperty({ example: 500, minimum: 1, maximum: MAX_PURCHASE_TOKENS, description: 'Whole tokens' })
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of tokens' })
  @Min(1)
  @Max(MAX_PURCHASE_TOKENS)
  amount: number;
}

@ApiTags('2. Wallet')
@ApiSecurity(USER_ID_AUTH)
@Controller('wallet')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly ledger: LedgerService,
    private readonly db: DatabaseService,
  ) {}

  // 201 for a new purchase, 200 + Idempotent-Replayed for a retry.
  @Post('purchases')
  @ApiOperation({ summary: 'Buy tokens (mock payment, always approved)' })
  @ApiIdempotent()
  @ApiResponse({ status: 201, description: 'Purchased; tokens credited to the wallet' })
  async purchase(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() key: string,
    @Body() dto: PurchaseDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { purchase, replayed } = await this.purchases.purchase(user.id, key, dto.amount);
    if (replayed) {
      res.status(200).setHeader('Idempotent-Replayed', 'true');
    }
    return purchase;
  }

  @Get()
  @ApiOperation({ summary: 'Wallet balance + statement (latest ledger entries)' })
  async wallet(@CurrentUser() user: AuthUser) {
    const walletId = await this.ledger.userAccountId(this.db.pool, user.id, 'USER_WALLET');
    return {
      balance: await this.ledger.balanceOf(this.db.pool, walletId),
      entries: await this.ledger.statement(this.db.pool, walletId),
    };
  }
}
