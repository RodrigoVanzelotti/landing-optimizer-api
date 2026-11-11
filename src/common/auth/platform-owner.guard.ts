import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from './auth.types';

const PLATFORM_OWNER_EMAIL = 'rodrigovanzelotti@gmail.com';
export const isPlatformOwner = (email: string): boolean => email.toLowerCase() === PLATFORM_OWNER_EMAIL;

@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // JwtAuthGuard populates this email from the database, never from a client claim.
    const user = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>().user;
    if (!user || !isPlatformOwner(user.email)) throw new ForbiddenException('Acesso exclusivo à gestão da plataforma.');
    return true;
  }
}
