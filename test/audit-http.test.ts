import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/common/audit/audit.module';
import { AuditController } from '../src/modules/audit/audit.controller';

const user = { userId: 'admin', tenantId: 'tenant', email: 'admin@example.com', role: 'admin' };
const record = { id: 'record', action: 'site.created', targetType: 'site', targetId: 'site', createdAt: new Date() };
const prisma = {
  auditLog: { findMany: vi.fn().mockResolvedValue([record]) },
  userMembership: { findMany: vi.fn().mockResolvedValue([]) },
  site: { findMany: vi.fn().mockResolvedValue([]) },
};
// Vitest's transformer does not emit Nest constructor metadata.
Reflect.defineMetadata('design:paramtypes', [AuditService], AuditController);
@Module({ controllers: [AuditController], providers: [{ provide: AuditService, useValue: new AuditService(prisma as never) }] })
class TestModule {}

describe('audit HTTP compatibility', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
    app.getHttpAdapter().getInstance().addHook('onRequest', async request => { Object.assign(request, { user }); });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app?.close(); });

  it('keeps the array contract and legacy all-time scope without exposing identities or metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit?action=site.created' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ ...record, createdAt: record.createdAt.toISOString() }]);
    expect(prisma.auditLog.findMany).toHaveBeenLastCalledWith({
      where: { tenantId: user.tenantId, action: 'site.created' },
      take: 100, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, action: true, targetType: true, targetId: true, createdAt: true },
    });
  });

  it('serves paginated results at a distinct route and validates its filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit/search?timeframe=7d&action=site.created' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [{ id: record.id }], nextCursor: null, range: { from: expect.any(String), to: expect.any(String) } });
    expect(prisma.auditLog.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { tenantId: user.tenantId, action: 'site.created', createdAt: { gte: expect.any(Date), lte: expect.any(Date) } }, take: 26,
    }));
    expect((await app.inject({ method: 'GET', url: '/audit/search?timeframe=invalid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/audit?action=' })).statusCode).toBe(400);
  });
});
