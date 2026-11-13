import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditService, writeAudit } from '../src/common/audit/audit.module';
import { AuditQuerySchema, auditRange } from '../src/common/audit/audit.query';
import { TeamService } from '../src/modules/team/team.service';
import { SitesService } from '../src/modules/sites/sites.service';
import { newId } from '../src/common/crypto/ids';

const admin = { userId: 'admin', tenantId: 'tenant', email: 'admin@example.com', role: 'admin' as const };
const former = { id: 'former', name: 'Former member', email: 'former@example.com' };
const current = { id: 'admin', name: 'Current admin', email: admin.email };
afterEach(() => { vi.useRealTimers(); });
function setup() {
  const prisma = {
    auditLog: {
      create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue({ id: 'cursor' }),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn(async ({ by }: { by: string[] }) => by[0] === 'action' ? [{ action: 'site.created' }] : [{ actorUserId: former.id }]),
    },
    userMembership: { findMany: vi.fn().mockResolvedValue([{ userId: current.id, user: current }]), findFirst: vi.fn().mockResolvedValue(null) },
    user: { findMany: vi.fn().mockResolvedValue([former]) },
    site: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { prisma, service: new AuditService(prisma as never) };
}
const row = (id: string, actorUserId: string | null = former.id) => ({ id, actorUserId, action: 'site.created', targetType: 'site', targetId: 'site', createdAt: new Date() });

describe('audit search and author permissions', () => {
  it('validates the four timeframes, sort direction and bounded filter values', () => {
    expect(AuditQuerySchema.parse({})).toEqual({ timeframe: '30d', order: 'desc' });
    for (const timeframe of ['7d', '30d', '6m', '1y']) expect(AuditQuerySchema.safeParse({ timeframe }).success).toBe(true);
    for (const query of [{ timeframe: 'all' }, { order: 'DROP TABLE' }, { cursor: '' }, { action: 'x'.repeat(101) }]) expect(AuditQuerySchema.safeParse(query).success).toBe(false);
  });
  it('includes today and uses rolling days/calendar months without month-end overflow', () => {
    const now = new Date('2026-08-31T14:30:00Z');
    expect(auditRange('7d', now).from.toISOString()).toBe('2026-08-24T14:30:00.000Z');
    expect(auditRange('6m', now).from.toISOString()).toBe('2026-02-28T14:30:00.000Z');
    expect(auditRange('1y', now).to).toEqual(now);
  });
  it('only administrators receive former author choices, scoped to workspace audit history', async () => {
    const { service, prisma } = setup();
    expect((await service.options(admin)).authors).toContainEqual({ ...former, former: true });
    expect(prisma.auditLog.groupBy).toHaveBeenCalledWith({ by: ['actorUserId'], where: { tenantId: admin.tenantId, actorUserId: { not: null } } });
    prisma.user.findMany.mockClear();
    expect((await service.options({ ...admin, role: 'viewer' })).authors).toEqual([{ ...current, former: false }]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
  it('redacts former identities for readers and rejects direct author-filter bypass', async () => {
    const { service, prisma } = setup();
    prisma.auditLog.findMany.mockResolvedValue([row('one')] as never);
    const query = AuditQuerySchema.parse({});
    const reader = { ...admin, role: 'editor' as const };
    const result = await service.list(reader, query);
    expect(result.items[0]!.actor).toEqual({ kind: 'restricted' });
    expect(JSON.stringify(result)).not.toContain(former.email);
    expect(JSON.stringify(result)).not.toContain('actorUserId');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    prisma.auditLog.findMany.mockClear();
    await expect(service.list(reader, { ...query, actorUserId: former.id })).rejects.toMatchObject({ status: 403 });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.userMembership.findFirst).toHaveBeenCalledWith({ where: { tenantId: admin.tenantId, userId: former.id }, select: { id: true } });
  });
  it('returns the historical author to administrators without raw metadata or hashes', async () => {
    const { service, prisma } = setup();
    prisma.auditLog.findMany.mockResolvedValue([row('one'), row('system', null)] as never);
    const result = await service.list(admin, AuditQuerySchema.parse({}));
    expect(result.items[0]!.actor).toEqual({ kind: 'user', ...former, former: true });
    expect(result.items[1]!.actor).toEqual({ kind: 'system' });
    const select = prisma.auditLog.findMany.mock.calls[0]![0].select;
    expect(select).not.toHaveProperty('metadata');
    expect(select).not.toHaveProperty('ipHash');
  });
  it('bounds every page, combines filters, and uses a stable date/id sort', async () => {
    const { service, prisma } = setup();
    prisma.auditLog.findMany.mockResolvedValue(Array.from({ length: 26 }, (_, i) => row(String(i), null)) as never);
    const result = await service.list(admin, AuditQuerySchema.parse({ timeframe: '7d', action: 'site.created', actorUserId: 'system', order: 'asc', cursor: 'cursor' }));
    expect(result.items).toHaveLength(25);
    expect(result.nextCursor).toBe('24');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: admin.tenantId, action: 'site.created', actorUserId: null, createdAt: { gte: expect.any(Date), lte: expect.any(Date) } }),
      take: 26, cursor: { id: 'cursor' }, skip: 1, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
    prisma.auditLog.findFirst.mockResolvedValue(null);
    await expect(service.list(admin, AuditQuerySchema.parse({ cursor: 'foreign' }))).rejects.toMatchObject({ status: 404 });
  });
  it('propagates audit persistence failures instead of confirming an unaudited mutation', async () => {
    const { prisma } = setup();
    prisma.auditLog.create.mockRejectedValue(new Error('storage unavailable'));
    await expect(writeAudit(prisma as never, { tenantId: admin.tenantId, actorUserId: admin.userId, action: 'site.created', targetType: 'site', targetId: 'site' })).rejects.toThrow('storage unavailable');
  });
});

it.skipIf(!process.env['AUDIT_TEST_DATABASE_URL'])('keeps real writes atomic with audit and preserves removed authors in an isolated PostgreSQL schema', async () => {
  const url = new URL(process.env['AUDIT_TEST_DATABASE_URL']!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('An isolated local database is required');
  const schema = `audit_test_${randomBytes(8).toString('hex')}`;
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' });
    const tenantId = newId(), adminId = newId(), formerId = newId();
    await db.tenant.create({ data: { id: tenantId, name: 'Local audit test', slug: schema } });
    await db.user.createMany({ data: [{ id: adminId, name: 'Admin', email: 'admin@audit.test', passwordHash: 'preserved-admin-hash' }, { id: formerId, name: 'Former', email: 'former@audit.test', passwordHash: 'preserved-former-hash' }] });
    await db.userMembership.createMany({ data: [{ id: newId(), tenantId, userId: adminId, role: 'admin' }, { id: newId(), tenantId, userId: formerId, role: 'editor' }] });
    const user = { tenantId, userId: adminId, email: 'admin@audit.test', role: 'admin' as const };
    const audit = new AuditService(db as never);
    const foreignTenant = newId(), foreignRecord = newId();
    await db.tenant.create({ data: { id: foreignTenant, name: 'Other tenant', slug: `${schema}-other` } });
    await audit.log({ tenantId: foreignTenant, actorUserId: adminId, action: 'site.created', targetType: 'site', targetId: foreignRecord });
    await audit.log({ tenantId, actorUserId: formerId, action: 'site.created', targetType: 'site', targetId: 'historic-site' });
    const team = new TeamService(db as never, { get: () => 'http://localhost:3110' } as never);
    const member = await db.userMembership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId, userId: formerId } } });
    await team.removeMember(user, member.id);
    expect(await db.user.findUnique({ where: { id: formerId } })).toHaveProperty('passwordHash', 'preserved-former-hash');
    expect((await audit.options(user)).authors).toContainEqual({ id: formerId, name: 'Former', email: 'former@audit.test', former: true });
    expect((await audit.options({ ...user, role: 'viewer' })).authors.some(author => author.id === formerId)).toBe(false);
    expect((await audit.list({ ...user, role: 'viewer' }, AuditQuerySchema.parse({ action: 'site.created' }))).items[0]!.actor).toEqual({ kind: 'restricted' });
    const removed = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: 'team.member_removed' } });
    expect(removed).toMatchObject({ actorUserId: adminId, targetId: formerId });
    expect((await audit.list(user, AuditQuerySchema.parse({}))).items.some(item => item.targetId === foreignRecord)).toBe(false);
    const foreignCursor = await db.auditLog.findFirstOrThrow({ where: { tenantId: foreignTenant } });
    await expect(audit.list(user, AuditQuerySchema.parse({ cursor: foreignCursor.id }))).rejects.toMatchObject({ status: 404 });
    expect(await db.teamInvitation.count({ where: { tenantId, email: 'former@audit.test' } })).toBe(0);
    await expect(team.invite(user, { name: 'Former', email: 'former@audit.test', role: 'editor' })).rejects.toMatchObject({ response: { errors: { reactivationAvailable: true } } });
    const restored = await team.reactivate(user, { email: 'former@audit.test', role: 'editor' });
    const invitation = await team.invite(user, { name: 'New', email: 'new@audit.test', role: 'viewer' });
    await team.revoke(user, invitation.id);
    await team.changeRole(user, restored.id, 'viewer');
    const sites = new SitesService(db as never, { generateSiteKeyPair: () => ({ publicKey: 'test-public', privateKeyEnc: Buffer.from('test-private') }) } as never, {} as never);
    await sites.create(user, { name: 'Audit site', primaryDomain: 'audit.test' });
    expect(await db.auditLog.count({ where: { tenantId, action: 'site.created', actorUserId: adminId } })).toBe(1);
    // Deny audit inserts to prove the account/site mutation rolls back as well.
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER deny_audit BEFORE INSERT ON "${schema}".audit_log FOR EACH ROW EXECUTE FUNCTION "${schema}".deny_audit()`);
    await expect(sites.create(user, { name: 'Must roll back', primaryDomain: 'rollback.test' })).rejects.toThrow();
    expect(await db.site.count()).toBe(1);
    await expect(team.removeMember(user, restored.id)).rejects.toThrow();
    expect(await db.userMembership.count({ where: { id: restored.id } })).toBe(1);
    await db.$executeRawUnsafe(`DROP TRIGGER deny_audit ON "${schema}".audit_log`);
    // Equal timestamps still paginate deterministically in either direction.
    const date = new Date();
    await db.auditLog.createMany({ data: Array.from({ length: 30 }, () => ({ id: newId(), tenantId, actorUserId: adminId, action: 'test.page', targetType: 'site', targetId: 'site', createdAt: date })) });
    for (const order of ['asc', 'desc'] as const) {
      const query = AuditQuerySchema.parse({ action: 'test.page', order });
      const first = await audit.list(user, query);
      const second = await audit.list(user, { ...query, cursor: first.nextCursor! });
      expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(30);
      expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull();
    }
  } finally {
    // The generated, test-owned schema is the only deletion target.
    if (!/^audit_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid test schema');
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}, 60000);
