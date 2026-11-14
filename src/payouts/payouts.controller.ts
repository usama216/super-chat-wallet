import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { IdempotencyKey } from '../common/idempotency';
import { DatabaseService } from '../database/database.service';
import { ApiIdempotent, USER_ID_AUTH } from '../swagger';
import { PayoutsService } from './payouts.service';

class RequestPayoutDto {
  @ApiProperty({ example: 50, minimum: 1, description: 'Whole tokens, taken from your earnings' })
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of tokens' })
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount: number;
}

// Creator side. Admin processing is in AdminController.
@ApiTags('4. Payouts')
@ApiSecurity(USER_ID_AUTH)
@Controller('payouts')
@UseGuards(AuthGuard)
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Request a payout from earnings (held until an admin marks it paid/rejected)' })
  @ApiIdempotent()
  @ApiResponse({ status: 201, description: 'Requested: tokens moved from earnings into the payout hold' })
  @ApiResponse({ status: 402, description: 'Earnings lower than the requested amount' })
  async request(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() key: string,
    @Body() dto: RequestPayoutDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { payout, replayed } = await this.payouts.request(user.id, key, dto.amount);
    if (replayed) res.status(200).setHeader('Idempotent-Replayed', 'true');
    return payout;
  }

  @Get()
  @ApiOperation({ summary: 'My payouts' })
  mine(@CurrentUser() user: AuthUser) {
    return this.payouts.listForCreator(this.db.pool, user.id);
  }
}
