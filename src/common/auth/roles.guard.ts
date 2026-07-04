import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { ROLES_KEY } from './roles.decorator';
import type { AuthUser } from './auth.types';

const RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/**
 * Enforces a minimum role. `@Roles('admin')` allows admin and owner.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('No authenticated principal');
    if (RANK[user.role] < RANK[required]) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
