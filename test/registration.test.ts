import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { TeamService } from '../src/modules/team/team.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { RegisterSchema } from '../src/modules/auth/auth.dto';
import type { AppEnv } from '../src/config/env';

const account = { userId: 'user', tenantId: 'existing-tenant', email: 'ana@example.com', role: 'viewer' as const };
function setup() {
  const prisma = { userMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'viewer', user: { email: account.email, sessionVersion: 0 }, tenant: { archivedAt: null } }) } };
  const team = { accept: vi.fn().mockResolvedValue(account) };
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed'), verifyAsync: vi.fn().mockResolvedValue({ sub: account.userId, tid: account.tenantId, role: 'admin', typ: 'refresh' }) };
  const config = { get: () => 900 };
  const auth = new AuthService(prisma as unknown as PrismaService, jwt as unknown as JwtService, config as unknown as ConfigService<AppEnv, true>, team as unknown as TeamService);
  return { auth, prisma, team, jwt };
}

describe('registration and current membership', () => {
  it('rejects the old tenant-creating signup payload without an invitation token', () => {
    expect(RegisterSchema.safeParse({ email: account.email, password: 'long-password', tenantName: 'Unauthorized tenant', name: 'Ana' }).success).toBe(false);
  });

  it('normalizes email and strips forged tenant and role fields', () => {
    expect(RegisterSchema.parse({ token: 'a'.repeat(64), email: ' Ana@Example.com ', name: ' Ana ', password: 'long-password', tenantId: 'other', role: 'admin', tenantName: 'New tenant' }))
      .toEqual({ token: 'a'.repeat(64), email: account.email, name: 'Ana', password: 'long-password' });
  });

  it('issues credentials only for the tenant and role returned by accepting the invitation', async () => {
    const { auth, team, jwt } = setup();
    const result = await auth.register('a'.repeat(64), account.email, 'Ana', 'long-password');
    expect(team.accept).toHaveBeenCalledWith('a'.repeat(64), account.email, 'Ana', 'long-password');
    expect(result.user).toMatchObject({ tenantId: account.tenantId, role: 'viewer' });
    expect(jwt.signAsync.mock.calls[0]?.[0]).toMatchObject({ tid: account.tenantId, role: 'viewer' });
  });

  it('does not issue tokens when invitation acceptance fails', async () => {
    const { auth, team, jwt } = setup();
    team.accept.mockRejectedValue(new Error('revoked'));
    await expect(auth.register('a'.repeat(64), account.email, 'Ana', 'long-password')).rejects.toThrow('revoked');
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('refreshes using the current role instead of the admin role in an old token', async () => {
    const { auth, jwt } = setup();
    expect((await auth.refresh('old-token')).user.role).toBe('viewer');
    expect(jwt.signAsync.mock.calls[0]?.[0]).toMatchObject({ role: 'viewer' });
  });

  it('does not refresh a deleted membership or an access token', async () => {
    const { auth, prisma, jwt } = setup();
    prisma.userMembership.findUnique.mockResolvedValue(null);
    await expect(auth.refresh('old-token')).rejects.toMatchObject({ status: 401 });
    jwt.verifyAsync.mockResolvedValue({ sub: 'user', tid: 'tenant' });
    await expect(auth.refresh('access-token')).rejects.toMatchObject({ status: 401 });
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('preserves database failures instead of treating them as bad credentials', async () => {
    const { auth, prisma } = setup();
    prisma.userMembership.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(auth.refresh('old-token')).rejects.toThrow('database unavailable');
  });

  it('rejects refresh tokens after password reset or tenant archival', async () => {
    const { auth, prisma } = setup();
    prisma.userMembership.findUnique.mockResolvedValue({ role: 'viewer', user: { email: account.email, sessionVersion: 1 }, tenant: { archivedAt: null } });
    await expect(auth.refresh('old-token')).rejects.toMatchObject({ status: 401 });
    prisma.userMembership.findUnique.mockResolvedValue({ role: 'viewer', user: { email: account.email, sessionVersion: 0 }, tenant: { archivedAt: new Date() } });
    await expect(auth.refresh('old-token')).rejects.toMatchObject({ status: 401 });
  });
});
