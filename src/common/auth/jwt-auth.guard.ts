import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthUser, CustomerScope, JwtPayload } from './auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformOwner } from './platform-owner.guard';

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
    const scope = req.headers['x-customer-scope'];
    if (scope !== undefined) {
      if (typeof scope !== 'string' || !isPlatformOwner(user.email)) throw new ForbiddenException('Invalid customer access');
      const grant = await this.jwt.verifyAsync<CustomerScope>(scope).catch(() => null);
      if (grant?.typ !== 'customer-scope' || grant.sub !== user.userId || grant.home !== user.tenantId ||
          grant.sv !== user.sessionVersion || typeof grant.tid !== 'string') {
        throw new ForbiddenException('Invalid or expired customer access');
      }
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: grant.tid, archivedAt: null },
        select: { name: true },
      });
      if (!tenant) throw new ForbiddenException('Customer workspace unavailable');
      user.tenantId = grant.tid;
      user.role = 'admin';
      user.customerName = tenant.name;
    }
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
