import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { USER_ID_AUTH } from '../swagger';
import { ChatService } from './chat.service';

class SendMessageDto {
  @ApiProperty({ example: 'Hello from Lahore!', minLength: 1, maxLength: 300 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 300)
  text: string;
}

class LatestQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

// Free chat on a live. No coins involved; paid messages are Super Chats.
@ApiTags('3. Streams & Super Chats')
@ApiSecurity(USER_ID_AUTH)
@Controller('streams')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post(':streamId/messages')
  @ApiOperation({ summary: 'Send a free chat message on a live' })
  @ApiResponse({ status: 404, description: 'Stream not found' })
  send(@CurrentUser() user: AuthUser, @Param('streamId') streamId: string, @Body() dto: SendMessageDto) {
    return this.chat.post(streamId, user.id, dto.text);
  }

  @Get(':streamId/messages')
  @ApiOperation({ summary: 'Latest chat messages on a live, oldest first' })
  latest(@Param('streamId') streamId: string, @Query() q: LatestQueryDto) {
    return this.chat.latest(streamId, q.limit);
  }
}
