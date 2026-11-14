import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiPropertyOptional,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Response } from 'express';
import { AdminGuard, AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { PayoutStatus, PayoutsService } from '../payouts/payouts.service';
import { SuperChatsService } from '../super-chats/super-chats.service';
import { DEMO_ADMIN_ID, USER_ID_AUTH } from '../swagger';

class ReverseDto {
  @ApiPropertyOptional({ example: 'chargeback', maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}

class ListPayoutsQuery {
  @ApiPropertyOptional({ enum: ['REQUESTED', 'PAID', 'REJECTED'] })
  @IsOptional()
  @IsIn(['REQUESTED', 'PAID', 'REJECTED'])
  status?: PayoutStatus;
}

// Each action moves one existing object to a final state, so repeating it is a no-op and
// no Idempotency-Key is needed.
@ApiTags(`5. Admin (x-user-id: ${DEMO_ADMIN_ID})`)
@ApiSecurity(USER_ID_AUTH)
@ApiResponse({ status: 403, description: 'Not an admin' })
@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly superChats: SuperChatsService,
    private readonly payouts: PayoutsService,
  ) {}

  @Post('super-chats/:id/reversal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reverse a Super Chat: full refund to the sender',
    description:
      'Mirrors the original ledger posting (creator 80% + platform 20% back to the sender). ' +
      'Repeating it is a no-op. The creator may go negative if they already withdrew.',
  })
  @ApiResponse({ status: 404, description: 'Super Chat not found' })
  async reverse(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { superChat, replayed } = await this.superChats.reverse(admin.id, id, dto.reason);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return superChat;
  }

  @Get('payouts')
  @ApiOperation({ summary: 'List payouts (optionally by status)' })
  listPayouts(@Query() q: ListPayoutsQuery) {
    return this.payouts.list(q.status);
  }

  @Post('payouts/:id/paid')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a payout as paid (money leaves the platform)' })
  @ApiResponse({ status: 409, description: 'Payout was already rejected' })
  markPaid(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.process(admin, id, 'PAID', res);
  }

  @Post('payouts/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a payout (held tokens return to the creator earnings)' })
  @ApiResponse({ status: 409, description: 'Payout was already paid' })
  reject(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.process(admin, id, 'REJECTED', res);
  }

  private async process(admin: AuthUser, id: string, decision: 'PAID' | 'REJECTED', res: Response) {
    const { payout, replayed } = await this.payouts.process(admin.id, id, decision);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return payout;
  }
}
