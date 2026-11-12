import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { TeamService } from '../src/modules/team/team.service';
import type { PasswordResetService } from '../src/modules/auth/password-reset.service';
import type { AppEnv } from '../src/config/env';
import { validateEnv } from '../src/config/env';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthController } from '../src/modules/auth/auth.controller';
import { LoginSchema } from '../src/modules/auth/auth.dto';

vi.mock('argon2', () => ({ verify: async () => true }));

const MONTH = 30 * 24 * 60 * 60;
const credentials = { email: 'ana@example.com', password: 'password' };

function setup() {
  const config = { get: (key: string) => key === 'JWT_ACCESS_TTL' ? 900 : MONTH };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user', email: credentials.email, passwordHash: 'hash', sessionVersion: 0, memberships: [{ tenantId: 'tenant', role: 'viewer' }] }) },
    userMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'viewer', user: { email: credentials.email, sessionVersion: 0 }, tenant: { archivedAt: null } }) },
  };
  const jwt = new JwtService({ secret: 'session-lifetime-test-secret' });
  const auth = new AuthService(prisma as unknown as PrismaService, jwt, config as unknown as ConfigService<AppEnv, true>, {} as TeamService);
  const controller = new AuthController(auth, {} as PasswordResetService);
  const header = vi.fn();
  const reply = { header } as unknown as FastifyReply;
  return { auth, controller, jwt, reply, header };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fixed login lifetime and optional persistence', () => {
  it('defaults to 30 days with persistence disabled and rejects a non-boolean preference', () => {
    expect(validateEnv({ DATABASE_URL: 'postgresql://localhost/test', JWT_SECRET: 'test-secret-long-enough' }).JWT_REFRESH_TTL).toBe(MONTH);
    expect(LoginSchema.parse(credentials).rememberMe).toBe(false);
    expect(LoginSchema.safeParse({ ...credentials, rememberMe: 'true' }).success).toBe(false);
  });

  it.each([false, true])('keeps the original deadline across multiple refreshes (rememberMe=%s)', async (rememberMe) => {
    const { auth, jwt } = setup();
    const login = await auth.login(credentials.email, credentials.password, rememberMe);
    const deadline = Math.floor(Date.now() / 1000) + MONTH;
    expect(login.refreshExpiresAt).toBe(deadline);
    vi.setSystemTime(Date.now() + 15 * 24 * 3600000);
    const first = await auth.refresh(login.refreshToken);
    vi.setSystemTime(Date.now() + 14 * 24 * 3600000);
    const second = await auth.refresh(first.refreshToken);
    expect(jwt.verify(second.refreshToken)).toMatchObject({ exp: deadline, rememberMe });
    expect(second.refreshExpiresAt).toBe(deadline);
    vi.setSystemTime(deadline * 1000);
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('caps the final access token at the original session deadline', async () => {
    const { auth, jwt } = setup();
    const login = await auth.login(credentials.email, credentials.password, true);
    vi.setSystemTime((login.refreshExpiresAt - 10) * 1000);
    const refreshed = await auth.refresh(login.refreshToken);
    expect(jwt.verify(refreshed.accessToken)).toMatchObject({ exp: login.refreshExpiresAt });
  });

  it.each([false, true])('preserves cookie persistence during refresh (rememberMe=%s)', async (rememberMe) => {
    const { controller, jwt, reply, header } = setup();
    await controller.login(LoginSchema.parse({ ...credentials, rememberMe }), reply);
    const cookie = header.mock.calls[0][1] as string;
    expect(cookie).toContain('Path=/; HttpOnly; Secure; SameSite=Strict');
    expect(cookie.includes('Max-Age=')).toBe(rememberMe);
    if (rememberMe) expect(cookie).toContain(`Max-Age=${MONTH}`);
    const token = cookie.split(';')[0].split('=')[1];
    expect(jwt.verify(token)).toMatchObject({ rememberMe });
    vi.setSystemTime(Date.now() + 24 * 3600000);
    await controller.refresh({ headers: { cookie } } as FastifyRequest, reply);
    const refreshedCookie = header.mock.calls[1][1] as string;
    expect(refreshedCookie.includes('Max-Age=')).toBe(rememberMe);
    if (rememberMe) expect(refreshedCookie).toContain(`Max-Age=${MONTH - 86400}`);
    controller.logout(reply);
    expect(header).toHaveBeenLastCalledWith('set-cookie', expect.stringContaining('Max-Age=0'));
  });

  it('keeps legacy tokens valid until their existing expiry without silently enabling persistence', async () => {
    const { auth, jwt } = setup();
    const token = jwt.sign({ sub: 'user', tid: 'tenant', role: 'viewer', typ: 'refresh' }, { expiresIn: 3600 });
    const result = await auth.refresh(token);
    expect(result.refreshExpiresAt).toBe(jwt.verify(token).exp);
    expect(result.rememberMe).toBe(false);
  });

  it('rejects refresh tokens without an expiry', async () => {
    const { auth, jwt } = setup();
    const token = jwt.sign({ sub: 'user', tid: 'tenant', typ: 'refresh' });
    await expect(auth.refresh(token)).rejects.toMatchObject({ status: 401 });
  });
});
