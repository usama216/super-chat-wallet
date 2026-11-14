import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { IdempotencyKey } from '../common/idempotency';
import { ApiIdempotent, USER_ID_AUTH } from '../swagger';
import { StreamsService } from './streams.service';
import { SuperChatsService } from './super-chats.service';

export const MAX_SUPER_CHAT_TOKENS = 1_000_000;

class CreateStreamDto {
  @ApiProperty({ example: 'demo-stream', pattern: '^[A-Za-z0-9_-]{1,64}$' })
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'id must be 1-64 letters, digits, "_" or "-"' })
  id: string;
}

class SendSuperChatDto {
  @ApiProperty({ example: 'Great stream!', minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  message: string;

  @ApiProperty({
    example: 100,
    minimum: 1,
    maximum: MAX_SUPER_CHAT_TOKENS,
    description: 'Creator gets floor(80%), platform the rest. Pinned: 1+ 30s, 50+ 2m, 200+ 5m, 1000+ 30m, 5000+ 1h',
  })
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of tokens' })
  @Min(1)
  @Max(MAX_SUPER_CHAT_TOKENS)
  amount: number;
}

class ListQueryDto {
  @ApiPropertyOptional({ default: 0, description: 'Only Super Chats with streamSeq > afterSeq' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq: number = 0;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

@ApiTags('3. Streams & Super Chats')
@ApiSecurity(USER_ID_AUTH)
@Controller('streams')
@UseGuards(AuthGuard)
export class SuperChatsController {
  constructor(
    private readonly streams: StreamsService,
    private readonly superChats: SuperChatsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Go live: create a stream owned by the current user (the creator)' })
  @ApiResponse({ status: 409, description: 'Stream id already exists' })
  createStream(@CurrentUser() user: AuthUser, @Body() dto: CreateStreamDto) {
    return this.streams.create(user.id, dto.id);
  }

  @Get()
  @ApiOperation({ summary: 'List streams (latest first)' })
  listStreams() {
    return this.streams.list();
  }

  @Get(':streamId')
  @ApiOperation({ summary: 'Get a stream' })
  getStream(@Param('streamId') streamId: string) {
    return this.streams.get(streamId);
  }

  @Post(':streamId/super-chats')
  @ApiOperation({ summary: 'Send a Super Chat (message + tokens) to the stream creator' })
  @ApiIdempotent()
  @ApiResponse({ status: 201, description: 'Sent: wallet charged, creator + platform credited, broadcast live' })
  @ApiResponse({ status: 402, description: 'Insufficient funds (nothing charged)' })
  @ApiResponse({ status: 404, description: 'Stream not found' })
  async send(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() key: string,
    @Param('streamId') streamId: string,
    @Body() dto: SendSuperChatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { superChat, replayed } = await this.superChats.send(user.id, key, {
      streamId,
      message: dto.message,
      amount: dto.amount,
    });
    if (replayed) {
      res.status(200).setHeader('Idempotent-Replayed', 'true');
    }
    return superChat;
  }

  // afterSeq lets a reconnecting viewer fetch only what it missed.
  @Get(':streamId/super-chats')
  @ApiOperation({ summary: 'Stream history in order (streamSeq ascending)' })
  list(@Param('streamId') streamId: string, @Query() q: ListQueryDto) {
    return this.superChats.listForStream(streamId, q.afterSeq, q.limit);
  }

  @Get(':streamId/pinned')
  @ApiOperation({ summary: 'Currently pinned Super Chats, biggest amount first' })
  pinned(@Param('streamId') streamId: string) {
    return this.superChats.pinned(streamId);
  }
}
