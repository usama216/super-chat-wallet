import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { DatabaseService } from '../database/database.service';

// Mock auth: the caller is identified by the x-user-id header. Controllers only depend on
// @CurrentUser(), so swapping this for real JWT auth wouldn't touch them.
export type UserRole = 'user' | 'admin';

export interface AuthUser {
  id: string;
  role: UserRole;
}

export interface AuthedRequest extends Request {
  user: AuthUser;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.header('x-user-id');
    if (!userId || !UUID_RE.test(userId)) {
      throw new UnauthorizedException('Missing or invalid x-user-id header');
    }
    const { rows } = await this.db.query<AuthUser>('SELECT id, role FROM users WHERE id = $1', [
      userId,
    ]);
    if (rows.length === 0) {
      throw new UnauthorizedException('Unknown user');
    }
    req.user = rows[0];
    return true;
  }
}

/** Use after AuthGuard: @UseGuards(AuthGuard, AdminGuard). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Admin only');
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);
