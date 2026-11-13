import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/env';
import type { AuthUser } from '../src/common/auth/auth.types';
import { PlatformOwnerGuard } from '../src/common/auth/platform-owner.guard';
import { JwtAuthGuard } from '../src/common/auth/jwt-auth.guard';
import { PlatformController } from '../src/modules/platform/platform.controller';
import { PlatformService } from '../src/modules/platform/platform.service';
import { CreateTenantSchema } from '../src/modules/platform/platform.dto';
import { provisionTenant } from '../src/modules/team/provision-tenant';

vi.mock('../src/modules/team/provision-tenant', () => ({ provisionTenant: vi.fn().mockResolvedValue({ tenantId: 'new-tenant', invitationUrl: 'https://dashboard.example.com/invite#secret' }) }));
const owner: AuthUser = { userId: 'owner', tenantId: 'operator-tenant', email: 'rodrigovanzelotti@gmail.com', role: 'admin' };
function context(email?: string) {
  const request = { user: email ? { ...owner, email } : undefined, headers: { authorization: 'Bearer signed-token' } };
  const ctx = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => PlatformController.prototype.list, getClass: () => PlatformController } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('exclusive platform access', () => {
  it('protects the entire platform controller with an identity check', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformController)).toContain(PlatformOwnerGuard);
    expect(new PlatformOwnerGuard().canActivate(context(owner.email).ctx)).toBe(true);
  });

  it.each([undefined, 'admin@acme.com', 'rodrigovanzelotti@gmail.com.evil', 'rodrigovanzelotti+other@gmail.com'])('refuses %s even with the administrator tenant role', (email) => {
    expect(() => new PlatformOwnerGuard().canActivate(context(email).ctx)).toThrow();
  });

  it('rejects a token claiming the owner email when the persisted account has a different email', async () => {
    const { ctx } = context(owner.email);
    const jwt = { verifyAsync: vi.fn().mockResolvedValue({ sub: 'customer', tid: 'tenant', email: owner.email, role: 'admin' }) };
    const prisma = { userMembership: { findUnique: vi.fn().mockResolvedValue({ user: { email: 'admin@acme.com', sessionVersion: 0 }, tenant: { archivedAt: null }, role: 'admin' }) } };
    await new JwtAuthGuard(jwt as unknown as JwtService, new Reflector(), prisma as unknown as PrismaService).canActivate(ctx);
    expect(() => new PlatformOwnerGuard().canActivate(ctx)).toThrow();
  });
});

describe('tenant management', () => {
  function setup() {
    const tx = {
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'customer-tenant' }]),
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'customer-tenant', name: 'Acme', archivedAt: null }), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
      userMembership: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
    const config = { get: () => 'https://dashboard.example.com,http://localhost:3000' };
    const service = new PlatformService(prisma as unknown as PrismaService, config as unknown as ConfigService<AppEnv, true>);
    return { service, tx, prisma };
  }

  it('lists archived tenants and selects only safe account fields for tenant details', async () => {
    const { service, tx } = setup();
    await service.list();
    expect(tx.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ archivedAt: true }) }));
    await service.get('customer-tenant');
    const query = tx.tenant.findUnique.mock.calls[0]?.[0] as unknown as { select: object };
    expect(JSON.stringify(query.select)).not.toMatch(/passwordHash|tokenHash|sessionVersion/);
    expect(query.select).toHaveProperty('memberships.select.user.select.email', true);
    tx.tenant.findUnique.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('uses the existing provisioning transaction and forces the first administrator role', async () => {
    const { service, prisma } = setup();
    const input = CreateTenantSchema.parse({ name: ' Ana ', email: ' ANA@ACME.COM ', tenantName: ' Acme ', role: 'owner' });
    await service.create(input, owner.userId);
    expect(provisionTenant).toHaveBeenCalledWith(prisma, 'Acme', { name: 'Ana', email: 'ana@acme.com', role: 'admin' }, 'https://dashboard.example.com', owner.userId);
  });

  it('archives with explicit confirmation, under a tenant lock, preserving all data', async () => {
    const { service, tx } = setup();
    await service.archive(owner, 'customer-tenant', 'Acme');
    expect(tx.$queryRaw.mock.calls[0]?.[0].join('')).toContain('FOR UPDATE');
    expect(tx.tenant.update).toHaveBeenCalledWith({ where: { id: 'customer-tenant' }, data: { archivedAt: expect.any(Date) } });
  });

  it('refuses a mismatched name and protects every tenant that contains the owner account', async () => {
    const { service, tx } = setup();
    await expect(service.archive(owner, 'customer-tenant', 'wrong-name')).rejects.toMatchObject({ status: 409 });
    await expect(service.archive(owner, owner.tenantId, 'Acme')).rejects.toMatchObject({ status: 409 });
    tx.userMembership.findFirst.mockResolvedValue({ id: 'another-membership' });
    await expect(service.archive(owner, 'customer-tenant', 'Acme')).rejects.toMatchObject({ status: 409 });
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it('reactivates an archived tenant without rebuilding or deleting its data', async () => {
    const { service, tx } = setup();
    await service.restore('customer-tenant');
    expect(tx.tenant.update).toHaveBeenCalledWith({ where: { id: 'customer-tenant' }, data: { archivedAt: null } });
  });
});
