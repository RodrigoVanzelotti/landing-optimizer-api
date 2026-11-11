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
import { PrismaService } from '../prisma/prisma.service';

/**
 * Verifies the short-lived access JWT and attaches the tenant-scoped principal
 * to the request. Routes marked `@Public()` bypass authentication.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
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

    let payload: JwtPayload & { typ?: string };
    try {
      payload = await this.jwt.verifyAsync<JwtPayload & { typ?: string }>(token);
      if (payload.typ || !payload.sub || !payload.tid) throw new Error('Invalid access token');
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const membership = await this.prisma.userMembership.findUnique({
      where: { tenantId_userId: { tenantId: payload.tid, userId: payload.sub } },
      include: { user: { select: { email: true, sessionVersion: true } }, tenant: { select: { archivedAt: true } } },
    });
    if (!membership) throw new UnauthorizedException('Membership no longer exists');
    if (membership.tenant.archivedAt || membership.user.sessionVersion !== (payload.sv ?? 0)) throw new UnauthorizedException('Session no longer valid');
    const user: AuthUser = {
      userId: payload.sub,
      tenantId: payload.tid,
      role: membership.role,
      email: membership.user.email,
      sessionVersion: membership.user.sessionVersion,
    };
    (req as FastifyRequest & { user?: AuthUser }).user = user;
    return true;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return null;
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : null;
}
