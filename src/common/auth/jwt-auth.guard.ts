import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthUser, JwtPayload } from './auth.types';

/**
 * Verifies the short-lived access JWT and attaches the tenant-scoped principal
 * to the request. Routes marked `@Public()` bypass authentication.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      const user: AuthUser = {
        userId: payload.sub,
        tenantId: payload.tid,
        role: payload.role,
        email: payload.email,
      };
      (req as FastifyRequest & { user?: AuthUser }).user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return null;
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : null;
}
