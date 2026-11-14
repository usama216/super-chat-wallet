import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { USER_ID_AUTH } from '../swagger';
import { UsersService } from './users.service';

class CreateUserDto {
  @ApiProperty({ example: 'Cara the Creator', minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100)
  displayName: string;
}

@ApiTags('1. Users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('users')
  @ApiOperation({
    summary: 'Create a user',
    description: 'Returns the user id. Use it as `x-user-id` (Authorize button). Always role "user".',
  })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto.displayName);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiSecurity(USER_ID_AUTH)
  @ApiOperation({ summary: 'Current user + balances (wallet, earnings), computed from the ledger' })
  async me(@CurrentUser() user: AuthUser) {
    const [profile, balances] = await Promise.all([
      this.users.findById(user.id),
      this.users.balances(user.id),
    ]);
    return { ...profile, balances };
  }
}
