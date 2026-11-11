import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { RedisService } from '../src/common/redis/redis.module';
import type { CryptoService } from '../src/common/crypto/crypto.service';
import { SiteAuthService } from '../src/modules/events/site-auth.service';
import { SiteConfigService } from '../src/modules/sites/site-config.service';

describe('archived tenant public surfaces', () => {
  it('rejects cached ingest authorization for archived tenants and permits it again after restoration', async () => {
    const prisma = { tenant: { findUnique: vi.fn().mockResolvedValue({ archivedAt: new Date() }) } };
    const redis = { get: vi.fn().mockResolvedValue(JSON.stringify({ siteId: 'site', tenantId: 'tenant', active: true, ik: 'key', origins: [] })) };
    const service = new SiteAuthService(prisma as unknown as PrismaService, redis as unknown as RedisService);
    expect(await service.resolveSite('site', 'key')).toBeNull();
    prisma.tenant.findUnique.mockResolvedValue({ archivedAt: null });
    expect(await service.resolveSite('site', 'key')).toMatchObject({ active: true });
  });

  it('does not authorize an archived tenant on a cache miss', async () => {
    const prisma = { site: { findUnique: vi.fn().mockResolvedValue({ id: 'site', tenantId: 'tenant', ingestKey: 'key', tenant: { archivedAt: new Date() } }) } };
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    const service = new SiteAuthService(prisma as unknown as PrismaService, redis as unknown as RedisService);
    expect(await service.resolveSite('site', 'key')).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('never serves a cached experiment configuration for an archived tenant', async () => {
    const prisma = { site: { findUnique: vi.fn().mockResolvedValue({ status: 'active', tenant: { archivedAt: new Date() } }) } };
    const redis = { get: vi.fn().mockResolvedValue('{"siteId":"site","experiments":[{"id":"running"}]}') };
    const service = new SiteConfigService(prisma as unknown as PrismaService, redis as unknown as RedisService, {} as CryptoService);
    expect(await service.get('site')).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });
});
