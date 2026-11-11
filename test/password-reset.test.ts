import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/env';
import { PasswordResetService } from '../src/modules/auth/password-reset.service';
import { ResetPasswordSchema } from '../src/modules/auth/auth.dto';
import { hashInvitationToken } from '../src/modules/team/invitation';

vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn().mockResolvedValue('new-password-hash') }));

function setup() {
  const reset = { id: 'reset-id', userId: 'user-id', usedAt: null as Date | null, expiresAt: new Date(Date.now() + 3600000) };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'user-id' }]),
    userMembership: { findUnique: vi.fn().mockResolvedValue({ tenant: { archivedAt: null }, user: { email: 'ana@acme.com' } }), findFirst: vi.fn().mockResolvedValue({ id: 'member' }) },
    passwordReset: {
      findUnique: vi.fn().mockResolvedValue(reset), create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return { count: 0 };
        if (reset.usedAt || reset.expiresAt <= new Date()) return { count: 0 };
        reset.usedAt = new Date(); return { count: 1 };
      }),
    },
    user: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
  const service = new PasswordResetService(prisma as unknown as PrismaService, { get: () => 'https://dashboard.example.com' } as unknown as ConfigService<AppEnv, true>);
  return { reset, tx, prisma, service };
}

describe('operator password reset links', () => {
  it('binds issuance to a user in the selected active tenant, stores only a hash and invalidates earlier links', async () => {
    const { tx, service } = setup();
    const result = await service.create('tenant-a', 'user-id');
    expect(tx.userMembership.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId_userId: { tenantId: 'tenant-a', userId: 'user-id' } } }));
    const url = new URL(result.url);
    const token = url.hash.slice(1);
    expect(url.pathname).toBe('/reset-password');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get('email')).toBe('ana@acme.com');
    expect(tx.passwordReset.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-id', tokenHash: hashInvitationToken(token) }) });
    expect(JSON.stringify(tx.passwordReset.create.mock.calls)).not.toContain(token);
    expect(tx.passwordReset.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-id', usedAt: null }, data: { usedAt: expect.any(Date) } });
    expect(result.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3600000);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuses unknown members or archived tenants', async () => {
    const { tx, service } = setup();
    tx.userMembership.findUnique.mockResolvedValue(null);
    await expect(service.create('wrong-tenant', 'user-id')).rejects.toMatchObject({ status: 404 });
    tx.userMembership.findUnique.mockResolvedValue({ tenant: { archivedAt: new Date() }, user: { email: 'ana@acme.com' } });
    await expect(service.create('tenant-a', 'user-id')).rejects.toMatchObject({ status: 404 });
    expect(tx.passwordReset.create).not.toHaveBeenCalled();
  });

  it('atomically consumes a one-use token and increments the session version with the new hash', async () => {
    const { tx, service } = setup();
    await service.complete('a'.repeat(64), 'long-new-password');
    expect(tx.passwordReset.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashInvitationToken('a'.repeat(64)) } });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-id' }, data: { passwordHash: 'new-password-hash', sessionVersion: { increment: 1 } } });
    await expect(service.complete('a'.repeat(64), 'another-password')).rejects.toMatchObject({ status: 403 });
    expect(tx.user.update).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'expired', 'used', 'no-active-tenant', 'replaced-under-lock'])('rejects %s resets without changing a password', async (state) => {
    const { tx, reset, service } = setup();
    if (state === 'unknown') tx.passwordReset.findUnique.mockResolvedValue(null);
    if (state === 'expired') reset.expiresAt = new Date(0);
    if (state === 'used') reset.usedAt = new Date();
    if (state === 'no-active-tenant') tx.userMembership.findFirst.mockResolvedValue(null);
    if (state === 'replaced-under-lock') tx.passwordReset.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.complete('a'.repeat(64), 'long-new-password')).rejects.toMatchObject({ status: 403 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects malformed credentials and weak new passwords at the HTTP boundary', () => {
    expect(ResetPasswordSchema.safeParse({ token: 'invalid', password: 'long-password' }).success).toBe(false);
    expect(ResetPasswordSchema.safeParse({ token: 'a'.repeat(64), password: 'short' }).success).toBe(false);
  });
});
