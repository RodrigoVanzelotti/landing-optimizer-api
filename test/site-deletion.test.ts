import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { SitesService } from '../src/modules/sites/sites.service';
import { DeleteSiteSchema } from '../src/modules/sites/sites.dto';
import { ClickHouseService, type EventRow } from '../src/modules/analytics/clickhouse/clickhouse.service';
import { SiteConfigService } from '../src/modules/sites/site-config.service';

const user = { userId: 'admin', tenantId: 'tenant', role: 'admin', email: 'admin@example.test' } as const;
function setup() {
  const site = { id: 'site', tenantId: 'tenant', primaryDomain: 'example.test' };
  const db = {
    site: { findUnique: vi.fn().mockResolvedValue(site), delete: vi.fn() },
    auditLog: { deleteMany: vi.fn(), create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValueOnce([{ role: 'admin' }]).mockResolvedValueOnce([{ id: 'site' }]).mockResolvedValueOnce([{ id: 'experiment' }, { id: 'insight' }]),
    $executeRaw: vi.fn(),
  };
  const prisma = { ...db, $transaction: vi.fn(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db)) };
  const analytics = { deleteSiteData: vi.fn() }, redis = { delStrict: vi.fn() };
  const service = new SitesService(prisma as never, {} as never, {} as never, analytics as never, redis as never);
  return { site, db, prisma, analytics, redis, service };
}

it.each(['viewer', 'editor', 'owner'] as const)('rejects %s before any deletion', async role => {
  const { service, prisma, analytics } = setup();
  await expect(service.remove({ ...user, role }, 'site', { confirmation: 'example.test' })).rejects.toMatchObject({ status: 403 });
  expect(prisma.$transaction).not.toHaveBeenCalled(); expect(analytics.deleteSiteData).not.toHaveBeenCalled();
});
it('rechecks current administrative membership under a lock', async () => {
  const { service, db, analytics } = setup();
  db.$queryRaw.mockReset().mockResolvedValue([{ role: 'editor' }]);
  await expect(service.remove(user, 'site', { confirmation: 'example.test' })).rejects.toMatchObject({ status: 403 });
  expect(db.site.delete).not.toHaveBeenCalled(); expect(analytics.deleteSiteData).not.toHaveBeenCalled();
});
it('validates exact domain and tenant before touching data or credentials', async () => {
  for (const [tenantId, confirmation, status] of [['tenant', 'https://example.test', 400], ['foreign', 'example.test', 403]] as const) {
    const { service, db, analytics, redis } = setup();
    await expect(service.remove({ ...user, tenantId }, 'site', { confirmation })).rejects.toMatchObject({ status });
    expect(db.site.delete).not.toHaveBeenCalled(); expect(analytics.deleteSiteData).not.toHaveBeenCalled(); expect(redis.delStrict).not.toHaveBeenCalled();
  }
  expect(DeleteSiteSchema.safeParse({}).success).toBe(false);
  expect(DeleteSiteSchema.safeParse({ confirmation: 'example.test', tenantId: 'foreign' }).success).toBe(false);
});
it('removes analytics, cached credentials, relational records and old audits, keeping only a minimal audit', async () => {
  const { service, db, analytics, redis } = setup();
  await service.remove(user, 'site', { confirmation: ' example.test ' });
  expect(analytics.deleteSiteData).toHaveBeenCalledWith('tenant', 'site');
  expect(redis.delStrict).toHaveBeenCalledWith('config:site');
  expect(db.$executeRaw.mock.calls[0].slice(1)).toEqual(['tenant', 'site']);
  expect(db.site.delete).toHaveBeenCalledWith({ where: { id: 'site' } });
  expect(db.auditLog.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant' }) }));
  expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorUserId: 'admin', action: 'site.deleted', targetId: 'site', metadata: {}, ipHash: null }) });
  expect(db.auditLog.create.mock.calls[0][0].data).not.toHaveProperty('primaryDomain');
  expect(db.site.delete.mock.invocationCallOrder[0]).toBeLessThan(db.auditLog.deleteMany.mock.invocationCallOrder[0]);
});
it.each(['analytics', 'redis'] as const)('propagates %s purge failures and never reports success', async dependency => {
  const { service, db, analytics, redis } = setup();
  (dependency === 'analytics' ? analytics.deleteSiteData : redis.delStrict).mockRejectedValue(new Error('unavailable'));
  await expect(service.remove(user, 'site', { confirmation: 'example.test' })).rejects.toThrow('unavailable');
  expect(db.site.delete).not.toHaveBeenCalled(); expect(db.auditLog.create).not.toHaveBeenCalled();
});
it('safely retries an already removed site without duplicating the audit', async () => {
  const { service, db, analytics } = setup(); db.site.findUnique.mockResolvedValue(null as never);
  await service.remove(user, 'site', { confirmation: 'example.test' });
  expect(analytics.deleteSiteData).not.toHaveBeenCalled(); expect(db.auditLog.create).not.toHaveBeenCalled();
});

it('purges all four ClickHouse stores synchronously with tenant and site scoping', async () => {
  const command = vi.fn();
  const service = new ClickHouseService({ get: () => 'clickhouse' } as never, {} as never);
  Object.assign(service, { client: { command } });
  await service.deleteSiteData('tenant', 'site');
  expect(command.mock.calls.map(([arg]) => arg.query.split(' ')[2])).toEqual(['events', 'mv_experiment_stats', 'mv_daily_funnel', 'mv_section_performance']);
  for (const [arg] of command.mock.calls) expect(arg).toMatchObject({ query_params: { tenantId: 'tenant', siteId: 'site' }, clickhouse_settings: { mutations_sync: '2' } });
  command.mockRejectedValueOnce(new Error('failed mutation'));
  await expect(service.deleteSiteData('tenant', 'site')).rejects.toThrow('failed mutation');
});
it('holds the site lock until ClickHouse flushes and rejects late ingestion', async () => {
  const query = vi.fn().mockResolvedValue([{ id: 'site' }]), insert = vi.fn();
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: query }) };
  const service = new ClickHouseService({ get: () => 'clickhouse' } as never, db as never);
  Object.assign(service, { client: { insert } });
  const rows = [{ site_id: 'site', tenant_id: 'tenant' }] as EventRow[];
  await service.insertEvents(rows);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ clickhouse_settings: { wait_for_async_insert: 1 } }));
  query.mockResolvedValue([]); insert.mockClear();
  await expect(service.insertEvents(rows)).rejects.toThrow('Site no longer accepts events');
  expect(insert).not.toHaveBeenCalled();
});
it('does not recreate a signed cache after the site disappears while rebuilding', async () => {
  const redis = { get: vi.fn(), set: vi.fn() };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
  const db = { site: { findUnique: vi.fn().mockResolvedValue({ status: 'active', tenant: { archivedAt: null } }) }, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) };
  const service = new SiteConfigService(db as never, redis as never, {} as never);
  expect(await service.get('site')).toBeNull(); expect(redis.set).not.toHaveBeenCalled();
});
