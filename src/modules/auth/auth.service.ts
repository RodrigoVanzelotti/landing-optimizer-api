import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import { newId } from '../../common/crypto/ids';
import type { AppEnv } from '../../config/env';
import type { AuthUser, JwtPayload } from '../../common/auth/auth.types';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
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
  ) {}

  /** Register a new operator + their first tenant (owner membership). */
  async register(
    email: string,
    password: string,
    tenantName: string,
    name?: string,
  ): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const tenantId = newId();
    const userId = newId();

    await this.prisma.$transaction([
      this.prisma.tenant.create({
        data: { id: tenantId, name: tenantName, slug: slugify(tenantName, tenantId) },
      }),
      this.prisma.user.create({
        data: { id: userId, email, name: name ?? null, passwordHash },
      }),
      this.prisma.userMembership.create({
        data: { id: newId(), tenantId, userId, role: 'owner' },
      }),
    ]);

    return this.issue({ userId, tenantId, role: 'owner', email });
  }

  /** Log in and mint tokens scoped to the user's first tenant membership. */
  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    const membership = user?.memberships[0];
    if (!user || !user.passwordHash || !membership) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    return this.issue({
      userId: user.id,
      tenantId: membership.tenantId,
      role: membership.role,
      email: user.email,
    });
  }

  async refresh(token: string): Promise<AuthResult> {
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload & { typ?: string }>(token);
      if (payload.typ !== 'refresh') throw new Error('wrong token type');
      return this.issue({
        userId: payload.sub,
        tenantId: payload.tid,
        role: payload.role,
        email: payload.email,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async me(user: AuthUser): Promise<unknown> {
    return this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        name: true,
        memberships: { select: { tenantId: true, role: true } },
      },
    });
  }

  private async issue(u: AuthUser): Promise<AuthResult> {
    const base: JwtPayload = { sub: u.userId, tid: u.tenantId, role: u.role, email: u.email };
    const accessToken = await this.jwt.signAsync(base, {
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });
    const refreshToken = await this.jwt.signAsync(
      { ...base, typ: 'refresh' },
      { expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }) },
    );
    return {
      accessToken,
      refreshToken,
      user: { id: u.userId, email: u.email, tenantId: u.tenantId, role: u.role },
    };
  }
}

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'tenant'}-${id.slice(0, 8)}`;
}
