import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { RedisService } from '../src/common/redis/redis.module';
import type { CryptoService } from '../src/common/crypto/crypto.service';
import { SiteAuthService } from '../src/modules/events/site-auth.service';
import { SiteConfigService } from '../src/modules/sites/site-config.service';

describe('archived tenant public surfaces', () => {
  it('rejects ingest authorization for archived tenants and permits it again after restoration', async () => {
    const site = { id: 'site', tenantId: 'tenant', ingestKey: 'key', status: 'active', origins: [], tenant: { archivedAt: new Date() as Date | null } };
    const prisma = { site: { findUnique: vi.fn().mockResolvedValue(site) } };
    const service = new SiteAuthService(prisma as unknown as PrismaService, {} as never);
    expect(await service.resolveSite('site', 'key')).toBeNull();
    site.tenant.archivedAt = null;
    expect(await service.resolveSite('site', 'key')).toMatchObject({ active: true });
  });

  it('does not authorize an archived tenant on a cache miss', async () => {
    const prisma = { site: { findUnique: vi.fn().mockResolvedValue({ id: 'site', tenantId: 'tenant', ingestKey: 'key', tenant: { archivedAt: new Date() } }) } };
    const service = new SiteAuthService(prisma as unknown as PrismaService, {} as never);
    expect(await service.resolveSite('site', 'key')).toBeNull();
  });

  it('never serves a cached experiment configuration for an archived tenant', async () => {
    const prisma = { site: { findUnique: vi.fn().mockResolvedValue({ status: 'active', tenant: { archivedAt: new Date() } }) } };
    const redis = { get: vi.fn().mockResolvedValue('{"siteId":"site","experiments":[{"id":"running"}]}') };
    const service = new SiteConfigService(prisma as unknown as PrismaService, redis as unknown as RedisService, {} as CryptoService);
    expect(await service.get('site')).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });
});
