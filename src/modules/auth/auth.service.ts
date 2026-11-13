import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TeamService } from '../team/team.service';
import type { AppEnv } from '../../config/env';
import type { AuthUser, JwtPayload } from '../../common/auth/auth.types';
import { isPlatformOwner } from '../../common/auth/platform-owner.guard';
import { writeAudit } from '../../common/audit/audit.module';

// Equalize password verification work for unknown accounts; this is not a usable account.
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$04GVc3OKNqlhviLcCTV0xQ$/7vhKrhqgl/0rsnFhvtE4V2OKWBnOt0FbFfxRDyvZEU';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: number;
  rememberMe: boolean;
  user: { id: string; email: string; tenantId: string; role: string };
}

/**
 * Self-contained operator authentication (email + password, Argon2id). In
 * production this can be fronted by Auth.js/Clerk; the API still mints the
 * short-lived tenant-scoped JWTs used by every control-plane request.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly team: TeamService,
  ) {}

  /** Accept a one-use invitation; tenants are provisioned only by the operator script. */
  async register(
    token: string,
    email: string,
    name: string,
    password: string,
  ): Promise<AuthResult> {
    return this.issue(await this.team.accept(token, email, name, password));
  }

  /** Log in and mint tokens scoped to the user's first tenant membership. */
  async login(email: string, password: string, rememberMe = false): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { memberships: { where: { tenant: { archivedAt: null } }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    const membership = user?.memberships[0];
    const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password);
    if (!user || !user.passwordHash || !membership || !ok) throw new UnauthorizedException('Invalid credentials');

    const result = await this.issue({
      userId: user.id,
      tenantId: membership.tenantId,
      role: membership.role,
      email: user.email,
      sessionVersion: user.sessionVersion,
    }, rememberMe);
    await writeAudit(this.prisma, { tenantId: membership.tenantId, actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id });
    return result;
  }

  async logout(user: AuthUser): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await tx.user.updateMany({
        where: { id: user.userId, sessionVersion: user.sessionVersion ?? 0 },
        data: { sessionVersion: { increment: 1 } },
      });
      await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'auth.logout', targetType: 'user', targetId: user.userId });
    });
  }

  async refresh(token: string): Promise<AuthResult> {
    let payload: JwtPayload & { typ?: string; exp?: number; rememberMe?: boolean };
    try {
      payload = await this.jwt.verifyAsync<typeof payload>(token);
      if (payload.typ !== 'refresh' || !payload.sub || !payload.tid) throw new Error('wrong token type');
      if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Invalid session expiration');
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const membership = await this.prisma.userMembership.findUnique({
      where: { tenantId_userId: { tenantId: payload.tid, userId: payload.sub } },
      include: { user: { select: { email: true, sessionVersion: true } }, tenant: { select: { archivedAt: true } } },
    });
    if (!membership) throw new UnauthorizedException('Membership no longer exists');
    if (membership.tenant.archivedAt || membership.user.sessionVersion !== (payload.sv ?? 0)) throw new UnauthorizedException('Session no longer valid');
    return this.issue({
      userId: payload.sub,
      tenantId: payload.tid,
      role: membership.role,
      email: membership.user.email,
      sessionVersion: membership.user.sessionVersion,
    }, payload.rememberMe === true, payload.exp);
  }

  async me(user: AuthUser): Promise<unknown> {
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });
    return { ...account, tenantId: user.tenantId, role: user.role === 'owner' ? 'admin' : user.role, platformOwner: isPlatformOwner(user.email) };
  }

  private async issue(
    u: AuthUser,
    rememberMe = false,
    refreshExpiresAt = Math.floor(Date.now() / 1000) + this.config.get('JWT_REFRESH_TTL', { infer: true }),
  ): Promise<AuthResult> {
    const now = Math.floor(Date.now() / 1000);
    if (refreshExpiresAt <= now) throw new UnauthorizedException('Session expired');
    const base: JwtPayload = { sub: u.userId, tid: u.tenantId, role: u.role, email: u.email, sv: u.sessionVersion ?? 0 };
    const accessToken = await this.jwt.signAsync({
      ...base,
      exp: Math.min(now + this.config.get('JWT_ACCESS_TTL', { infer: true }), refreshExpiresAt),
    });
    const refreshToken = await this.jwt.signAsync(
      // Preserve the login deadline across renewals, including legacy refresh tokens.
      { ...base, typ: 'refresh', rememberMe, exp: refreshExpiresAt },
    );
    return {
      accessToken,
      refreshToken,
      refreshExpiresAt,
      rememberMe,
      user: { id: u.userId, email: u.email, tenantId: u.tenantId, role: u.role },
    };
  }
}
